/**
 * What a handed-over shell command runs, read for the check: the script files it names, the make targets and
 * package scripts it starts, and the shell scripts those run in turn. Everything is read as text and parsed here;
 * nothing is executed, so no target, script, or `-c` string runs to find out what it would do. What the scan cannot
 * read is listed as `unread`, so the user and the check see what was not checked instead of guessing.
 */

import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPath, expandHome } from "./secret-drop/guard.ts";

export interface Script {
	path: string;
	/** The part of the file that runs, when it is not the whole file, such as `scripts.build` of a package.json. */
	entry?: string;
	text: string;
	truncated: boolean;
}

/**
 * Why something the command runs was not read. `missing`: a file it runs is not there or not text. `indirect`: the
 * code comes from elsewhere (a download, standard input, a path built at runtime, a package or task runner the scan
 * does not follow). `truncated`: only the start of a long file was read. `skipped`: a limit stopped the scan.
 */
export type UnreadKind = "missing" | "indirect" | "truncated" | "skipped";

export interface Unread {
	kind: UnreadKind;
	/** The file or command as the command names it. Untrusted: it can hold any character. */
	target: string;
	detail: string;
}

export interface ScriptScan {
	scripts: Script[];
	unread: Unread[];
}

export type Redact = (text: string) => string;
const keep: Redact = (text) => text;

