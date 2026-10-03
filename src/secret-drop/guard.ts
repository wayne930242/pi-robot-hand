/**
 * Decide whether a tool call would expose or clobber a protected secret file.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** Commands that print, copy, or open file contents. Scripts that consume a file stay allowed. */
const READERS = new Set([
	"cat", "bat", "less", "more", "most", "head", "tail", "tac", "nl", "pr",
	"grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "cut", "sort", "uniq", "paste", "column",
	"strings", "xxd", "hexdump", "od", "base64", "base32", "diff", "cmp", "comm",
	"vi", "vim", "nvim", "nano", "emacs", "code", "open", "pbcopy", "xclip", "xsel",
	"cp", "mv", "scp", "rsync", "tee", "dd", "install", "jq", "yq", "dotenv", "envsubst",
]);

/** Prefixes that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "time", "nice", "nohup", "xargs", "stdbuf", "timeout"]);
/** Shells whose `-c` argument is itself a command line. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_NESTING = 4;

const FILE_TOOLS = new Set(["read", "edit", "write", "grep"]);

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

/** Absolute path with symlinks resolved when the file exists. */
export function canonicalPath(path: string, cwd: string): string {
	const expanded = expandHome(path.startsWith("@") ? path.slice(1) : path);
	const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function blockReason(path: string): string {
	return [
		`${path} holds a secret managed by secret_drop; its contents stay out of the conversation.`,
		"Let the program that needs it read the file itself, or ask the user to run the consuming command with `!`.",
		"Call secret_drop again to change the value.",
	].join(" ");
}

/**
 * Split a command line into simple commands at `;`, `|`, `&`, newlines, and parentheses outside quotes,
 * and at every command substitution (`$(` or a backtick) outside single quotes.
 */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (current.trim()) segments.push(current);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] ?? "";
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			current += ch;
		} else if (ch === "\\") {
			current += ch + (command[i + 1] ?? "");
			i += 1;
		} else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
			flush();
			quote = undefined;
			if (ch === "$") i += 1;
		} else if (quote === '"') {
			if (ch === '"') quote = undefined;
			current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
		} else if (";|&\n()".includes(ch)) {
			flush();
		} else {
			current += ch;
		}
	}
	flush();
	return segments;
}

/** Shell words of one simple command, quotes removed. Redirection operators are separate words. */
function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	const push = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] ?? "";
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (quote === '"' && ch === "\\" && i + 1 < segment.length) word += segment[++i];
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (ch === "\\") {
			word += segment[++i] ?? "";
			started = true;
		} else if (/\s/.test(ch)) {
			push();
		} else if (ch === "<" || ch === ">") {
			push();
			let op = ch;
			while (segment[i + 1] === "<" || segment[i + 1] === ">") op += segment[++i];
			words.push(op);
		} else {
			word += ch;
			started = true;
		}
	}
	push();
	return words;
}

/** Return the protected path a command line reads or redirects, otherwise undefined. */
function findBashHit(command: string, cwd: string, isProtected: (canonical: string) => boolean, depth: number): string | undefined {
	if (depth > MAX_NESTING) return undefined;
	const hits = (word: string) => word.length > 0 && isProtected(canonicalPath(word, cwd));
	for (const segment of splitSegments(command.replace(/\$\{?HOME\}?/g, homedir()))) {
		const tokens = shellWords(segment);
		const args: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] ?? "";
			if (!/^[<>]+$/.test(token)) {
				args.push(token);
				continue;
			}
			const target = tokens[++i] ?? "";
			// `<<` and `<<<` take a heredoc delimiter or a literal string, not a file.
			if (!token.startsWith("<<") && hits(target)) return target;
		}

		let k = 0;
		let wrapped = false;
		while (k < args.length) {
			const word = args[k] ?? "";
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) k += 1;
			else if (WRAPPERS.has(basename(word))) {
				wrapped = true;
				k += 1;
			} else if (wrapped && (word.startsWith("-") || /^\d/.test(word))) k += 1;
			else break;
		}
		const name = basename(args[k] ?? "");
		const rest = args.slice(k + 1);

		if (SHELLS.has(name)) {
			const flag = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
			const script = flag === -1 ? undefined : rest[flag + 1];
			const hit = script ? findBashHit(script, cwd, isProtected, depth + 1) : undefined;
			if (hit) return hit;
		} else if (name === "eval") {
			const hit = findBashHit(rest.join(" "), cwd, isProtected, depth + 1);
			if (hit) return hit;
		} else if (READERS.has(name)) {
			const hit = rest.find((word) => hits(word) || (word.includes("=") && hits(word.slice(word.indexOf("=") + 1))));
			if (hit) return hit;
		}
	}
	return undefined;
}

/**
 * Return a block reason when the call touches a protected path, otherwise undefined.
 * `isProtected` receives canonical absolute paths.
 */
export function checkToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	isProtected: (canonical: string) => boolean,
): string | undefined {

	if (FILE_TOOLS.has(toolName)) {
		const path = input.path;
		if (typeof path !== "string" || path.length === 0) return undefined;
		const target = canonicalPath(path, cwd);
		return isProtected(target) ? blockReason(path) : undefined;
	}

	if (toolName === "bash") {
		const command = input.command;
		if (typeof command !== "string") return undefined;
		const hit = findBashHit(command, cwd, isProtected, 0);
		return hit ? blockReason(hit) : undefined;
	}

	return undefined;
}
