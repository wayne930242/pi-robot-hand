/**
 * Herdr hand-over: open a pane below pi, run a small wrapper script there that shows the command
 * (editable before Enter, or started at once), and record its exit code. A watcher then reads the
 * command's output from the pane, closes the pane, and reports back. The command keeps the pane's
 * real terminal, so password prompts and full-screen programs work.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { shellQuote } from "../lib/shell.ts";

export type Exec = (args: string[]) => Promise<{ stdout: string; code: number }>;

export interface HerdrRun {
	token: string;
	dir: string;
	paneId: string;
	command: string;
}

export type Outcome =
	| { kind: "finished"; ran: string; exitCode: number; output: string }
	| { kind: "cancelled" }
	| { kind: "closed" };

export const MAX_OUTPUT_LINES = 200;
export const MAX_OUTPUT_CHARS = 16_000;

export const startMarker = (token: string) => `── robot-hand ${token} ──`;
export const endMarker = (token: string) => `── robot-hand ${token} done ──`;

/** zsh when installed (its vared edits a prefilled line), otherwise bash 4+ (read -e -i). */
export function findShell(path = process.env.PATH ?? ""): "zsh" | "bash" {
	const has = (name: string) => path.split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
	return has("zsh") ? "zsh" : "bash";
}

/**
 * The wrapper the pane runs. Ctrl+C while the line is shown cancels; during the command it stops
 * the command as usual and the script records 130. The script writes the status file last, via a
 * rename, so the watcher never reads it half-written.
 */
export function wrapperScript(shell: "zsh" | "bash", dir: string, token: string, type: boolean): string {
	const q = (name: string) => shellQuote(join(dir, name));
	const done = (value: string) => `printf '%s\\n' ${value} > ${q("status.tmp")} && mv ${q("status.tmp")} ${q("status")}`;
	const edit = shell === "zsh" ? `vared -p '$ ' cmd` : `read -r -e -i "$cmd" -p '$ ' cmd`;
	return [
		`cmd=$(cat ${q("command")})`,
		`trap '${done("cancelled").replace(/'/g, `'\\''`)}; exit 130' INT`,
		...(type ? [edit] : []),
		`printf '%s\\n' "$cmd" > ${q("ran")}`,
		`trap : INT`,
		`printf '%s\\n' ${shellQuote(startMarker(token))}`,
		// A subshell, so an `exit` in the command ends only the command.
		`(eval "$cmd")`,
		`code=$?`,
		`printf '%s\\n' ${shellQuote(endMarker(token))}`,
		done(`"$code"`),
		"",
	].join("\n");
}

/** The command's output between the run's markers, trimmed to what the model needs. */
export function sliceOutput(screen: string, token: string): string {
	const lines = screen.split("\n");
	const start = lines.findLastIndex((line) => line.trim() === startMarker(token));
	const end = lines.findLastIndex((line) => line.trim() === endMarker(token));
	let body = start === -1 ? lines : lines.slice(start + 1, end > start ? end : undefined);
	while (body.length > 0 && body[body.length - 1]?.trim() === "") body = body.slice(0, -1);
	let text = body.slice(-MAX_OUTPUT_LINES).join("\n");
	if (text.length > MAX_OUTPUT_CHARS) text = text.slice(-MAX_OUTPUT_CHARS);
	const cut = body.length > MAX_OUTPUT_LINES || body.join("\n").length > MAX_OUTPUT_CHARS;
	return cut ? `[earlier output omitted]\n${text}` : text;
}

/** Opens the pane below pi, focuses it, and starts the wrapper. */
export async function startRun(exec: Exec, opts: { piPane: string; cwd: string; tmp: string; command: string; type: boolean; shell: "zsh" | "bash" }): Promise<HerdrRun> {
	const token = randomBytes(4).toString("hex");
	const dir = join(opts.tmp, "pi-robot-hand", token);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(join(dir, "command"), opts.command, { mode: 0o600 });
	const script = join(dir, `run.${opts.shell}`);
	await writeFile(script, wrapperScript(opts.shell, dir, token, opts.type), { mode: 0o600 });
	await chmod(dir, 0o700);

	const split = await exec(["pane", "split", "--pane", opts.piPane, "--direction", "down", "--ratio", "0.4", "--cwd", opts.cwd]);
	const paneId = parsePaneId(split.stdout);
	if (split.code !== 0 || !paneId) {
		await rm(dir, { recursive: true, force: true });
		throw new Error(`herdr could not open a pane: ${split.stdout.trim() || `exit ${split.code}`}`);
	}
	await exec(["pane", "focus", "--pane", opts.piPane, "--direction", "down"]);
	const run = await exec(["pane", "run", paneId, `${opts.shell} ${shellQuote(script)}`]);
	if (run.code !== 0) {
		await exec(["pane", "close", paneId]);
		await rm(dir, { recursive: true, force: true });
		throw new Error(`herdr could not start the command in pane ${paneId}: exit ${run.code}`);
	}
	return { token, dir, paneId, command: opts.command };
}

function parsePaneId(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
		const id = parsed.result?.pane?.pane_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One watcher step: undefined while the command is still going, otherwise the outcome. A finished
 * run has its output read and its pane closed; a pane the user closed first reports `closed`.
 */
export async function checkRun(exec: Exec, run: HerdrRun, checkPane: boolean): Promise<Outcome | undefined> {
	const status = await readFile(join(run.dir, "status"), "utf8").catch(() => undefined);
	if (status === undefined) {
		if (!checkPane) return undefined;
		const pane = await exec(["pane", "get", run.paneId]);
		return pane.code === 0 ? undefined : { kind: "closed" };
	}
	const value = status.trim();
	if (value === "cancelled") {
		await exec(["pane", "close", run.paneId]);
		return { kind: "cancelled" };
	}
	const ran = (await readFile(join(run.dir, "ran"), "utf8").catch(() => run.command)).trim();
	const screen = await exec(["pane", "read", run.paneId, "--source", "recent-unwrapped", "--lines", "2000"]);
	await exec(["pane", "close", run.paneId]);
	return { kind: "finished", ran, exitCode: Number(value), output: screen.code === 0 ? sliceOutput(screen.stdout, run.token) : "[output unavailable]" };
}

export async function cleanup(run: HerdrRun): Promise<void> {
	await rm(run.dir, { recursive: true, force: true });
}

/** The message that brings the agent back once the pane is done. */
export function outcomeText(outcome: Outcome, command: string): string {
	if (outcome.kind === "cancelled") {
		return `The user cancelled \`${command}\` in the Herdr pane before running it; nothing ran. Ask how they want to proceed.`;
	}
	if (outcome.kind === "closed") {
		return `The Herdr pane for \`${command}\` closed before the command finished; whether it ran is unknown. Ask the user.`;
	}
	const edited = outcome.ran === command ? "" : ` (edited from \`${command}\`)`;
	return [
		`The user ran this in a Herdr pane${edited}, which is now closed. Exit code ${outcome.exitCode}.`,
		"",
		"```",
		`$ ${outcome.ran}`,
		outcome.output,
		"```",
		"",
		"Read the output and respond to it.",
	].join("\n");
}