export const MAX_SCRIPTS = 5;
export const MAX_SCRIPT_BYTES = 16_000;
// Read past the cut so a secret that straddles it is still whole when redacted.
const REDACT_MARGIN = 4_096;
// Files reached from the command through at most this many hops (the command's own scripts are one hop).
export const MAX_DEPTH = 3;
// `sh -c`, `eval`, and `$(…)` inside one text.
const MAX_NEST = 4;
const MAX_PACKAGE_BYTES = 256_000;
export const MAX_UNREAD = 20;
const MAX_TARGET_CHARS = 120;

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".ksh", ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts", ".mts", ".php", ".lua", ".ps1", ".sql", ".awk"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ksh", ".dash"]);
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]);
const INTERPRETER = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|ruby|perl|php|lua|luajit|pwsh|powershell|tsx|ts-node|deno|Rscript|osascript)$/;
// Options after which the interpreter runs no code from a file or standard input (`--test` finds test files itself).
const NO_CODE = new Set(["-v", "-V", "--version", "-h", "--help", "repl", "--test"]);
// Interpreter options that take the next word as their value.
const VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-W", "-X"]);
// Shell options that take the next word as their value.
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_VERBS = new Set(["install", "i", "ci", "add", "it", "install-test", "isntall", "in", "rebuild"]);
const RUN_VERBS = new Set(["run", "run-script", "rum", "urn"]);
const NPM_LIFECYCLE: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const PACKAGE_EXEC = new Set(["exec", "x", "dlx"]);
const PACKAGE_DIR_OPTIONS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const WORKSPACE_OPTIONS = new Set(["-w", "--workspace", "--workspaces", "-ws", "--filter", "-F", "-r", "--recursive"]);
const WORKSPACE_FLAGS = new Set(["--workspaces", "-ws", "-r", "--recursive"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);
const TASK_RUNNERS = new Set(["just", "task", "rake", "invoke", "poe", "nox", "tox", "gradle", "gradlew", "mvn", "mvnw"]);
const DOWNLOADERS = /\b(curl|wget|fetch|iwr|Invoke-WebRequest|Invoke-RestMethod)\b/;
// Wrappers that run the rest of the line as a command, and their options that take a value.
const WRAPPERS: Record<string, Set<string>> = {
	sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "-C", "--unset", "--chdir"]),
	nice: new Set(["-n"]),
	ionice: new Set(["-c", "-n", "-p"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--arg-file"]),
	nohup: new Set(),
	exec: new Set(["-a"]),
	command: new Set(),
	builtin: new Set(),
	time: new Set(),
	caffeinate: new Set(["-w", "-t"]),
	watch: new Set(["-n", "-d"]),
};
// Two-word wrappers that run a project's command, such as `uv run script.py`.
const RUN_WRAPPERS: Record<string, Set<string>> = {
	uv: new Set(["--with", "--python", "-p", "--project", "--directory", "--from", "--env-file", "--group", "--extra"]),
	poetry: new Set(["-C", "--directory", "-P", "--project"]),
	pipenv: new Set(),
	pdm: new Set(["-p", "--project"]),
	rye: new Set(),
	hatch: new Set(["-e", "--env"]),
	bundle: new Set(),
};
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "coproc"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const LOOPS = new Set(["for", "select", "case", "function"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DOWNLOADS_PACKAGE = "may download and run a package, whose code the check does not read";
const DYNAMIC = "$(…)";
const PROCESS = "<(…)";

/** Options after which an interpreter's code is in the command itself, or a module is named, so there is no file to read. */
function inlineFlags(base: string): readonly string[] {
	if (/^(python|pypy)/.test(base)) return ["-c", "-m"];
	if (["node", "nodejs", "bun", "tsx", "ts-node"].includes(base)) return ["-e", "-p", "--eval", "--print"];
	if (base === "perl") return ["-e", "-E"];
	if (base === "php") return ["-r"];
	if (base === "pwsh" || base === "powershell") return ["-c", "-Command", "-command"];
	if (base === "deno") return ["eval", "repl"];
	return ["-e"];
}

/**
 * Shell words of each simple command in `text`, in order. Quotes are removed; a command substitution
 * (`$(…)`, backticks) or process substitution becomes the placeholder `$(…)` or `<(…)` in its word and its own
 * commands are listed too; comments, here-document bodies, `case` patterns, and array literals are dropped;
 * `&&`, `||`, and parentheses inside `[[ … ]]` are part of the test; redirection operators are separate words.
 * It reads the text only: nothing is expanded or run.
 */
export function parseCommands(text: string, nest = 0): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	let tag: false | "plain" | "strip" = false;
	const heredocs: { tag: string; strip: boolean }[] = [];
	// Inside `[[ … ]]`; inside a `case`, and whether a pattern comes next.
	let test = false;
	let cases = 0;
	let pattern = false;
	const atCommand = () => words.every((each) => KEYWORDS.has(each));
	const pushWord = () => {
		if (started) {
			if (tag) heredocs.push({ tag: word, strip: tag === "strip" });
			tag = false;
			if (word === "[[" && atCommand()) test = true;
			else if (word === "]]") test = false;
			words.push(word);
			if (word === "in" && words[0] === "case" && words.length >= 3) {
				out.push(words);
				words = [];
				cases++;
				pattern = true;
			}
		}
		word = "";
		started = false;
	};
	const flush = () => {
		pushWord();
		if (words[0] === "esac") cases = Math.max(0, cases - 1);
		if (words.length > 0) out.push(words);
		words = [];
	};
	const inner = (code: string, placeholder: string) => {
		if (nest < MAX_NEST * 2) out.push(...parseCommands(code, nest + 1));
		word += placeholder;
		started = true;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] ?? "";
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
			continue;
		}
		if (ch === "\\") {
			const next = text[i + 1];
			i++;
			if (next === undefined || next === "\n") continue;
			if (quote === '"' && !'$`"\\'.includes(next)) word += "\\";
			word += next;
			started = true;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const end = closingParen(text, i + 2);
			// `$(( … ))` is arithmetic, not a command.
			if (text[i + 2] === "(") {
				word += DYNAMIC;
				started = true;
			} else inner(text.slice(i + 2, end), DYNAMIC);
			i = end;
			continue;
		}
		if (ch === "`") {
			const end = closingTick(text, i + 1);
			inner(text.slice(i + 1, end), DYNAMIC);
			i = end;
			continue;
		}
		if (ch === "$" && text[i + 1] === "{") {
			const end = Math.min(closingBrace(text, i + 2), text.length - 1);
			word += text.slice(i, end + 1);
			started = true;
			i = end;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else word += ch;
			continue;
		}
		if (pattern && !started && words.length === 0) {
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
			if (text.startsWith("esac", i) && !/[\w-]/.test(text[i + 4] ?? "")) pattern = false;
			else if (ch !== "#") {
				// `a|b)` or `(a|b)`: a pattern to match, not a command.
				i = closingParen(text, ch === "(" ? i + 1 : i);
				pattern = false;
				continue;
			}
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "#" && !started) {
			const newline = text.indexOf("\n", i);
			i = (newline < 0 ? text.length : newline) - 1;
			continue;
		}
		if (ch === "(" && text[i + 1] === "(" && !started && atCommand()) {
			// `(( … ))` is arithmetic, not a command.
			i = closingParen(text, i + 1);
			continue;
		}
		if (test && "&|()<>".includes(ch)) {
			pushWord();
			continue;
		}
		if (ch === "(" && started && word.endsWith("=")) {
			// An array literal, `name=(…)`: values, not a command.
			const end = closingParen(text, i + 1);
			word += text.slice(i, end + 1);
			i = end;
			continue;
		}
		if ((ch === "<" || ch === ">") && text[i + 1] === "(" && !started) {
			const end = closingParen(text, i + 2);
			inner(text.slice(i + 2, end), PROCESS);
			i = end;
			continue;
		}
		if (ch === "<" || ch === ">" || (ch === "&" && text[i + 1] === ">")) {
			// `2>` and `10<`: the number belongs to the operator.
			if (started && /^\d+$/.test(word)) {
				word = "";
				started = false;
			} else pushWord();
			let op = ch;
			while (op.length < 3 && (text[i + 1] === "<" || text[i + 1] === ">")) op += text[++i];
			if ((text[i + 1] === "&" || text[i + 1] === "|") && text[i + 2] !== "&") op += text[++i];
			if (op === "<<" && text[i + 1] === "-") op += text[++i];
			words.push(op);
			if (op === "<<" || op === "<<-") tag = op === "<<-" ? "strip" : "plain";
			continue;
		}
		if (ch === "\n") {
			flush();
			if (heredocs.length > 0) {
				i = skipHeredocs(text, i + 1, heredocs) - 1;
				heredocs.length = 0;
			}
			continue;
		}
		if (ch === ";" && cases > 0 && (text[i + 1] === ";" || text[i + 1] === "&")) {
			flush();
			i++;
			if (text[i + 1] === "&") i++;
			pattern = true;
			continue;
		}
		if (";|&()".includes(ch)) {
			flush();
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			pushWord();
			continue;
		}
		word += ch;
		started = true;
	}
	flush();
	return out;
}

