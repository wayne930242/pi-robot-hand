/**
 * pi-robot-hand: the agent hands the user a command. After the user agrees, it lands in the pi
 * prompt (shell commands as `! command`), the clipboard, or a new Herdr pane. The user decides
 * whether to run it; the agent never does. A Herdr pane closes when its command finishes and the
 * output comes back as a message that starts the agent's next turn.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	afterUserMessage,
	type CheckInput,
	type CheckResult,
	checkSummary,
	failureNote,
	findScripts,
	jevClassifier,
	lastUserText,
	loadCheckModel,
	loadDialogTools,
	loadJevCheck,
	loadSecrets,
	modelRef,
	orderModels,
	redactInput,
	runCheck,
	runJevCheck,
	saveCheckModel,
	settingsPath,
	type Unread,
	type Verdict,
} from "./check.ts";
import { openDialog } from "./dialog.ts";
import { busChoices, type Choice, dialogTitle, type Offer, options, promptText, resultText, toOffer } from "./hand.ts";
import { HandSelect, type Picked } from "./hand-select.ts";
import { printable } from "./printable.ts";
import { redactThrough } from "./secret-drop/redact.ts";
import { dialogOptions } from "./secret-drop/secret-input.ts";
import { checkRun, cleanup, type Exec, findShell, type HerdrRun, outcomeText, startRun } from "./herdr.ts";

interface HandDetails {
	command: string;
	status: "waiting" | Choice;
	/** Present when another extension answered the selector. */
	answeredFrom?: "browser";
	/** Present when the user ran the `e` check before choosing. */
	check?: { model: string; verdict: Verdict };
	/** Present when the automatic Jev check finished before the user chose. */
	jev?: { model: string; verdict: Verdict };
	/** How many things the selector listed as run but not read by the checks; present when it listed any. */
	unread?: number;
}

export const HERDR_RESULT_TYPE = "robot-hand-herdr";
export const WATCH_MS = 500;
// Every this many watch ticks, also check that the pane still exists.
const PANE_CHECK_EVERY = 6;

const Params = Type.Object({
	command: Type.String({
		description: "The command to hand over. kind=shell: a shell command without a leading `!`. kind=pi: a pi slash command such as `/reload`.",
	}),
	reason: Type.String({ description: "One short line telling the user why they should run it, in the user's language." }),
	kind: Type.Optional(
		StringEnum(["shell", "pi"] as const, {
			description:
				"shell: goes to the prompt as `! command` (output returns to the conversation), the clipboard, or a new Herdr pane. pi: a pi slash command, placed in the prompt as-is. Default shell.",
		}),
	),
	default: Type.Optional(
		StringEnum(["prompt", "clipboard", "herdr-type", "herdr-run"] as const, {
			description:
				"The option the selector starts on. prompt (default): pi's `!`, which has no terminal for input. For interactive commands (password or sudo prompts, confirmations, ssh, full-screen programs) use herdr-type, which opens a real terminal pane; outside Herdr it falls back to clipboard, then prompt. herdr-run starts the command in the pane at once.",
		}),
	),
});

/** What the check reads, gathered once per hand-over on the first `e`. */
async function checkInput(offer: Offer, reason: string, ctx: ExtensionContext, agentDir: string, events: ExtensionAPI["events"]): Promise<CheckInput> {
	const dialogTools = loadDialogTools(settingsPath(agentDir));
	const secrets = await loadSecrets(join(agentDir, "secret-drop"), (text) => redactThrough(events, text));
	const { scripts, unread } = offer.kind === "shell" ? await findScripts(offer.command, ctx.cwd, secrets.isSecret, secrets.redact) : { scripts: [], unread: [] };
	const branch = ctx.sessionManager.getBranch();
	const after = afterUserMessage(branch, secrets.redact, dialogTools);
	return redactInput(
		{ command: offer.command, kind: offer.kind, reason, userMessage: lastUserText(branch, secrets.redact), replies: after.replies, since: after.log, scripts, unread },
		secrets.redact,
	);
}

/**
 * One line for the agent: what the selector told the user the checks could not read. Targets, and the names a
 * detail quotes, are untrusted: each is JSON-escaped, so no line break or quote in a file name reaches the agent raw.
 */
