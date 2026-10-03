/**
 * Staging area and the `!` apply command handed to the user.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Placement } from "../../lib/placement.ts";
import { shellQuote } from "../../lib/shell.ts";

export type ApplyPlan =
	| { format: "placement"; destination: string; placement: Placement; fileMode?: string; overwrite?: boolean }
	| { format: "exec"; command: string };

export interface ApplyResult {
	ok: boolean;
	message: string;
}

/** Shortest unambiguous shell form of an absolute path: ./rel inside cwd, ~/rel under home. */
export function displayPath(absolute: string, cwd: string): string {
	const inCwd = relative(cwd, absolute);
	if (inCwd && !inCwd.startsWith("..") && !inCwd.startsWith(sep)) return shellQuote(`./${inCwd}`);
	const home = homedir();
	if (absolute.startsWith(`${home}${sep}`)) return `~/${shellQuote(absolute.slice(home.length + 1))}`;
	return shellQuote(absolute);
}

/** The command line (without the leading `!`) that applies `staged` according to `plan`. */
export function buildApplyCommand(script: string, staged: string, plan: ApplyPlan, cwd: string): string {
	const words = ["node", displayPath(script, cwd)];
	if (plan.format === "exec") {
		words.push("exec", shellQuote(plan.command));
	} else {
		const { placement, destination } = plan;
		words.push(placement.mode, displayPath(destination, cwd));
		if (placement.mode === "env") words.push(shellQuote(placement.key));
		if (placement.mode === "regex") words.push(shellQuote(placement.pattern));
		if (placement.mode === "env" && placement.quote !== "auto") words.push("--quote", placement.quote);
		if (placement.mode === "regex" && placement.flags) words.push("--flags", shellQuote(placement.flags));
		if (plan.overwrite) words.push("--overwrite");
		if (plan.fileMode) words.push("--mode", shellQuote(plan.fileMode));
	}
	words.push("--from", displayPath(staged, cwd));
	return words.join(" ");
}

/** A fresh staged-file path. The pid prefix lets other sessions tell live entries from stale ones. */
export function newStagedPath(dir: string): string {
	return join(dir, `${process.pid}-${randomBytes(6).toString("hex")}`);
}

export async function stageSecret(path: string, value: string, dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(path, value, { mode: 0o600, flag: "wx" });
}

export async function discardStaged(path: string): Promise<void> {
	await rm(path, { force: true });
	await rm(`${path}.result`, { force: true });
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove staged files left by this process or by pi processes that no longer run. */
export async function clearStale(dir: string): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number.parseInt(name.split("-")[0] ?? "", 10);
		if (Number.isNaN(pid) || pid === process.pid || !isAlive(pid)) await rm(join(dir, name), { force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait until the apply script reports on `staged`. Resolves null when `signal` aborts.
 */
export async function waitForResult(staged: string, signal: AbortSignal | undefined, pollMs = 250): Promise<ApplyResult | null> {
	const resultFile = `${staged}.result`;
	while (!signal?.aborted) {
		try {
			const parsed = JSON.parse(await readFile(resultFile, "utf8")) as ApplyResult;
			return { ok: parsed.ok === true, message: String(parsed.message) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!(await exists(staged)) && !(await exists(resultFile))) {
			return { ok: false, message: "the staged secret disappeared before it was applied" };
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, pollMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}
	return null;
}