/** The index of the `)` that closes a `(` opened just before `start`, or the text's length. */
function closingParen(text: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = undefined;
		} else if (ch === "\\") i++;
		else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return text.length;
}

/** The index of the `}` that closes a `${` opened just before `start`, or the text's length. */
function closingBrace(text: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") i++;
		else if (quote) {
			if (ch === quote) quote = undefined;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "$" && text[i + 1] === "{") {
			depth++;
			i++;
		} else if (ch === "}" && --depth === 0) return i;
	}
	return text.length;
}

function closingTick(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "`") return i;
	}
	return text.length;
}

/** The index after the last here-document body that starts at `start`. */
function skipHeredocs(text: string, start: number, heredocs: readonly { tag: string; strip: boolean }[]): number {
	let at = start;
	for (const { tag, strip } of heredocs) {
		while (at < text.length) {
			const newline = text.indexOf("\n", at);
			const end = newline < 0 ? text.length : newline;
			const line = text.slice(at, end);
			at = end + 1;
			if ((strip ? line.replace(/^\t+/, "") : line) === tag) break;
		}
	}
	return Math.min(at, text.length);
}

/** The text holds no literal command, only substitutions and variables. */
function onlyDynamic(code: string): boolean {
	return code.replaceAll(DYNAMIC, "").replace(/\$\{[^}]*\}|\$[A-Za-z_@*#?$!0-9][A-Za-z0-9_]*/g, "").trim() === "";
}

function isDynamic(word: string): boolean {
	return word.includes("$") || word.includes(PROCESS);
}

function short(text: string): string {
	return text.length > MAX_TARGET_CHARS ? `${text.slice(0, MAX_TARGET_CHARS)}…` : text;
}

function size(bytes: number): string {
	return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1_000)} KB`;
}

interface Where {
	/** The working directory the command runs in, or undefined after a `cd` to a directory set at runtime. */
	cwd: string | undefined;
	/** The folder of the script being scanned; a relative path it runs is looked up there too. */
	dir?: string;
	/** Hops from the handed-over command: 0 for the command, 1 for its scripts. */
	depth: number;
	/** `make`: a makefile's recipes, where `$(VAR)` is make's own and is not reported. */
	mode: "shell" | "make";
	/** The text downloads something, so code read from standard input may be that download. */
	downloads: boolean;
}

interface Read {
	/** What the command calls the file, for the warning. */
	shown: string;
	/** The command runs this file itself, so a file that cannot be read is reported. */
	runs: boolean;
	/** Scan the file as a shell script, as `source` and `sh` do whatever its name. */
	shell?: boolean;
	/** The file is a makefile. */
	make?: boolean;
	/** The working directory for the commands inside it. */
	cwd: string | undefined;
	depth: number;
}

class Scanner {
	readonly scripts: Script[] = [];
	readonly unread: Unread[] = [];
	private omitted = 0;
	private readonly files = new Set<string>();
	private readonly reported = new Set<string>();
	private readonly queue: { text: string; where: Where }[] = [];
	private readonly top: string;
	private readonly isSecret: (canonical: string) => boolean;
	private readonly redact: Redact;

	constructor(cwd: string, isSecret: (canonical: string) => boolean, redact: Redact) {
		this.top = resolve(cwd);
		this.isSecret = isSecret;
		this.redact = redact;
	}

	async run(command: string): Promise<ScriptScan> {
		this.queue.push({ text: command, where: { cwd: this.top, depth: 0, mode: "shell", downloads: DOWNLOADERS.test(command) } });
		// Breadth first, so the command's own scripts take the file slots before what they call.
		for (let job = this.queue.shift(); job; job = this.queue.shift()) await this.text(job.text, job.where, 0);
		if (this.omitted > 0) this.unread.push({ kind: "skipped", target: `${this.omitted} more`, detail: `more than ${MAX_UNREAD} things were not read; only the first are listed` });
		return { scripts: this.scripts, unread: this.unread };
	}

	/** Lists one thing not read, once: `same` names what makes two notes the same, by default the target. */
	private note(kind: UnreadKind, target: string, detail: string, same = target): void {
		const key = `${kind}\0${same}\0${detail}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		if (this.unread.length >= MAX_UNREAD) this.omitted++;
		else this.unread.push({ kind, target: short(this.redact(target)), detail: this.redact(detail) });
	}

	/** A path as the user would recognize it: relative to the command's folder when inside it. */
	private shown(path: string): string {
		const inside = relative(this.top, path);
		if (inside === "") return ".";
		if (!inside.startsWith("..") && !isAbsolute(inside)) return inside;
		const home = homedir();
		return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
	}

	private async text(text: string, where: Where, nest: number): Promise<void> {
		const at = { ...where };
		for (const words of parseCommands(text)) await this.command(words, at, nest);
	}

	private async command(all: string[], where: Where, nest: number): Promise<void> {
		const { name, args, input, inline, xargs, project, generic } = splitCommand(all);
		const line = all.join(" ");
		if (name === undefined) {
			await this.generic(generic, where);
			return;
		}
		const base = basename(name);
		if (name === "cd" || name === "pushd" || name === "popd") {
			where.cwd = changeDir(where.cwd, name === "popd" ? undefined : args.find((arg) => !arg.startsWith("-")));
			return;
		}
		if (isDynamic(name)) {
			if (where.mode === "shell") this.note("indirect", line, `runs a command whose name is set at runtime (${name})`, name);
		} else if (SHELLS.has(name) || SHELLS.has(base)) {
			await this.shell(name, args, input, inline, xargs, line, where, nest);
		} else if (INTERPRETER.test(base) || base === "bun") {
			await this.interpreter(base, args, input, inline, xargs, line, where);
		} else if (base === "make" || base === "gmake") {
			await this.make(args, line, where);
		} else if (PACKAGE_MANAGERS.has(base)) {
			await this.packageManager(base, args, line, where);
		} else if (PACKAGE_RUNNERS.has(base) || (base === "pipx" && args[0] === "run")) {
			// `npx --no-install` runs only an installed binary, judged by its name like any command on PATH.
			if (!(base === "npx" && args.some((arg) => arg === "--no-install" || arg === "--no"))) this.note("indirect", line, DOWNLOADS_PACKAGE);
		} else if (TASK_RUNNERS.has(base)) {
			this.note("indirect", line, `${base} runs tasks defined in its own files, which the check does not read`);
		} else if (base === "eval") {
			await this.code(args.join(" "), "eval", line, where, nest);
		} else if (name.includes("/") || (project && SCRIPT_EXTENSIONS.has(extname(name).toLowerCase()))) {
			await this.runs(name, line, where, false);
		}
		await this.generic(generic, where);
	}

	/** A string run as shell code (`sh -c`, `eval`): scanned like the command, or reported when it is built at runtime. */
	private async code(code: string | undefined, how: string, line: string, where: Where, nest: number): Promise<void> {
		if (code === undefined || onlyDynamic(code)) {
			if (where.mode === "shell" || code === undefined) this.note("indirect", line, `${how} runs code built at runtime`);
			return;
		}
		if (nest >= MAX_NEST) {
			this.note("skipped", line, `shell code nested more than ${MAX_NEST} levels deep`);
			return;
		}
		await this.text(code, { ...where }, nest + 1);
	}

	private async shell(name: string, args: string[], input: string | undefined, inline: boolean, xargs: boolean, line: string, where: Where, nest: number): Promise<void> {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
				await this.code(args[i + 1], `${basename(name)} -c`, line, where, nest);
				return;
			}
			if (arg === "-s") break;
			if (SHELL_VALUE_OPTIONS.has(arg)) i++;
			else if (NO_CODE.has(arg)) return;
			else if (!arg.startsWith("-") && !arg.startsWith("+")) {
				await this.runs(arg, line, where, true);
				return;
			}
		}
		await this.stdin(input, inline, xargs, line, where, true);
	}

	private async interpreter(base: string, args: string[], input: string | undefined, inline: boolean, xargs: boolean, line: string, where: Where): Promise<void> {
		// Bare `bun` prints its help.
		if (base === "bun" && args.length === 0) return;
		if (base === "bun" && args[0] !== undefined && !args[0].startsWith("-") && !SCRIPT_EXTENSIONS.has(extname(args[0]).toLowerCase()) && !args[0].includes("/")) {
			await this.packageManager(base, args, line, where);
			return;
		}
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			if (inlineFlags(base).includes(arg) || NO_CODE.has(arg)) return;
			// `-` reads the program from standard input; what follows are its arguments.
			if (arg === "-") break;
			if (base === "deno" && arg === "task") {
				this.note("indirect", line, "deno task runs tasks defined in deno.json, which the check does not read");
				return;
			}
			if (VALUE_OPTIONS.has(arg)) i++;
			else if (arg.startsWith("-")) continue;
			else if (base === "deno" && ["run", "test", "bench", "compile"].includes(arg)) continue;
			else if (base === "bun" && arg === "run") continue;
			else {
				await this.runs(arg, line, where, false);
				return;
			}
		}
		await this.stdin(input, inline, xargs, line, where, false);
	}

	/** An interpreter given no file reads its code from standard input, a redirected file, or a here-document. */
	private async stdin(input: string | undefined, inline: boolean, xargs: boolean, line: string, where: Where, shell: boolean): Promise<void> {
		if (input !== undefined) {
			await this.runs(input, line, where, shell);
			return;
		}
		if (inline) return;
		if (xargs) this.note("indirect", line, "runs files named on standard input, which the check does not see");
		else this.note("indirect", line, where.downloads ? "runs code from standard input, which may be what the command downloads" : "runs code from standard input, which the check does not see");
	}

	/** A file the command runs: read it, or report why not. */
	private async runs(word: string, line: string, where: Where, shell: boolean): Promise<void> {
		if (word.includes(PROCESS)) {
			this.note("indirect", line, "runs the output of another command as code");
			return;
		}
		if (isDynamic(word)) {
			if (where.mode === "shell") this.note("indirect", short(word), "runs a path set at runtime");
			return;
		}
		if (/[*?[]/.test(word)) {
			this.note("indirect", word, "runs the files that match this pattern, which the check does not read");
			return;
		}
		const path = await locate(word, where);
		if (path === undefined) {
			if (where.cwd === undefined && !isAbsolute(expandHome(word))) this.note("indirect", word, "is relative to a folder set at runtime");
			else this.note("missing", word, "does not exist");
			return;
		}
		await this.read(path, { shown: word, runs: true, shell, cwd: where.cwd, depth: where.depth + 1 });
	}

	/** Words that name an existing script file, wherever they stand: read them, but never report a missing one. */
	private async generic(words: readonly string[], where: Where): Promise<void> {
		for (const word of words) {
			if (!word || word.startsWith("-") || word.includes("=") || isDynamic(word) || /^[<>&|0-9]+$/.test(word)) continue;
			const base = isAbsolute(expandHome(word)) ? "/" : where.cwd;
			if (base === undefined) continue;
			await this.read(canonicalPath(word, base), { shown: word, runs: false, cwd: where.cwd, depth: where.depth + 1 });
		}
	}

	private async read(path: string, how: Read): Promise<void> {
		const canonical = canonicalPath(path, "/");
		if (this.files.has(canonical)) return;
		this.files.add(canonical);
		if (this.isSecret(canonical)) {
			if (how.runs) this.note("missing", how.shown, "secret_drop protects it, so it is never sent");
			return;
		}
		const file = await readText(canonical, MAX_SCRIPT_BYTES + REDACT_MARGIN);
		if (file.kind !== "text") {
			if (!how.runs) return;
			if (file.kind === "absent") this.note("missing", how.shown, "does not exist");
			else if (file.kind === "other") this.note("missing", how.shown, "is not a regular file");
			// A compiled program on the system is judged by its name, like any command on PATH.
			else if (!isAbsolute(expandHome(how.shown))) this.note("missing", how.shown, "is a binary file, not text");
			return;
		}
		const head = file.head;
		const isScript = how.runs || how.make || how.shell || SCRIPT_EXTENSIONS.has(extname(canonical).toLowerCase()) || head.startsWith("#!") || MAKEFILES.includes(basename(canonical));
		if (!isScript) return;
		// A script a nested script merely names is read when there is room, and left out silently when not.
		const report = how.runs || how.depth === 1;
		if (how.depth > MAX_DEPTH) {
			if (report) this.note("skipped", how.shown, `is nested more than ${MAX_DEPTH} levels deep`);
			return;
		}
		if (this.scripts.length >= MAX_SCRIPTS) {
			if (report) this.note("skipped", how.shown, `is past the ${MAX_SCRIPTS}-file limit`);
			return;
		}
		const truncated = file.size > MAX_SCRIPT_BYTES;
		const text = this.redact(head).slice(0, MAX_SCRIPT_BYTES);
		this.scripts.push({ path: canonical, text, truncated });
		if (truncated) this.note("truncated", how.shown, `only the first ${size(MAX_SCRIPT_BYTES)} of ${size(file.size)} were read`);
		const where: Where = { cwd: how.cwd, dir: dirname(canonical), depth: how.depth, mode: "shell", downloads: DOWNLOADERS.test(text) };
		if (how.make || MAKEFILES.includes(basename(canonical))) {
			for (const include of makeIncludes(text)) await this.read(resolve(how.cwd ?? dirname(canonical), expandHome(include)), { shown: include, runs: true, make: true, cwd: how.cwd, depth: how.depth });
			this.queue.push({ text: makeRecipes(text), where: { ...where, mode: "make" } });
		} else if (how.shell || isShellScript(canonical, text)) {
			this.queue.push({ text, where });
		}
	}

	private async make(args: string[], line: string, where: Where): Promise<void> {
		let dir = where.cwd;
		const files: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			const value = (long: string, short: string): string | undefined => {
				if (arg === short || arg === long) return args[++i];
				if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
				if (arg.startsWith(short) && arg.length > short.length) return arg.slice(short.length);
				return undefined;
			};
			const file = arg.startsWith("--makefile") ? value("--makefile", "-f") : value("--file", "-f");
			if (file !== undefined) {
				files.push(file);
				continue;
			}
			const folder = value("--directory", "-C");
			if (folder !== undefined) dir = changeDir(dir, folder);
			else if (["-I", "-o", "-W", "-l"].includes(arg)) i++;
		}
		if (dir === undefined) {
			this.note("indirect", line, "runs make in a folder set at runtime");
			return;
		}
		if (files.length === 0) {
			const found = await findMakefile(dir);
			if (found === undefined) this.note("missing", line, `there is no makefile in ${this.shown(dir)}`);
			else await this.read(found, { shown: this.shown(found), runs: true, make: true, cwd: dir, depth: where.depth + 1 });
			return;
		}
		for (const file of files) {
			if (isDynamic(file)) this.note("indirect", line, `runs a makefile set at runtime (${file})`);
			else await this.read(resolve(dir, expandHome(file)), { shown: file, runs: true, make: true, cwd: dir, depth: where.depth + 1 });
		}
	}

	private async packageManager(pm: string, args: string[], line: string, where: Where): Promise<void> {
		let dir = where.cwd;
		let workspaces = false;
		const words: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			const [option, attached] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
			if (PACKAGE_DIR_OPTIONS.has(option)) dir = changeDir(dir, attached ?? args[++i]);
			else if (WORKSPACE_OPTIONS.has(option)) {
				workspaces = true;
				if (attached === undefined && !WORKSPACE_FLAGS.has(option)) i++;
			} else if (!arg.startsWith("-")) words.push(arg);
		}
		const [verb, next] = words;
		if (verb === undefined) {
			if (pm === "yarn") this.note("indirect", line, "runs install scripts of the package and its dependencies, which the check does not read");
			return;
		}
		if (INSTALL_VERBS.has(verb)) {
			this.note("indirect", line, "runs install scripts of the package and its dependencies, which the check does not read");
			return;
		}
		if (PACKAGE_EXEC.has(verb)) {
			// `pnpm exec` and `yarn exec` run only an installed binary.
			if (!(verb === "exec" && (pm === "pnpm" || pm === "yarn"))) this.note("indirect", line, DOWNLOADS_PACKAGE);
			return;
		}
		const explicit = RUN_VERBS.has(verb);
		const name = explicit ? next : pm === "npm" ? NPM_LIFECYCLE[verb] : verb;
		if (name === undefined) return;
		if (pm === "bun" && (name.includes("/") || SCRIPT_EXTENSIONS.has(extname(name).toLowerCase()))) {
			await this.runs(name, line, where, false);
			return;
		}
		if (dir === undefined) {
			this.note("indirect", line, "runs a package script in a folder set at runtime");
			return;
		}
		// npm runs `pre<name>` and `post<name>` around a script; the others do not by default.
		const found = await this.packageScript(pm, name, dir, explicit || pm === "npm", line, where.depth + 1);
		if (found && workspaces) this.note("indirect", line, "also runs the script in workspace packages, which the check does not read");
	}

	private async packageScript(pm: string, name: string, dir: string, required: boolean, line: string, depth: number): Promise<boolean> {
		const path = canonicalPath(join(dir, "package.json"), "/");
		if (this.isSecret(path)) {
			this.note("missing", line, "its package.json is protected by secret_drop, so it is never sent");
			return false;
		}
		const file = await readText(path, MAX_PACKAGE_BYTES + 1);
		if (file.kind !== "text") {
			if (required) this.note("missing", line, `there is no package.json in ${this.shown(dir)}`);
			return false;
		}
		if (file.size > MAX_PACKAGE_BYTES) {
			this.note("missing", line, `package.json is over ${size(MAX_PACKAGE_BYTES)}`);
			return false;
		}
		let scripts: unknown;
		try {
			scripts = (JSON.parse(file.head) as { scripts?: unknown } | null)?.scripts;
		} catch {
			this.note("missing", line, "package.json is not valid JSON");
			return false;
		}
		// Own string values only: a name such as `constructor` must not reach Object.prototype.
		const script = (key: string): string | undefined => {
			if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts) || !Object.hasOwn(scripts, key)) return undefined;
			const value = (scripts as Record<string, unknown>)[key];
			return typeof value === "string" ? value : undefined;
		};
		if (script(name) === undefined) {
			if (required) this.note("missing", line, `package.json has no script ${JSON.stringify(name)}`);
			return false;
		}
		const key = `${path}#${name}`;
		if (this.files.has(key)) return true;
		this.files.add(key);
		if (depth > MAX_DEPTH) {
			this.note("skipped", line, `is nested more than ${MAX_DEPTH} levels deep`);
			return true;
		}
		if (this.scripts.length >= MAX_SCRIPTS) {
			this.note("skipped", line, `is past the ${MAX_SCRIPTS}-file limit`);
			return true;
		}
		const names = (pm === "npm" ? [`pre${name}`, name, `post${name}`] : [name]).filter((key) => script(key) !== undefined);
		const values = names.map((key) => [key, this.redact(script(key) ?? "")] as const);
		const text = values.map(([key, value]) => `${key}: ${value}`).join("\n");
		this.scripts.push({ path, entry: `scripts.${name}`, text: text.slice(0, MAX_SCRIPT_BYTES), truncated: text.length > MAX_SCRIPT_BYTES });
		for (const [, value] of values) this.queue.push({ text: value, where: { cwd: dir, dir, depth, mode: "shell", downloads: DOWNLOADERS.test(value) } });
		return true;
	}
}

