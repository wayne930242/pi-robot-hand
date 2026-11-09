/**
 * The `e` check: a model the user picked reads the handed-over command, the scripts it runs, the
 * agent's reason, and the user's last message, then says what the command really does and whether
 * that matches the stated intent. It informs the user's choice; it never blocks one.
 */

import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { canonicalPath, shellWords, splitSegments } from "./secret-drop/guard.ts";
import type { Kind } from "./hand.ts";

export type Verdict = "match" | "partial" | "mismatch" | "unclear";

export interface CheckResult {
	/** `provider/id` of the model that checked. */
	model: string;
	verdict: Verdict;
	/** What the command will actually do. */
	does: string;
	/** How that differs from the stated intent; empty when it does not. */
	gaps: string;
}

export interface Script {
	path: string;
	text: string;
	truncated: boolean;
}

export interface CheckInput {
	command: string;
	kind: Kind;
	reason: string;
	userMessage?: string;
	scripts: Script[];
}

export type Complete = (model: Model<Api>, context: Context, options: { signal?: AbortSignal }) => Promise<AssistantMessage>;

const MAX_SCRIPTS = 5;
const MAX_SCRIPT_BYTES = 16_000;
const MAX_USER_CHARS = 2_000;
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".ksh", ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts", ".mts", ".php", ".lua", ".ps1", ".sql", ".awk"]);

export function modelRef(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The saved check model, or undefined when none was picked yet or the file is unreadable. Read
 * synchronously so the selector opens in the same tick as before the check existed.
 */
export function loadCheckModel(file: string): string | undefined {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { checkModel?: unknown };
		return typeof data.checkModel === "string" && data.checkModel ? data.checkModel : undefined;
	} catch {
		return undefined;
	}
}

export async function saveCheckModel(file: string, ref: string): Promise<void> {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
	} catch {}
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify({ ...data, checkModel: ref }, null, 2)}\n`);
	await rename(temp, file);
}

/** Paths secret_drop protects, read from its registry. A missing or unreadable registry protects nothing extra. */
export async function protectedPaths(registryFile: string): Promise<Set<string>> {
	try {
		const data = JSON.parse(await readFile(registryFile, "utf8")) as { entries?: { path?: unknown }[] };
		return new Set((data.entries ?? []).map((entry) => entry.path).filter((path): path is string => typeof path === "string"));
	} catch {
		return new Set();
	}
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Script files the command names: words that resolve to a regular text file with a script
 * extension or a `#!` line. Secret files (secret_drop's registry and staging) are never read.
 */
export async function findScripts(command: string, cwd: string, isSecret: (canonical: string) => boolean): Promise<Script[]> {
	const scripts: Script[] = [];
	const seen = new Set<string>();
	for (const segment of splitSegments(command)) {
		for (const word of shellWords(segment)) {
			if (scripts.length >= MAX_SCRIPTS) return scripts;
			if (!word || word.startsWith("-") || /^[<>]+$/.test(word) || word.includes("=")) continue;
			const path = canonicalPath(word, cwd);
			if (seen.has(path)) continue;
			seen.add(path);
			if (isSecret(path)) continue;
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile() || info.size === 0) continue;
			const head = await readHead(path, MAX_SCRIPT_BYTES + 1).catch(() => undefined);
			if (!head || head.includes(0)) continue;
			const isScript = SCRIPT_EXTENSIONS.has(extname(path).toLowerCase()) || head.subarray(0, 2).toString() === "#!" || basename(path) === "Makefile";
			if (!isScript) continue;
			const truncated = head.length > MAX_SCRIPT_BYTES;
			scripts.push({ path, text: head.subarray(0, MAX_SCRIPT_BYTES).toString("utf8"), truncated });
		}
	}
	return scripts;
}

