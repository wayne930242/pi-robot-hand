/**
 * pi-secret-drop: the user types a secret into a masked dialog, the extension stages it outside
 * the project, and pre-fills a `!` command that the user runs to apply it. The model only sees
 * where the secret went and the apply script's length check.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { access } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { checkOverwrite, checkValue, describePlacement, extractSecret, type Placement, validateSyntax } from "../../lib/placement.ts";
import { parseFileMode, readExisting } from "../../lib/write.ts";
import { canonicalPath, checkToolCall } from "./guard.ts";
import { findLegacySecretDrop, legacyNotice } from "./legacy.ts";
import { Redactor } from "./redact.ts";
import { Registry } from "./registry.ts";
import { type DialogResult, dialogOptions, SecretInput } from "./secret-input.ts";
import {
	type ApplyPlan,
	buildApplyCommand,
	clearStale,
	discardStaged,
	displayPath,
	newStagedPath,
	stageSecret,
	waitForResult,
} from "./stage.ts";

const APPLY_SCRIPT = fileURLToPath(new URL("../../dist/apply.js", import.meta.url));

interface DropDetails {
	target: string;
	command: string;
	status: "entering" | "staged" | "cancelled" | "question" | "applied";
	message?: string;
}

const Params = Type.Object({
	label: Type.String({ description: "What the user should enter, e.g. 'Azure SP client secret for ginlee'. In the user's language." }),
	instructions: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 10,
		description:
			"Numbered steps shown above the input, in the user's language, so they can get the value without asking: where to go (exact URL or menu path), what to click and fill in (name, scope, permissions, expiration), and what to copy. For a value the user already knows, one step saying which one to type.",
	}),
	url: Type.Optional(Type.String({ description: "The page where the user creates or finds the secret, shown as a link." })),
	format: Type.Optional(
		StringEnum(["env", "regex", "file", "command"] as const, {
			description:
				"env: set KEY=value in `destination` (replaces existing KEY lines or appends). regex: replace capture group 1 (or the whole match) of `regex` in an existing `destination`. file: the whole `destination` is the secret. command: run `command` with {secret} replaced by the staged file path. Default: env when `key` is set, command when `command` is set, otherwise file.",
		}),
	),
	destination: Type.Optional(
		Type.String({
			description:
				"env/regex/file: file the secret goes into. Relative to the working directory; ~ expands. This tool never opens it; the user's apply command writes it.",
		}),
	),
	key: Type.Optional(Type.String({ description: "env: variable name." })),
	quote: Type.Optional(StringEnum(["auto", "none", "single", "double"] as const, { description: "env: value quoting. Default auto." })),
	regex: Type.Optional(Type.String({ description: "regex: JavaScript regex locating the secret slot." })),
	flags: Type.Optional(Type.String({ description: "regex: flags such as 'm' or 'g'." })),
	fileMode: Type.Optional(
		Type.String({ description: "env/regex/file: octal permissions such as '600'. Default: 600 for new files, unchanged otherwise." }),
	),
	overwrite: Type.Optional(
		Type.Boolean({
			description:
				"file: allow replacing an existing destination. Use only for single-value files such as keys or password files; change one value in a multi-value file with env or regex.",
		}),
	),
	command: Type.Optional(
		Type.String({
			description:
				"command: shell command that consumes the secret from the file {secret}, e.g. `ansible-vault encrypt_string --stdin-name db_password < {secret} >> vault.yml`. Its stdout is discarded; redirect results into files.",
		}),
	),
});

interface DropParams {
	format?: "env" | "regex" | "file" | "command";
	destination?: string;
	key?: string;
	quote?: "auto" | "none" | "single" | "double";
	regex?: string;
	flags?: string;
	fileMode?: string;
	overwrite?: boolean;
	command?: string;
}

/** What the tool returns when the user asked a question instead of entering the secret. */
export function questionResult(text: string): string {
	return `The user did not enter the secret and asked instead: "${text}". Nothing was staged. Answer the question in chat, then call secret_drop again when they are ready.`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function buildPlan(params: DropParams, cwd: string): Promise<ApplyPlan> {
	const format = params.format ?? (params.key ? "env" : params.command ? "command" : "file");
	if (format === "command") {
		if (!params.command) throw new Error("format=command requires `command`.");
		if (!params.command.includes("{secret}")) throw new Error("`command` must reference {secret}, the staged file path.");
		return { format: "exec", command: params.command };
	}
	if (!params.destination) throw new Error(`format=${format} requires \`destination\`.`);
	let placement: Placement;
	if (format === "env") {
		if (!params.key) throw new Error("format=env requires `key`.");
		placement = { mode: "env", key: params.key, quote: params.quote ?? "auto" };
	} else if (format === "regex") {
		if (!params.regex) throw new Error("format=regex requires `regex`.");
		placement = { mode: "regex", pattern: params.regex, flags: params.flags ?? "" };
	} else {
		placement = { mode: "file" };
	}
	validateSyntax(placement);
	parseFileMode(params.fileMode);
	const destination = canonicalPath(params.destination, cwd);
	const overwrite = params.overwrite === true;
	const refused = checkOverwrite(placement, await exists(destination), overwrite);
	if (refused) throw new Error(refused);
	return { format: "placement", destination, placement, fileMode: params.fileMode, overwrite };
}

export default function secretDrop(pi: ExtensionAPI) {
	const legacy = findLegacySecretDrop(getAgentDir(), process.cwd());
	if (legacy) {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(legacyNotice(legacy), "warning");
		});
		return;
	}
	const home = join(getAgentDir(), "secret-drop");
	const stagingDir = join(home, "staging");
	const registry = new Registry(join(home, "registry.json"));
	const redactor = new Redactor();

	const isProtected = (path: string): boolean => {
		const staging = canonicalPath(stagingDir, "/");
		return path === staging || path.startsWith(`${staging}${sep}`) || registry.paths().has(path);
	};

	async function reloadSecrets(): Promise<void> {
		await registry.load();
		for (const entry of registry.list()) {
			const content = await readExisting(entry.path).catch(() => undefined);
			if (content === undefined) continue;
			const secret = extractSecret(content, entry.placement);
			if (secret) redactor.add(secret);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await clearStale(stagingDir);
			await reloadSecrets();
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`secret-drop: ${(error as Error).message}`, "error");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const reason = checkToolCall(event.toolName, event.input, ctx.cwd, isProtected);
		if (!reason) return undefined;
		if (ctx.hasUI) ctx.ui.notify("secret-drop blocked a tool call that touches a secret file", "warning");
		return { block: true, reason };
	});

	pi.on("tool_result", async (event) => {
		const content = redactor.redactDeep(event.content);
		return content === event.content ? undefined : { content };
	});

	pi.on("context", async (event) => {
		const messages = redactor.redactDeep(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	pi.registerTool({
		name: "secret_drop",
		label: "Secret Drop",
		description:
			"Have the user enter a secret without it entering the conversation. The user follows the instructions you give and types it into a masked dialog, or presses Tab to ask you a question instead, which the tool returns; it is staged outside the project, and a `!` apply command is pre-filled in the user's prompt. The tool waits until the user runs that command, then returns the apply script's report: what changed and a length check, never the value. Destinations are protected afterwards: reading or printing them is blocked and the value is redacted from tool output.",
		promptSnippet: "Have the user put a secret into a file or command without the agent seeing it",
		promptGuidelines: [
			"Use secret_drop whenever a password, token, key, or other credential must land in a file or be fed to a command; never ask the user to paste secrets into chat.",
			"Files that hold secrets are consumed by programs, never read or printed by the agent.",
			"Give secret_drop instructions the user can follow without asking: the exact page or menu, every field to fill in, and what to copy; write them and the label in the user's language.",
			"When secret_drop returns a question from the user, answer it, then call secret_drop again.",
		],
		parameters: Params,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error("secret_drop needs the interactive terminal UI; ask the user to write the secret themselves.");
			}
			const plan = await buildPlan(params, ctx.cwd);
			const replacesFile =
				plan.format === "placement" && plan.placement.mode === "file" && plan.overwrite === true && (await exists(plan.destination));
			const staged = newStagedPath(stagingDir);
			const command = `! ${buildApplyCommand(APPLY_SCRIPT, staged, plan, ctx.cwd)}`;
			const target =
				plan.format === "exec" ? "command" : `${displayPath(plan.destination, ctx.cwd)} (${describePlacement(plan.placement)})`;
			const details: DropDetails = { target, command, status: "entering" };
			const next =
				"Enter here stages the value. Your prompt then holds a ! command; press Enter on it to apply. The agent never sees the value.";
			const check = (candidate: string): string | undefined =>
				plan.format === "exec" ? (candidate.length === 0 ? "Value is empty." : undefined) : checkValue(plan.placement, candidate);

			onUpdate?.({ content: [{ type: "text", text: "Waiting for the user to enter the secret..." }], details });
			pi.events.emit("herdr:blocked", { active: true, label: "Waiting for secret input" });
			let draft: string | undefined;
			try {
				const choice = await ctx.ui.custom<DialogResult | null>(
					(tui, theme, _keybindings, done) => {
						const input = new SecretInput(
							{
								title: "Secret Drop",
								label: params.label,
								steps: params.instructions,
								url: params.url,
								rows: [
									["Goes to", plan.format === "exec" ? `the command ${params.command}` : target],
									["Next", next],
								],
								warning: replacesFile ? "Replaces the entire existing file" : undefined,
								footer: "Stuck or unsure? Press Tab and ask; the dialog closes and the agent answers.",
								check,
							},
							theme,
							() => tui.requestRender(),
							done,
						);
						if (signal?.aborted) input.cancel();
						else signal?.addEventListener("abort", () => input.cancel(), { once: true });
						return input;
					},
					dialogOptions(),
				);
				if (choice === null || choice === undefined) {
					return {
						content: [{ type: "text", text: "User cancelled; nothing was staged or applied." }],
						details: { ...details, status: "cancelled" },
					};
				}
				if (choice.kind === "question") {
					return {
						content: [{ type: "text", text: questionResult(choice.text) }],
						details: { ...details, status: "question", message: choice.text },
					};
				}
				const value = choice.value;

				redactor.add(value);
				await stageSecret(staged, value, stagingDir);
				draft = ctx.ui.getEditorText();
				ctx.ui.setEditorText(command);
				ctx.ui.notify("Secret staged. Review the prefilled ! command and press Enter to apply it.", "info");
				onUpdate?.({
					content: [{ type: "text", text: "Secret staged; waiting for the user to run the prefilled ! command..." }],
					details: { ...details, status: "staged" },
				});

				const result = await waitForResult(staged, signal);
				if (result === null) {
					return {
						content: [{ type: "text", text: "Aborted before the user applied the secret; the staged value was discarded." }],
						details: { ...details, status: "cancelled" },
					};
				}
				if (!result.ok) {
					throw new Error(`Apply failed: ${result.message}. The staged value was discarded; call secret_drop again to retry.`);
				}
				if (plan.format === "placement") {
					await registry.upsert({
						path: plan.destination,
						placement: plan.placement,
						label: params.label,
						updatedAt: new Date().toISOString(),
					});
				}
				const protection = plan.format === "placement" ? " The destination is now protected; programs consume it, the agent does not read it." : "";
				return {
					content: [{ type: "text", text: `Applied: ${result.message}.${protection}` }],
					details: { ...details, status: "applied", message: result.message },
				};
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
				await discardStaged(staged);
				if (draft !== undefined && ctx.ui.getEditorText() === command) ctx.ui.setEditorText(draft);
			}
		},

		renderCall(args, theme) {
			const where = args.destination ?? args.command ?? "";
			const head = `${theme.fg("toolTitle", theme.bold("secret_drop "))}${theme.fg("muted", where)} ${theme.fg("dim", args.label)}`;
			// The steps stay readable here when the dialog has to shorten them.
			const steps = (args.instructions ?? []).map((step, i) => `  ${theme.fg("accent", `${i + 1}.`)} ${step}`);
			const url = args.url ? [`  ${theme.fg("muted", "Open")} ${theme.fg("accent", args.url)}`] : [];
			return new Text([head, ...steps, ...url].join("\n"), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as DropDetails | undefined;
			if (!details || typeof details.status !== "string") {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "entering") return new Text(theme.fg("dim", `Waiting for secret input → ${details.target}`), 0, 0);
			if (details.status === "staged") return new Text(theme.fg("dim", `Staged — press Enter on: ${details.command}`), 0, 0);
			if (details.status === "cancelled") return new Text(theme.fg("warning", "Cancelled — nothing applied"), 0, 0);
			if (details.status === "question") return new Text(theme.fg("warning", `Asked instead — nothing applied: ${details.message ?? ""}`), 0, 0);
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("text", details.message ?? details.target)}`, 0, 0);
		},
	});

	pi.registerCommand("secret-drop", {
		description: "List protected secret files, or `forget <path>` to stop protecting one",
		handler: async (args, ctx) => {
			await reloadSecrets();
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "forget") {
				const target = rest.join(" ");
				if (!target) {
					ctx.ui.notify("Usage: /secret-drop forget <path>", "warning");
					return;
				}
				const removed = await registry.forget(canonicalPath(target, ctx.cwd));
				redactor.clear();
				await reloadSecrets();
				ctx.ui.notify(removed > 0 ? `No longer protecting ${target}` : `${target} is not protected`, "info");
				return;
			}
			const entries = registry.list();
			if (entries.length === 0) {
				ctx.ui.notify("No protected secret files", "info");
				return;
			}
			const lines = entries.map((entry) => `${entry.path} — ${describePlacement(entry.placement)} (${entry.label})`);
			ctx.ui.notify(`Protected secret files:\n${lines.join("\n")}`, "info");
		},
	});
}