interface Command {
	/** The command word after assignments, keywords, and wrappers; undefined for a segment that runs nothing to read. */
	name?: string;
	/** Its arguments, redirections removed. */
	args: string[];
	/** The file standard input comes from (`< file`). */
	input?: string;
	/** Standard input is a here-document or here-string, so its code is in the text itself. */
	inline: boolean;
	/** `xargs` adds the arguments from standard input. */
	xargs: boolean;
	/** `uv run` and the like run a script named as the command word. */
	project: boolean;
	/** Every word that may name a file, for reading existing scripts. */
	generic: string[];
}

function splitCommand(all: readonly string[]): Command {
	const words: string[] = [];
	let input: string | undefined;
	let inline = false;
	for (let i = 0; i < all.length; i++) {
		const word = all[i] ?? "";
		if (/^(<|>|>>|<>|>\||&>|&>>|<&|>&)$/.test(word)) {
			const target = all[++i];
			if (word === "<" && target !== undefined) input = target;
		} else if (/^<<-?$/.test(word)) {
			i++;
			inline = true;
		} else if (word === "<<<") {
			i++;
			inline = true;
		} else words.push(word);
	}
	const generic = words.filter((word) => !ASSIGNMENT.test(word));
	let i = 0;
	let xargs = false;
	let project = false;
	while (i < words.length) {
		const word = words[i] ?? "";
		const base = basename(word);
		if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
			i++;
			continue;
		}
		if (LOOPS.has(word) || CLOSERS.has(word)) return { args: [], inline, xargs, project, generic };
		const values = WRAPPERS[base];
		if (values) {
			if (base === "xargs") xargs = true;
			i++;
			while (i < words.length) {
				const option = words[i] ?? "";
				if (values.has(option)) i += 2;
				else if (option.startsWith("-") || (base === "env" && ASSIGNMENT.test(option))) i++;
				else break;
			}
			// `timeout 5 cmd`, `nice 10 cmd`: a bare number is the wrapper's own value.
			if ((base === "timeout" || base === "nice") && /^\d/.test(words[i] ?? "")) i++;
			continue;
		}
		const run = RUN_WRAPPERS[base];
		if (run && (words[i + 1] === "run" || (base === "bundle" && words[i + 1] === "exec"))) {
			i += 2;
			while (i < words.length && (words[i] ?? "").startsWith("-")) i += run.has(words[i] ?? "") ? 2 : 1;
			project = true;
			continue;
		}
		break;
	}
	return { name: words[i], args: words.slice(i + 1), input, inline, xargs, project, generic };
}