function unreadSummary(unread: readonly Unread[]): string {
	const items = unread.map((item) => `${item.kind} ${JSON.stringify(item.target)} (${JSON.stringify(item.detail).slice(1, -1)})`).join("; ");
	return `The selector told the user the checks could not read all of what the command runs: ${items}.`;
}

export function createRobotHand(
	copy: (text: string) => Promise<void> = copyToClipboard,
	env: NodeJS.ProcessEnv = process.env,
	tmp: string = tmpdir(),
	agentDir: string = getAgentDir(),
) {
	return function robotHand(pi: ExtensionAPI) {
		const exec: Exec = async (args) => {
			const result = await pi.exec(env.HERDR_BIN_PATH || "herdr", args);
			return { stdout: result.stdout, code: result.code };
		};
		const runs = new Map<string, { run: HerdrRun; ticks: number; busy: boolean }>();
		let timer: ReturnType<typeof setInterval> | undefined;

		const watch = (): void => {
			for (const entry of runs.values()) {
				if (entry.busy) continue;
				entry.busy = true;
				entry.ticks++;
				const report = (content: string): void => {
					pi.sendMessage({ customType: HERDR_RESULT_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				};
				checkRun(exec, entry.run, entry.ticks % PANE_CHECK_EVERY === 0)
					.then(async (outcome) => {
						if (!outcome) return;
						runs.delete(entry.run.token);
						await cleanup(entry.run);
						report(outcomeText(outcome, entry.run.command));
					})
					.catch((error: unknown) => {
						runs.delete(entry.run.token);
						report(
							`robot_hand lost track of the Herdr pane ${entry.run.paneId} running \`${entry.run.command}\`: ${(error as Error).message}. Its result is unknown; ask the user.`,
						);
					})
					.finally(() => {
						entry.busy = false;
						if (runs.size === 0 && timer) {
							clearInterval(timer);
							timer = undefined;
						}
					});
			}
		};

		// Providers whose check failed in this session, with the note the picker shows.
		const failedProviders = new Map<string, string>();

		pi.on("session_shutdown", () => {
			failedProviders.clear();
			if (timer) clearInterval(timer);
			timer = undefined;
			runs.clear();
		});

		// The terminal selector with the `e` check and the automatic Jev check. Resolves with the picked index,
		// `refuse`, or undefined for Esc or abort, and the last finished checks.
		const pickInTerminal = async (
			title: string,
			labels: string[],
			offer: Offer,
			reason: string,
			ctx: ExtensionContext,
			signal: AbortSignal,
		): Promise<{ picked: Picked; check?: CheckResult; jev?: CheckResult; unread?: Unread[] }> => {
			const settings = settingsPath(agentDir);
			let saved = loadCheckModel(settings);
			let input: Promise<CheckInput> | undefined;
			// Both checks read the same input, gathered once; a failed gathering is retried by the next check.
			const gather = async (): Promise<CheckInput> => {
				input ??= checkInput(offer, reason, ctx, agentDir, pi.events);
				return input.catch((error: unknown) => {
					input = undefined;
					throw error;
				});
			};
			const classify = loadJevCheck(settings) ? jevClassifier(ctx.modelRegistry) : undefined;
			let select: HandSelect | undefined;
			try {
				const picked = await ctx.ui.custom<Picked>((tui, theme, _keybindings, done) => {
					select = new HandSelect(
						{
							title,
							labels,
							models: () => orderModels(ctx.modelRegistry.getAvailable().map(modelRef), ctx.model?.provider, failedProviders),
							note: (ref) => failedProviders.get(ref.slice(0, ref.indexOf("/"))),
							saved: () => saved,
							pick: (model) => {
								saved = model;
								saveCheckModel(settings, model).catch((error: unknown) => ctx.ui.notify(`robot_hand could not save the check model: ${(error as Error).message}`, "warning"));
							},
							check: async (ref, signal) => {
								const model = ctx.modelRegistry.getAvailable().find((candidate) => modelRef(candidate) === ref);
								if (!model) throw new Error("it is no longer signed in");
								const gathered = await gather();
								try {
									const result = await runCheck((m, context, options) => ctx.modelRegistry.complete(m, context, options), model, gathered, signal);
									failedProviders.delete(model.provider);
									return result;
								} catch (error) {
									if (!signal.aborted) failedProviders.set(model.provider, failureNote((error as Error).message));
									throw error;
								}
							},
							// The scan reads local files only and sends nothing, so it runs as the selector opens.
							...(offer.kind === "shell" ? { unread: gather().then((gathered) => gathered.unread ?? []) } : {}),
							...(classify
								? {
										jev: async (signal: AbortSignal) => {
											const gathered = await gather();
											// The user may have chosen while the input was gathered; send nothing then.
											signal.throwIfAborted();
											return runJevCheck(classify, gathered, signal);
										},
									}
								: {}),
						},
						theme,
						() => tui.requestRender(),
						done,
					);
					if (signal.aborted) select.cancel();
					else signal.addEventListener("abort", () => select?.cancel(), { once: true });
					return select;
				}, dialogOptions());
				return { picked, check: select?.result, jev: select?.jevResult, unread: select?.unreadResult };
			} finally {
				select?.cancel();
			}
		};

		pi.registerTool({
			name: "robot_hand",
			label: "Robot Hand",
			description:
				"Hand the user a command to run themselves. The user sees the command and the reason, then puts it in their pi prompt (a shell command becomes `! command`, whose output returns to the conversation when they press Enter), copies it to the clipboard, sends it to a new Herdr pane (closed when it finishes, its output returning as a message), or declines. In the terminal the user can first have another model check the command against your reason, and Jev (TypeSafe) checks it automatically when configured; the result then includes each verdict, and after a mismatch the user can decline with that as the reason. The tool returns the user's choice; it never runs the command.",
			promptSnippet: "Hand the user a command to run themselves, via their pi prompt, clipboard, or a Herdr pane",
			promptGuidelines: [
				"Use robot_hand when the user has to run a command themselves: pi slash commands such as /reload, interactive or sudo commands, commands a guard blocked, or anything they asked to run on their own.",
				"Pass one command per robot_hand call and write the reason in the user's language.",
				"Make the robot_hand reason say what the command does and what it is for: the user can press e to have another model check the command and the scripts it runs against that reason.",
				"Set robot_hand `default` to herdr-type for a command that needs terminal input (password, sudo, confirmation, ssh, a full-screen program); pi's `!` gives it no terminal.",
				"After robot_hand places, copies, or sends a command, nothing has run yet: wait for the user or the result message instead of assuming the result.",
				"After the user refuses a robot_hand command as a mismatch, either change the command or hand it again with a reason that states all it does, as the result says; never reword the reason only to pass the check.",
			],
			parameters: Params,
			executionMode: "sequential",

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (!ctx.hasUI) {
					throw new Error("robot_hand needs an interactive pi UI; show the command to the user in chat instead.");
				}
				const offer = toOffer(params.command, params.kind);
				const text = promptText(offer);
				const piPane = env.HERDR_PANE_ID;
				const reach = {
					hasDraft: ctx.ui.getEditorText().trim().length > 0,
					canCopy: ctx.mode === "tui",
					inHerdr: ctx.mode === "tui" && Boolean(piPane),
				};
				const choices = options(offer, reach, params.default);

				const title = dialogTitle(offer, params.reason);
				const dialog = openDialog(pi.events, { toolCallId, title, choices: busChoices(choices), copy: offer.command, signal });
				try {
					onUpdate?.({ content: [{ type: "text", text: "Waiting for the user to take the command..." }], details: { command: text, status: "waiting" } });
					pi.events.emit("herdr:blocked", { active: true, label: "Waiting for the user to take a command" });
					let won: number | undefined;
					let refused = false;
					let checked: CheckResult | undefined;
					let jevChecked: CheckResult | undefined;
					let unread: Unread[] | undefined;
					try {
						const labels = choices.map((option) => option.label);
						let at: number | undefined;
						if (dialog.open && ctx.mode === "tui") {
							const picked = await pickInTerminal(title, labels, offer, params.reason, ctx, dialog.signal);
							at = typeof picked.picked === "number" ? picked.picked : undefined;
							refused = picked.picked === "refuse";
							checked = picked.check;
							jevChecked = picked.jev;
							unread = picked.unread;
						} else if (dialog.open) {
							const picked = await ctx.ui.select(title, labels, { signal: dialog.signal });
							const found = labels.indexOf(picked ?? "");
							at = found < 0 ? undefined : found;
						}
						// Settle right after the selector resolves, before anything else can run.
						won = dialog.finish(at);
					} finally {
						pi.events.emit("herdr:blocked", { active: false });
					}
					// Refusing settles the published dialog as a cancel: other answerers never see that choice.
					const choice = (won === undefined ? undefined : choices[won]?.choice) ?? (refused && !dialog.remote ? "refuse" : "cancel");

					if (choice === "prompt") {
						ctx.ui.setEditorText(text);
						ctx.ui.notify("Review the command in your prompt and press Enter to run it.", "info");
					} else if (choice === "clipboard") {
						await copy(offer.command);
						ctx.ui.notify("Command copied to the clipboard.", "info");
					} else if ((choice === "herdr-type" || choice === "herdr-run") && piPane) {
						const run = await startRun(exec, { piPane, cwd: ctx.cwd, tmp, command: offer.command, type: choice === "herdr-type", shell: findShell(env.PATH), answerId: dialog.answerId });
						runs.set(run.token, { run, ticks: 0, busy: false });
						timer ??= setInterval(watch, WATCH_MS);
					}
					const summary = [jevChecked, checked].map((result) => (result ? `\n\n${checkSummary(result)}` : "")).join("") + (unread?.length ? `\n\n${unreadSummary(unread)}` : "");
					return {
						content: [{ type: "text", text: `${resultText(choice, offer)}${summary}` }],
						details: {
							command: text,
							status: choice,
							...(dialog.remote ? { answeredFrom: "browser" } : {}),
							...(checked ? { check: { model: checked.model, verdict: checked.verdict } } : {}),
							...(jevChecked ? { jev: { model: jevChecked.model, verdict: jevChecked.verdict } } : {}),
							...(unread?.length ? { unread: unread.length } : {}),
						} satisfies HandDetails,
						// The next move is the user's; a follow-up from the agent would only talk over it. After a decline or
						// refusal the agent answers.
						terminate: choice !== "cancel" && choice !== "refuse",
					};
				} finally {
					dialog.dispose();
				}
			},

			renderCall(args, theme) {
				const head = `${theme.fg("toolTitle", theme.bold("robot_hand "))}${theme.fg("dim", printable(args.reason ?? "", true))}`;
				const command = printable(args.command ? (args.kind === "pi" ? args.command : `! ${args.command}`) : "");
				const lines = command.split("\n").map((line: string) => `  ${theme.fg("accent", line)}`);
				return new Text([head, ...lines].join("\n"), 0, 0);
			},

			renderResult(result, _options, theme) {
				const details = result.details as HandDetails | undefined;
				if (!details || typeof details.status !== "string") {
					const first = result.content[0];
					return new Text(first?.type === "text" ? first.text : "", 0, 0);
				}
				if (details.status === "waiting") return new Text(theme.fg("dim", "Waiting for you to take the command"), 0, 0);
				const checks = [details.jev, details.check].filter((check) => check !== undefined);
				const checked =
					checks.map((check) => theme.fg("dim", ` · checked by ${check.model}: ${check.verdict}`)).join("") +
					(details.unread ? theme.fg("warning", ` · ${details.unread} not read by the checks`) : "");
				if (details.status === "prompt") return new Text(`${theme.fg("success", "✓ ")}In your prompt — press Enter to run it${checked}`, 0, 0);
				if (details.status === "clipboard") return new Text(`${theme.fg("success", "✓ ")}Copied to your clipboard${checked}`, 0, 0);
				if (details.status === "herdr-type") return new Text(`${theme.fg("success", "✓ ")}In a new Herdr pane — press Enter there to run it${checked}`, 0, 0);
				if (details.status === "herdr-run") return new Text(`${theme.fg("success", "✓ ")}Running in a new Herdr pane${checked}`, 0, 0);
				if (details.status === "refuse") return new Text(`${theme.fg("warning", "Declined as a mismatch — nothing placed or run")}${checked}`, 0, 0);
				return new Text(`${theme.fg("warning", "Declined — nothing placed or run")}${checked}`, 0, 0);
			},
		});
	};
}

export default createRobotHand();