/** A predicate for secret files: secret_drop's registered destinations and anything under its own folder. */
export function secretGuard(paths: Set<string>, secretDropDir: string): (canonical: string) => boolean {
	const dir = canonicalPath(secretDropDir, "/");
	return (path) => paths.has(path) || path === dir || path.startsWith(`${dir}${sep}`);
}

interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** The text of the user's last message on this branch, shortened. */
export function lastUserText(entries: readonly EntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("\n")
					: "";
		const trimmed = text.trim();
		if (!trimmed) continue;
		return trimmed.length > MAX_USER_CHARS ? `${trimmed.slice(0, MAX_USER_CHARS)}…` : trimmed;
	}
	return undefined;
}

const SYSTEM = [
	"You check a command that an AI coding agent handed to its user to run. Before running it, the user wants to know what it really does and whether that matches what the agent said it is for and what the user asked.",
	"Read the command and every script included. Reply with one JSON object and nothing else:",
	'{"verdict": "match" | "partial" | "mismatch", "does": "...", "gaps": "..."}',
	"verdict: match when the command does what the reason says and nothing materially more; partial when it does that but also something the reason does not mention (deleting, overwriting, network access, sudo, touching credentials, deploying), or when the reason is too vague to judge; mismatch when it does something else or goes against the user's request.",
	"does: one to three short sentences on what it will actually do, naming destructive or irreversible effects.",
	"gaps: what differs from the stated intent and the user's request, or an empty string.",
	"Write does and gaps in the language of the reason.",
].join("\n");

export function checkContext(input: CheckInput): Context {
	const parts = [
		`Reason the agent gave: ${input.reason}`,
		input.userMessage ? `The user's last message:\n${input.userMessage}` : "The user's last message: (none)",
		`Command (${input.kind === "pi" ? "a pi slash command" : "a shell command"}):\n${input.command}`,
		...input.scripts.map((script) => `Script ${script.path}${script.truncated ? ` (first ${MAX_SCRIPT_BYTES} bytes)` : ""}:\n${script.text}`),
	];
	return { systemPrompt: SYSTEM, messages: [{ role: "user", content: parts.join("\n\n"), timestamp: Date.now() }] };
}

const VERDICTS = new Set<Verdict>(["match", "partial", "mismatch"]);

/** Reads the model's reply; a reply that is not the asked-for JSON is shown as is with verdict `unclear`. */
export function parseCheck(model: string, reply: string): CheckResult {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const data = JSON.parse(reply.slice(start, end + 1)) as { verdict?: unknown; does?: unknown; gaps?: unknown };
			if (typeof data.verdict === "string" && VERDICTS.has(data.verdict as Verdict) && typeof data.does === "string") {
				return { model, verdict: data.verdict as Verdict, does: data.does.trim(), gaps: typeof data.gaps === "string" ? data.gaps.trim() : "" };
			}
		} catch {}
	}
	const text = reply.trim();
	return { model, verdict: "unclear", does: text.length > 600 ? `${text.slice(0, 600)}…` : text, gaps: "" };
}

/** Runs the check once. Throws with a message the user can act on when the model cannot answer. */
export async function runCheck(complete: Complete, model: Model<Api>, input: CheckInput, signal?: AbortSignal): Promise<CheckResult> {
	const ref = modelRef(model);
	const message = await complete(model, checkContext(input), { signal });
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage || `${ref} returned no answer (${message.stopReason}).`);
	}
	const reply = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	if (!reply.trim()) throw new Error(`${ref} returned an empty answer.`);
	return parseCheck(ref, reply);
}

/** One line for the agent: what the user saw before choosing. */
export function checkSummary(result: CheckResult): string {
	const gaps = result.gaps ? ` Differences: ${result.gaps}` : "";
	return `Before choosing, the user had ${result.model} check the command against your reason; verdict: ${result.verdict}. It said: ${result.does}${gaps}`;
}

export const SETTINGS_FILE = "robot-hand.json";
export function settingsPath(agentDir: string): string {
	return join(agentDir, SETTINGS_FILE);
}