function changeDir(cwd: string | undefined, target: string | undefined): string | undefined {
	if (target === undefined || target === "~") return homedir();
	if (cwd === undefined || target === "-" || isDynamic(target)) return undefined;
	return resolve(cwd, expandHome(target));
}

async function locate(word: string, where: Where): Promise<string | undefined> {
	const expanded = expandHome(word);
	if (isAbsolute(expanded)) return (await exists(expanded)) ? expanded : undefined;
	const bases = [where.cwd, where.dir].filter((base): base is string => base !== undefined);
	return firstFile(bases.map((base) => resolve(base, expanded)));
}

async function exists(path: string): Promise<boolean> {
	const file = await readText(path, 1);
	return file.kind !== "absent";
}

async function firstFile(paths: readonly string[]): Promise<string | undefined> {
	for (const path of paths) if (await exists(path)) return path;
	return undefined;
}

type FileRead = { kind: "absent" } | { kind: "other" } | { kind: "binary" } | { kind: "text"; head: string; size: number };

/**
 * The start of a regular text file. It opens without blocking and checks the opened handle, so a FIFO or device,
 * or a file swapped for one after a check, never stalls the scan.
 */
async function readText(path: string, bytes: number): Promise<FileRead> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? { kind: "absent" } : { kind: "other" };
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return { kind: "other" };
		const buffer = Buffer.alloc(Math.min(bytes, Math.max(info.size, 1)));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytesRead);
		if (head.includes(0)) return { kind: "binary" };
		return { kind: "text", head: head.toString("utf8"), size: info.size };
	} catch {
		return { kind: "other" };
	} finally {
		await handle.close();
	}
}

