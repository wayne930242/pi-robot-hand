/**
 * pi-robot-hand: the agent hands the user a command. After the user agrees, it lands in the pi
 * prompt (shell commands as `! command`), the clipboard, or a new Herdr pane. The user decides
 * whether to run it; the agent never does. A Herdr pane closes when its command finishes and the
 * output comes back as a message that starts the agent's next turn.
 */

import { tmpdir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Choice, dialogTitle, options, promptText, resultText, toOffer } from "./hand.ts";
import { checkRun, cleanup, type Exec, findShell, type HerdrRun, outcomeText, startRun } from "./herdr.ts";

interface HandDetails {
	command: string;
	status: "waiting" | Choice;
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

export function createRobotHand(copy: (text: string) => Promise<void> = copyToClipboard, env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()) {
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

		pi.on("session_shutdown", () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			runs.clear();
		});

		pi.registerTool({
			name: "robot_hand",
			label: "Robot Hand",
			description:
				"Hand the user a command to run themselves. The user sees the command and the reason, then puts it in their pi prompt (a shell command becomes `! command`, whose output returns to the conversation when they press Enter), copies it to the clipboard, sends it to a new Herdr pane (closed when it finishes, its output returning as a message), or declines. The tool returns the user's choice; it never runs the command.",
			promptSnippet: "Hand the user a command to run themselves, via their pi prompt, clipboard, or a Herdr pane",
			promptGuidelines: [
				"Use robot_hand when the user has to run a command themselves: pi slash commands such as /reload, interactive or sudo commands, commands a guard blocked, or anything they asked to run on their own.",
				"Pass one command per robot_hand call and write the reason in the user's language.",
				"Set robot_hand `default` to herdr-type for a command that needs terminal input (password, sudo, confirmation, ssh, a full-screen program); pi's `!` gives it no terminal.",
				"After robot_hand places, copies, or sends a command, nothing has run yet: wait for the user or the result message instead of assuming the result.",
			],
			parameters: Params,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

				onUpdate?.({ content: [{ type: "text", text: "Waiting for the user to take the command..." }], details: { command: text, status: "waiting" } });
				pi.events.emit("herdr:blocked", { active: true, label: "Waiting for the user to take a command" });
				let picked: string | undefined;
				try {
					picked = await ctx.ui.select(
						dialogTitle(offer, params.reason),
						choices.map((option) => option.label),
						{ signal },
					);
				} finally {
					pi.events.emit("herdr:blocked", { active: false });
				}
				const choice = choices.find((option) => option.label === picked)?.choice ?? "cancel";

				if (choice === "prompt") {
					ctx.ui.setEditorText(text);
					ctx.ui.notify("Review the command in your prompt and press Enter to run it.", "info");
				} else if (choice === "clipboard") {
					await copy(offer.command);
					ctx.ui.notify("Command copied to the clipboard.", "info");
				} else if ((choice === "herdr-type" || choice === "herdr-run") && piPane) {
					const run = await startRun(exec, { piPane, cwd: ctx.cwd, tmp, command: offer.command, type: choice === "herdr-type", shell: findShell(env.PATH) });
					runs.set(run.token, { run, ticks: 0, busy: false });
					timer ??= setInterval(watch, WATCH_MS);
				}
				return {
					content: [{ type: "text", text: resultText(choice, offer) }],
					details: { command: text, status: choice } satisfies HandDetails,
					// The next move is the user's; a follow-up from the agent would only talk over it.
					terminate: choice !== "cancel",
				};
			},

			renderCall(args, theme) {
				const head = `${theme.fg("toolTitle", theme.bold("robot_hand "))}${theme.fg("dim", args.reason ?? "")}`;
				const command = args.command ? (args.kind === "pi" ? args.command : `! ${args.command}`) : "";
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
				if (details.status === "prompt") return new Text(`${theme.fg("success", "✓ ")}In your prompt — press Enter to run it`, 0, 0);
				if (details.status === "clipboard") return new Text(`${theme.fg("success", "✓ ")}Copied to your clipboard`, 0, 0);
				if (details.status === "herdr-type") return new Text(`${theme.fg("success", "✓ ")}In a new Herdr pane — press Enter there to run it`, 0, 0);
				if (details.status === "herdr-run") return new Text(`${theme.fg("success", "✓ ")}Running in a new Herdr pane`, 0, 0);
				return new Text(theme.fg("warning", "Declined — nothing placed or run"), 0, 0);
			},
		});
	};
}

export default createRobotHand();