/** The makefile make picks in `dir`, named as it is on disk even where names ignore case. */
async function findMakefile(dir: string): Promise<string | undefined> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const exact = MAKEFILES.find((name) => names.includes(name));
	if (exact) return join(dir, exact);
	return firstFile(MAKEFILES.map((name) => join(dir, name)));
}

function isShellScript(path: string, text: string): boolean {
	if (SHELL_EXTENSIONS.has(extname(path).toLowerCase())) return true;
	const first = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
	return /^#!.*\b(ba|z|k|da)?sh\b/.test(first);
}

/** A makefile's recipe lines as shell text: the leading tab and `@`, `-`, `+` removed, `$(MAKE)` as `make`. */
function makeRecipes(text: string): string {
	return text
		.split("\n")
		.filter((line) => line.startsWith("\t"))
		.map((line) => line.slice(1).replace(/^[@+-]+/, "").replace(/\$[({]MAKE[)}]/g, "make"))
		.join("\n");
}

/** Files a makefile includes, named literally. */
function makeIncludes(text: string): string[] {
	const files: string[] = [];
	for (const line of text.split("\n")) {
		const match = /^-?s?include[ \t]+(.+)$/.exec(line);
		if (match?.[1]) for (const file of match[1].trim().split(/[ \t]+/)) if (file && !file.includes("$") && !/[*?[]/.test(file)) files.push(file);
	}
	return files;
}

/**
 * Script files the command runs, read for the check, and what it runs that could not be read. Secret files
 * (secret_drop's registry and staging) are never read; every text read is redacted.
 */
export async function findScripts(command: string, cwd: string, isSecret: (canonical: string) => boolean, redact: Redact = keep): Promise<ScriptScan> {
	return new Scanner(cwd, isSecret, redact).run(command);
}
