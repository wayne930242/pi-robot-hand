/**
 * What a handed-over shell command runs, read for the check: the script files it names, the make targets and
 * package scripts it starts, and the shell scripts those run in turn. Everything is read as text and parsed here;
 * nothing is executed, so no target, script, or `-c` string runs to find out what it would do. What the scan cannot
 * read is listed as `unread`, so the user and the check see what was not checked instead of guessing.
 */

import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
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
// Options after which the interpreter runs no code from a file or standard input.
const NO_CODE = new Set(["-v", "-V", "--version", "-h", "--help", "repl"]);
// Interpreter options that take the next word as their value.
const VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-W", "-X", "--env-file", "--env-file-if-exists", "--config", "--tsconfig"]);
const INTERPRETER_VALUE_OPTIONS: Record<string, readonly string[]> = { php: ["-c", "-d", "-z", "-t"], ruby: ["-I", "-C", "-E"] };
// Shell options that take the next word as their value.
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
// Verbs that run install scripts of the package and its dependencies.
const INSTALL_VERBS = new Set([
	"install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
	"ci", "ic", "clean-install", "install-clean", "isntall-clean", "it", "cit", "sit", "install-test", "install-ci-test",
	"rebuild", "rb", "update", "up", "upgrade", "udpate", "link", "ln", "dedupe", "ddp", "import",
]);
// Verbs that run the package's own lifecycle scripts (prepare, prepack, preversion, and the like).
const LIFECYCLE_VERBS = new Set(["publish", "pack", "version"]);
// npm and pnpm options that take the next word as their value.
const PACKAGE_VALUE_OPTIONS = new Set(["--loglevel", "--registry", "--cache", "--userconfig", "--globalconfig", "--tag", "--access", "--otp", "--reporter", "--script-shell", "--node-options", "--include", "--omit", "--config"]);
const RUN_VERBS = new Set(["run", "run-script", "rum", "urn"]);
const NPM_LIFECYCLE: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const PACKAGE_EXEC = new Set(["exec", "x", "dlx"]);
const PACKAGE_DIR_OPTIONS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const WORKSPACE_OPTIONS = new Set(["-w", "--workspace", "--workspaces", "-ws", "--filter", "-F", "-r", "--recursive"]);
const WORKSPACE_FLAGS = new Set(["--workspaces", "-ws", "-r", "--recursive"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);
const TASK_RUNNERS = new Set(["just", "task", "rake", "invoke", "poe", "nox", "tox", "gradle", "gradlew", "mvn", "mvnw"]);
// Tools that run the project's own code (tests, build scripts) or a package's build code: all their verbs, or these.
const CODE_RUNNERS: Record<string, readonly string[] | undefined> = {
	pytest: undefined, jest: undefined, vitest: undefined, mocha: undefined, phpunit: undefined, rspec: undefined, playwright: ["test"],
	cargo: ["run", "r", "test", "t", "build", "b", "bench", "check", "c", "install"],
	go: ["run", "test", "generate", "install"],
	dotnet: ["run", "test", "build"],
	swift: ["run", "test", "build"],
	pip: ["install"], pip3: ["install"],
};
// git commands that run hooks.
const HOOK_VERBS = new Set(["commit", "push", "merge", "rebase", "pull", "checkout", "switch", "am", "cherry-pick", "revert"]);
// File names that commonly hold credentials: never sent to a checker, even when the command sources or runs them.
const SECRET_FILES = [
	/^\.env(\..*)?$/i,
	/\.env$/i,
	/^\.?(envrc|netrc|npmrc|yarnrc\.yml|pypirc|pgpass|git-credentials|htpasswd|my\.cnf|s3cfg|dockercfg|kubeconfig|auth\.json)$/i,
	// Shell startup files often export API keys.
	/^\.?(bashrc|bash_profile|bash_login|bash_aliases|profile|zshrc|zshenv|zprofile|zlogin|kshrc|mkshrc)$/i,
	/^config\.fish$/i,
	/^(service[-_]?account|gcloud|application_default_credentials|client_secrets?).*\.json$/i,
	/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|ovpn|tfvars|tfstate|ini|cfg|conf|properties)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/i,
];
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
	arch: new Set(["-arch"]),
	setsid: new Set(),
	unbuffer: new Set(),
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
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "coproc"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const LOOPS = new Set(["for", "select", "case"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DOWNLOADS_PACKAGE = "may download and run a package, whose code the check does not read";
const DYNAMIC = "$(…)";
const PROCESS = "<(…)";

/** Options after which an interpreter's code is in the command itself, or a module is named, so there is no file to read. */
function inlineFlags(base: string): readonly string[] {
	if (/^(python|pypy)/.test(base)) return ["-c"];
	if (["node", "nodejs", "bun", "tsx", "ts-node"].includes(base)) return ["-e", "-p", "--eval", "--print"];
	if (base === "perl") return ["-e", "-E"];
	if (base === "php") return ["-r"];
	if (base === "pwsh" || base === "powershell") return ["-c", "-Command", "-command"];
	if (base === "deno") return ["eval", "repl"];
	return ["-e"];
}

/**
 * Markers in `parseCommands`' output, compared by identity: a subshell or command substitution opens or closes,
 * so a `cd` inside it ends with it.
 */
export const SCOPE_OPEN = Object.freeze([]) as unknown as string[];
export const SCOPE_CLOSE = Object.freeze([]) as unknown as string[];
/** Before a command that may not run, or runs in a child: after `||`, in a pipeline or in the background, or inside `if`, a loop, `case`, or `{ … }`. A `cd` there leaves the folder unknown. */
export const UNSURE = Object.freeze([]) as unknown as string[];
/** Substitutions nested past the limit were not parsed. */
export const TOO_DEEP = Object.freeze([]) as unknown as string[];
/** Marks a command after `&&`: a `cd` in it holds for the rest of its list, and leaves the folder unknown after. */
export const CHAINED = Object.freeze([]) as unknown as string[];
const BLOCK_OPENERS = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const BLOCK_CLOSERS = new Set(["fi", "done", "esac", "}"]);

/**
 * Shell words of each simple command in `text`, in order. Quotes are removed; a command substitution
 * (`$(…)`, backticks) or process substitution becomes the placeholder `$(…)` or `<(…)` in its word and its own
 * commands are listed too, between `SCOPE_OPEN` and `SCOPE_CLOSE`, as are a subshell's. Substitutions inside
 * arithmetic, `${…}`, array literals, and unquoted here-documents are listed the same way. A here-document
 * or here-string is the operator `<<<` followed by its text. Comments, `case` patterns, and the operators of
 * `[[ … ]]` are not commands; redirection operators are separate words. It reads the text only: nothing is
 * expanded or run.
 */
export function parseCommands(text: string, nest = 0): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let quoted = false;
	let quote: "'" | '"' | undefined;
	let tag: false | "plain" | "strip" = false;
	const heredocs: Heredoc[] = [];
	// Inside `[[ … ]]`; inside a `case`, and whether a pattern comes next; open subshells; open compound commands.
	let test = false;
	let cases = 0;
	let pattern = false;
	let subshells = 0;
	let blocks = 0;
	// Whether the command's first word is a reserved word: only unquoted words are.
	let keyword = false;
	// The operator before the command being read, and whether that command is unsure.
	let before = ";";
	let unsure = false;
	// `function NAME` is followed by the body, which may start with a reserved word such as `{`.
	const atCommand = () => {
		let at = 0;
		const skip = () => {
			while (at < words.length && KEYWORDS.has(words[at] ?? "")) at++;
		};
		skip();
		if (keyword && words[at] === "function") {
			if (words.length < at + 2) return false;
			at += 2;
			skip();
		}
		return at === words.length;
	};
	const pushWord = () => {
		if (started) {
			if (tag) {
				// The here-document's text takes the tag's place once its lines are read.
				heredocs.push({ tag: word, strip: tag === "strip", quoted, words, index: words.length });
				tag = false;
				words.push("");
			} else {
				const reserved = !quoted && atCommand();
				if (words.length === 0) keyword = !quoted;
				if (reserved && BLOCK_OPENERS.has(word)) blocks++;
				else if (reserved && BLOCK_CLOSERS.has(word)) blocks = Math.max(0, blocks - 1);
				if (word === "[[" && reserved) test = true;
				else if (word === "]]") test = false;
				if (blocks > 0) unsure = true;
				words.push(word);
				if (word === "in" && words[0] === "case" && keyword && words.length >= 3) {
					out.push(words);
					words = [];
					cases++;
					pattern = true;
				}
			}
		}
		word = "";
		started = false;
		quoted = false;
	};
	/** Ends the command; `after` is the operator that ends it. */
	const flush = (after = ";") => {
		pushWord();
		if (words[0] === "esac" && keyword) cases = Math.max(0, cases - 1);
		const empty = words.length === 0;
		if (!empty) {
			// `||` may skip it; a pipeline or `&` runs it in a child; a compound command may skip or repeat it.
			if (unsure || blocks > 0 || before === "||" || before === "|" || after === "|" || after === "&") out.push(UNSURE);
			// After `&&`, it runs only if the commands before it in the list did; the scan must know where the list ends.
			else if (before === "&&") out.push(CHAINED);
			out.push(words);
		}
		words = [];
		keyword = false;
		unsure = false;
		// A line break after `&&`, `||`, or `|` continues the list.
		if (!empty || after !== ";" || !["&&", "||", "|"].includes(before)) before = after;
	};
	const inner = (code: string, placeholder: string) => {
		if (nest < MAX_NEST * 2) out.push(SCOPE_OPEN, ...parseCommands(code, nest + 1), SCOPE_CLOSE);
		else out.push(TOO_DEEP);
		word += placeholder;
		started = true;
	};
	const within = (code: string) => {
		out.push(...substitutions(code, nest + 1));
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
			quoted = true;
			if (next === undefined || next === "\n") continue;
			if (quote === '"' && !'$`"\\'.includes(next)) word += "\\";
			word += next;
			started = true;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const end = closingParen(text, i + 2);
			// `$(( … ))` is arithmetic, when its inner `(` closes right before the outer: only the substitutions inside it
			// run. Otherwise, as in `$((cmd) )`, it is a substitution holding a subshell.
			if (text[i + 2] === "(" && text[closingParen(text, i + 3) + 1] === ")") {
				within(text.slice(i + 3, end));
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
			within(text.slice(i + 2, end));
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
		if (ch === "$" && text[i + 1] === "'") {
			// `$'…'`: a backslash escapes the quote too, and escapes such as `\x2e` stand for other characters.
			let end = i + 2;
			while (end < text.length && text[end] !== "'") end += text[end] === "\\" ? 2 : 1;
			word += ansiC(text.slice(i + 2, end));
			started = true;
			quoted = true;
			i = end;
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
			quoted = true;
			continue;
		}
		if (ch === "#" && !started) {
			const newline = text.indexOf("\n", i);
			i = (newline < 0 ? text.length : newline) - 1;
			continue;
		}
		if (ch === "(" && text[i + 1] === "(" && !started && atCommand() && arithmetic(text, i + 2)) {
			// `(( … ))` is arithmetic when it closes with `))`; only the substitutions inside it run. `((cmd) )` is two subshells.
			const end = closingParen(text, i + 1);
			within(text.slice(i + 2, end));
			i = end;
			continue;
		}
		if (test && "&|()<>".includes(ch)) {
			pushWord();
			continue;
		}
		if (ch === "(" && started && word.endsWith("=")) {
			// An array literal, `name=(…)`: values, not a command; only the substitutions inside it run.
			const end = closingParen(text, i + 1);
			within(text.slice(i + 1, end));
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
			if (op === "<<" || op === "<<-") {
				tag = op === "<<-" ? "strip" : "plain";
				words.push("<<<");
			} else words.push(op);
			continue;
		}
		if (ch === "\n") {
			flush(";");
			if (heredocs.length > 0) {
				const { end, bodies } = readHeredocs(text, i + 1, heredocs);
				heredocs.forEach((doc, n) => {
					const body = bodies[n] ?? "";
					doc.words[doc.index] = body;
					// The shell expands substitutions in a here-document whose tag is not quoted.
					if (!doc.quoted) within(body);
				});
				heredocs.length = 0;
				i = end - 1;
			}
			continue;
		}
		if (ch === ";" && cases > 0 && (text[i + 1] === ";" || text[i + 1] === "&")) {
			flush(";");
			i++;
			if (text[i + 1] === "&") i++;
			pattern = true;
			continue;
		}
		if (ch === "(") {
			flush(";");
			out.push(SCOPE_OPEN);
			subshells++;
			continue;
		}
		if (ch === ")") {
			flush(";");
			if (subshells > 0) {
				out.push(SCOPE_CLOSE);
				subshells--;
			}
			continue;
		}
		if (";|&".includes(ch)) {
			let op = ch;
			if ((ch === "&" || ch === "|") && text[i + 1] === ch) op += text[++i];
			else if (ch === "|" && text[i + 1] === "&") i++;
			flush(op);
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
	for (; subshells > 0; subshells--) out.push(SCOPE_CLOSE);
	return out;
}

interface Heredoc {
	tag: string;
	strip: boolean;
	quoted: boolean;
	/** The command's words and where its text goes. */
	words: string[];
	index: number;
}

/** The commands of every command substitution in `text`, which is not itself a command (arithmetic, `${…}`, a here-document). */
function substitutions(text: string, nest: number): string[][] {
	const out: string[][] = [];
	if (nest >= MAX_NEST * 2) return /\$\(|`/.test(text) ? [TOO_DEEP] : out;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") i++;
		else if (ch === "$" && text[i + 1] === "(") {
			const end = closingParen(text, i + 2);
			if (text[i + 2] === "(" && text[closingParen(text, i + 3) + 1] === ")") out.push(...substitutions(text.slice(i + 3, end), nest + 1));
			else out.push(SCOPE_OPEN, ...parseCommands(text.slice(i + 2, end), nest + 1), SCOPE_CLOSE);
			i = end;
		} else if (ch === "`") {
			const end = closingTick(text, i + 1);
			out.push(SCOPE_OPEN, ...parseCommands(text.slice(i + 1, end), nest + 1), SCOPE_CLOSE);
			i = end;
		}
	}
	return out;
}

/**
 * The index of the `)` that closes a `(` opened just before `start`, or the text's length. Parentheses in quotes,
 * comments, here-documents, and between `case` and `esac` (where a pattern's `)` closes nothing) do not count.
 */
function closingParen(text: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	let cases = 0;
	const tags: { tag: string; strip: boolean }[] = [];
	const boundary = (at: number) => at < start || /[\s;|&()]/.test(text[at] ?? " ");
	const reserved = (at: number, name: string) => text.startsWith(name, at) && boundary(at - 1) && /[\s;|&()]|^$/.test(text[at + name.length] ?? "");
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = undefined;
		} else if (ch === "\\") i++;
		else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "#" && boundary(i - 1)) {
			const newline = text.indexOf("\n", i);
			i = (newline < 0 ? text.length : newline) - 1;
		} else if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const match = /^<<(-?)[ \t]*(['"]?)([^\s'";|&<>()]+)\2/.exec(text.slice(i));
			if (match?.[3]) {
				tags.push({ tag: match[3], strip: match[1] === "-" });
				i += match[0].length - 1;
			}
		} else if (ch === "\n" && tags.length > 0) {
			i = readHeredocs(text, i + 1, tags.map(({ tag, strip }) => ({ tag, strip, quoted: true, words: [], index: 0 }))).end - 1;
			tags.length = 0;
		} else if (reserved(i, "case") && commandStart(text, i, start)) {
			cases++;
			i += 3;
		} else if (cases > 0 && reserved(i, "esac")) {
			cases--;
			i += 3;
		} else if (cases > 0) continue;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return text.length;
}

/** Whether the word at `at` is where a command starts: after `;`, `&`, `|`, `(`, a line break, or a reserved word. */
function commandStart(text: string, at: number, start: number): boolean {
	let i = at - 1;
	while (i >= start && (text[i] === " " || text[i] === "\t")) i--;
	if (i < start || ";&|(\n".includes(text[i] ?? "")) return true;
	const word = /([\w{!]+)$/.exec(text.slice(Math.max(start, i - 7), i + 1))?.[1];
	return word !== undefined && KEYWORDS.has(word);
}

/**
 * Whether `((` (with `start` after it) is arithmetic: its inner `(` closes right before the outer. One that never
 * closes is a syntax error; it counts as arithmetic, so the rest of the text is not scanned again for each `(`.
 */
function arithmetic(text: string, start: number): boolean {
	const end = closingParen(text, start);
	return end >= text.length || text[end + 1] === ")";
}

/** The characters an ANSI-C quoted string `$'…'` stands for. */
function ansiC(body: string): string {
	const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
	return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (all, escape: string) => {
		const head = escape[0] ?? "";
		if (head === "x" || head === "u" || head === "U") return String.fromCodePoint(Math.min(Number.parseInt(escape.slice(1), 16), 0x10ffff));
		if (/[0-7]/.test(head)) return String.fromCodePoint(Number.parseInt(escape, 8));
		if (head === "c") return String.fromCodePoint((escape.codePointAt(1) ?? 64) & 0x1f);
		return simple[head] ?? all;
	});
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

/** The text of each here-document whose lines start at `start`, and the index after the last one. */
function readHeredocs(text: string, start: number, heredocs: readonly Heredoc[]): { end: number; bodies: string[] } {
	let at = start;
	const bodies: string[] = [];
	for (const { tag, strip } of heredocs) {
		const lines: string[] = [];
		while (at < text.length) {
			const newline = text.indexOf("\n", at);
			const end = newline < 0 ? text.length : newline;
			const line = strip ? text.slice(at, end).replace(/^\t+/, "") : text.slice(at, end);
			at = end + 1;
			if (line === tag) break;
			lines.push(line);
		}
		bodies.push(lines.join("\n"));
	}
	return { end: Math.min(at, text.length), bodies };
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
	// `named`: seen as a plain argument and not read, so a later command that runs it reads it; `done`: read or reported.
	private readonly files = new Map<string, "named" | "done">();
	// The text of each file read, as read, for a later `source` of the same file.
	private readonly texts = new Map<string, string>();
	private readonly reported = new Set<string>();
	private readonly queue: { text: string; where: Where }[] = [];
	private readonly top: string;
	private readonly isSecret: (canonical: string) => boolean;
	private readonly redact: Redact;
	private readonly redactKnown: Redact;

	constructor(cwd: string, isSecret: (canonical: string) => boolean, redact: Redact) {
		this.top = resolve(cwd);
		this.isSecret = isSecret;
		this.redactKnown = redact;
		// Everything the scan sends or shows passes here: secret_drop's values, then anything else that looks like one.
		this.redact = (text) => maskSecrets(redact(text));
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

	/** Scans shell text. `inPlace` (for `eval`) lets a `cd` in it change `where`, as in the shell that runs it. */
	private async text(text: string, where: Where, nest: number, inPlace = false): Promise<void> {
		const at = inPlace ? where : { ...where };
		// A `cd` inside a subshell or substitution ends with it. One after `&&` holds to the end of its list (`tentative`),
		// and after that the folder is unknown: the list may have stopped before it.
		const outer: { cwd: string | undefined; tentative: boolean }[] = [];
		let unsure = false;
		let chained = false;
		let tentative = false;
		for (const words of parseCommands(text)) {
			if (words === SCOPE_OPEN) {
				outer.push({ cwd: at.cwd, tentative });
				tentative = false;
			} else if (words === SCOPE_CLOSE) {
				const saved = outer.pop();
				if (saved) ({ cwd: at.cwd, tentative } = saved);
			} else if (words === UNSURE) unsure = true;
			else if (words === CHAINED) chained = true;
			else if (words === TOO_DEEP) this.note("skipped", text, `has command substitutions nested more than ${MAX_NEST * 2} levels deep`, "\0deep");
			else {
				if (!chained && tentative) {
					at.cwd = undefined;
					tentative = false;
				}
				const cwd = at.cwd;
				await this.command(words, at, nest, unsure);
				if (chained && at.cwd !== cwd) tentative = true;
				unsure = false;
				chained = false;
			}
		}
		if (tentative) at.cwd = undefined;
	}

	private async command(all: string[], where: Where, nest: number, unsure = false): Promise<void> {
		const { name, args, assigns, input, inline, xargs, project, generic } = splitCommand(all);
		const line = all.join(" ");
		for (const assign of assigns) await this.preload(assign, line, where);
		// `export NODE_OPTIONS=…` sets a preload for the commands after it.
		if (name === "export" || name === "declare" || name === "typeset") {
			for (const arg of args) if (ASSIGNMENT.test(arg)) await this.preload(arg, line, where);
		}
		if (name === undefined) {
			await this.generic(generic, where);
			return;
		}
		const base = basename(name);
		if (name === "cd" || name === "pushd" || name === "popd") {
			const target = args.find((arg) => !arg.startsWith("-"));
			// A `cd` that may not run, or runs in a child, leaves the folder unknown; so do `popd` and a bare `pushd`.
			where.cwd = unsure || name === "popd" || (name === "pushd" && target === undefined) ? undefined : changeDir(where.cwd, target);
			return;
		}
		if (isDynamic(name)) {
			// In a makefile, `$(CC)` names a tool on PATH; any other variable or a path built from one is set at runtime.
			if (where.mode === "shell" || !MAKE_TOOLS.test(name)) this.note("indirect", line, `runs a command whose name is set at runtime (${name})`, name);
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
		} else if (Object.hasOwn(CODE_RUNNERS, base)) {
			const verbs = CODE_RUNNERS[base];
			const verb = args.find((arg) => !arg.startsWith("-"));
			if (verbs === undefined || (verb !== undefined && verbs.includes(verb))) this.note("indirect", line, "runs code from the project, or from packages it builds or installs, which the check does not read");
		} else if (base === "git") {
			await this.git(args, assigns, line, where);
		} else if (base === "find") {
			// `-exec cmd {} ;` and the like run a command for each file found.
			for (let i = 0; i < args.length; i++) {
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i] ?? "")) continue;
				const end = args.findIndex((arg, j) => j > i && (arg === ";" || arg === "+"));
				await this.command(args.slice(i + 1, end < 0 ? args.length : end), where, nest);
				i = end < 0 ? args.length : end;
			}
		} else if (base === "eval") {
			// An `eval` that may not run changes the folder only maybe: unknown after it.
			await this.code(args.join(" "), "eval", line, where, nest, !unsure);
			if (unsure && CHANGES_DIR.test(args.join(" "))) where.cwd = undefined;
		} else if (name.includes("/") || (project && SCRIPT_EXTENSIONS.has(extname(name).toLowerCase()))) {
			await this.runs(name, line, where, false);
		}
		await this.generic(generic, where);
	}

	/**
	 * A string run as shell code (`sh -c`, `eval`, a here-document): scanned like the command, or reported when built
	 * at runtime. `inPlace`: it runs in the current shell (`eval`), so its `cd` counts.
	 */
	private async code(code: string | undefined, how: string, line: string, where: Where, nest: number, inPlace = false): Promise<void> {
		if (code === undefined || onlyDynamic(code)) {
			if (where.mode === "shell" || code === undefined) this.note("indirect", line, `${how} runs code built at runtime`);
			return;
		}
		if (nest >= MAX_NEST) {
			this.note("skipped", line, `shell code nested more than ${MAX_NEST} levels deep`);
			return;
		}
		await this.text(code, where, nest + 1, inPlace);
	}

	/** An environment assignment that makes a program run a file first: `BASH_ENV`, `ENV`, `NODE_OPTIONS`, and the like. */
	private async preload(assign: string, line: string, where: Where): Promise<void> {
		const at = assign.indexOf("=");
		const key = assign.slice(0, at).replace(/\+$/, "");
		const value = assign.slice(at + 1);
		if (!value) return;
		if (key === "BASH_ENV" || key === "ENV" || key === "PYTHONSTARTUP") await this.runs(value, line, where, key !== "PYTHONSTARTUP");
		else if (key === "NODE_OPTIONS") {
			const words = value.split(/\s+/).filter(Boolean);
			for (let i = 0; i < words.length; i++) {
				const [option = "", attached] = splitOption(words[i] ?? "");
				if (NODE_PRELOADS.has(option)) await this.preloadFile(attached ?? words[++i], line, where);
			}
		} else if (key === "PERL5OPT" || key === "RUBYOPT") this.note("indirect", line, `${key} may load code the check does not read`);
	}

	/** A file an interpreter loads before the program (`--require ./x.js`); a package name is judged by its name. */
	private async preloadFile(value: string | undefined, line: string, where: Where): Promise<void> {
		if (value === undefined) return;
		if (isDynamic(value) || /^[./~]/.test(value) || SCRIPT_EXTENSIONS.has(extname(value).toLowerCase())) await this.runs(value, line, where, false);
	}

	private async shell(name: string, args: string[], input: string | undefined, inline: string | undefined, xargs: boolean, line: string, where: Where, nest: number): Promise<void> {
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
				const text = await this.runs(arg, line, where, true);
				// `source` runs the file in this shell: a `cd` in it, or a file the scan could not read, leaves the folder unknown.
				if ((name === "source" || name === ".") && (text === undefined || CHANGES_DIR.test(text))) where.cwd = undefined;
				return;
			}
		}
		// A here-document or here-string fed to a shell is shell code: scan it like the command.
		if (inline !== undefined) await this.code(inline, `${basename(name)} <<`, line, where, nest);
		else await this.stdin(input, xargs, line, where, true);
	}

	private async interpreter(base: string, args: string[], input: string | undefined, inline: string | undefined, xargs: boolean, line: string, where: Where): Promise<void> {
		// Bare `bun` prints its help.
		if (base === "bun" && args.length === 0) return;
		if (base === "bun" && args[0] !== undefined && !args[0].startsWith("-") && !SCRIPT_EXTENSIONS.has(extname(args[0]).toLowerCase()) && !args[0].includes("/")) {
			await this.packageManager(base, args, line, where);
			return;
		}
		const values = INTERPRETER_VALUE_OPTIONS[base] ?? [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			const [option = "", attached] = splitOption(arg);
			// Files loaded before the program: `--require=./x.js`, `-r ./x.js`, `ruby -r./x.rb`.
			if (NODE_PRELOADS.has(option) && base !== "ruby" && base !== "perl" && !/^(python|pypy)/.test(base)) {
				await this.preloadFile(attached ?? args[++i], line, where);
				continue;
			}
			if (base === "ruby" && arg.startsWith("-r")) {
				await this.preloadFile(arg.length > 2 ? arg.slice(2) : args[++i], line, where);
				continue;
			}
			if (base === "php" && arg === "-d") {
				const setting = /^auto_(?:prepend|append)_file=(.+)$/.exec(args[++i] ?? "");
				if (setting?.[1]) await this.runs(setting[1], line, where, false);
				continue;
			}
			if (attached !== undefined && option.startsWith("--")) continue;
			if (inlineFlags(base).includes(arg) || NO_CODE.has(arg)) return;
			if (arg === "--test") {
				this.note("indirect", line, "runs the test files it finds, which the check does not read");
				return;
			}
			if (arg === "-m" && /^(python|pypy)/.test(base)) {
				await this.module(args[i + 1], args.slice(i + 2), line, where);
				return;
			}
			// `-` reads the program from standard input; what follows are its arguments.
			if (arg === "-") break;
			if (base === "deno" && arg === "task") {
				this.note("indirect", line, "deno task runs tasks defined in deno.json, which the check does not read");
				return;
			}
			if (VALUE_OPTIONS.has(arg) || values.includes(arg)) i++;
			else if (arg.startsWith("-")) continue;
			else if (base === "deno" && ["run", "test", "bench", "compile"].includes(arg)) continue;
			else if (base === "bun" && arg === "run") continue;
			else {
				await this.runs(arg, line, where, false);
				return;
			}
		}
		// A here-document fed to an interpreter is code written in the command itself.
		if (inline === undefined) await this.stdin(input, xargs, line, where, false);
	}

	/** `python -m name`: a module in the folder it runs in is read; an installed one is judged by its name, like a command on PATH. */
	private async module(name: string | undefined, rest: string[], line: string, where: Where): Promise<void> {
		if (name === undefined || isDynamic(name)) {
			this.note("indirect", line, "runs a module named at runtime");
			return;
		}
		const top = name.split(".")[0] ?? "";
		// `python -m pytest` runs the project's code as `pytest` does; `-m pip install` runs its build.
		const verbs = CODE_RUNNERS[top];
		const verb = rest.find((arg) => !arg.startsWith("-"));
		if ((Object.hasOwn(CODE_RUNNERS, top) && (verbs === undefined || (verb !== undefined && verbs.includes(verb)))) || top === "unittest" || top === "nose2" || top === "build") {
			this.note("indirect", line, "runs code from the project, or from packages it builds or installs, which the check does not read");
			return;
		}
		if (where.cwd === undefined || !/^[\w.]+$/.test(name)) return;
		const path = join(where.cwd, ...name.split("."));
		const found = await firstFile([`${path}.py`, join(path, "__main__.py")]);
		if (found) await this.read(found, { shown: this.shown(found), runs: true, cwd: where.cwd, depth: where.depth + 1 });
	}

	/** An interpreter given no file reads its code from standard input or a redirected file. */
	private async stdin(input: string | undefined, xargs: boolean, line: string, where: Where, shell: boolean): Promise<void> {
		if (input !== undefined) {
			await this.runs(input, line, where, shell);
			return;
		}
		if (xargs) this.note("indirect", line, "runs files named on standard input, which the check does not see");
		else this.note("indirect", line, where.downloads ? "runs code from standard input, which may be what the command downloads" : "runs code from standard input, which the check does not see");
	}

	/** A file the command runs: read it, or report why not. Returns its text when the scan has it, sent or not. */
	private async runs(word: string, line: string, where: Where, shell: boolean): Promise<string | undefined> {
		if (word.includes(PROCESS)) {
			this.note("indirect", line, "runs the output of another command as code");
			return undefined;
		}
		if (isDynamic(word)) {
			if (where.mode === "shell" || !MAKE_TOOLS.test(word)) this.note("indirect", short(word), "runs a path set at runtime");
			return undefined;
		}
		if (/[*?[]/.test(word)) {
			this.note("indirect", word, "runs the files that match this pattern, which the check does not read");
			return undefined;
		}
		const path = await locate(word, where);
		if (path === undefined) {
			if (where.cwd === undefined && !isAbsolute(expandHome(word))) this.note("indirect", word, "is relative to a folder set at runtime");
			else this.note("missing", word, "does not exist");
			return undefined;
		}
		return this.read(path, { shown: word, runs: true, shell, cwd: where.cwd, depth: where.depth + 1 });
	}

	/** Words that name an existing script file, wherever they stand: read them, but never report a missing one. */
	private async generic(words: readonly string[], where: Where): Promise<void> {
		for (const word of words) {
			if (!word || word.startsWith("-") || word.includes("=") || isDynamic(word) || /^[<>&|0-9;+{}]+$/.test(word)) continue;
			const base = isAbsolute(expandHome(word)) ? "/" : where.cwd;
			if (base === undefined) continue;
			await this.read(canonicalPath(word, base), { shown: word, runs: false, cwd: where.cwd, depth: where.depth + 1 });
		}
	}

	/**
	 * Reads a file the command names or runs, sends it when it is a script, and returns its text (as read, not
	 * redacted) for the scan's own use. A file that may hold secrets is read only here, never sent: the scan still
	 * reports a `cd` or commands in it. A file secret_drop protects is never read.
	 */
	private async read(path: string, how: Read): Promise<string | undefined> {
		const canonical = canonicalPath(path, "/");
		const seen = this.files.get(canonical);
		if (seen === "done" || (seen === "named" && !how.runs)) return this.texts.get(canonical);
		const named = () => void this.files.set(canonical, "named");
		this.files.set(canonical, "done");
		if (this.isSecret(canonical)) {
			if (how.runs) this.note("missing", how.shown, "secret_drop protects it, so it is never sent");
			else named();
			return undefined;
		}
		if (secretLike(canonical)) {
			if (!how.runs) {
				named();
				return undefined;
			}
			this.note("missing", how.shown, "may hold secrets, so it is not sent");
			const kept = await readText(canonical, MAX_SCRIPT_BYTES);
			if (kept.kind !== "text") return undefined;
			// Past the part read, it may run anything: say so, and let a `source` of it leave the folder unknown.
			const whole = kept.size <= MAX_SCRIPT_BYTES;
			if (!how.make && (!whole || !onlyAssignments(kept.head))) this.note("indirect", how.shown, "runs commands from a file that may hold secrets, which the check does not see");
			if (!whole) return undefined;
			this.texts.set(canonical, kept.head);
			return kept.head;
		}
		const ext = extname(canonical).toLowerCase();
		const byName = how.runs || how.make || how.shell || SCRIPT_EXTENSIONS.has(ext) || MAKEFILES.includes(basename(canonical));
		// Two bytes tell a `#!` script from any other file, so a long list of plain files costs little.
		let file = await readText(canonical, byName ? MAX_SCRIPT_BYTES + REDACT_MARGIN : 2);
		if (file.kind !== "text") {
			if (!how.runs) named();
			else if (file.kind === "absent") this.note("missing", how.shown, "does not exist");
			else if (file.kind === "other") this.note("missing", how.shown, "is not a regular file");
			// A compiled program on the system is judged by its name, like any command on PATH.
			else if (!isAbsolute(expandHome(how.shown))) this.note("missing", how.shown, "is a binary file, not text");
			return undefined;
		}
		if (!byName && !file.head.startsWith("#!")) {
			named();
			return undefined;
		}
		// A script a nested script merely names is read when there is room, and left out silently when not.
		const report = how.runs || how.depth === 1;
		if (how.depth > MAX_DEPTH) {
			if (report) this.note("skipped", how.shown, `is nested more than ${MAX_DEPTH} levels deep`);
			return undefined;
		}
		if (this.scripts.length >= MAX_SCRIPTS) {
			if (report) this.note("skipped", how.shown, `is past the ${MAX_SCRIPTS}-file limit`);
			return undefined;
		}
		if (!byName) file = await readText(canonical, MAX_SCRIPT_BYTES + REDACT_MARGIN);
		if (file.kind !== "text") return undefined;
		// Redact the whole read first, then cut in bytes, so the cut never splits a secret the margin holds whole.
		const redacted = maskSecrets(this.redactKnown(file.head), (name) =>
			this.note("indirect", how.shown, `sets ${name} to a value that may be code; it was masked as a possible secret, so the check does not see it`, `${how.shown}\0${name}`),
		);
		const text = cutBytes(redacted, MAX_SCRIPT_BYTES);
		const truncated = file.size > MAX_SCRIPT_BYTES || text.length < redacted.length;
		this.scripts.push({ path: canonical, text, truncated });
		if (truncated) this.note("truncated", how.shown, `only the first ${size(MAX_SCRIPT_BYTES)} of ${size(Math.max(file.size, Buffer.byteLength(redacted)))} were read`);
		// The scan parses the text as read (the part that was sent), so masking a value cannot hide a command.
		const raw = cutBytes(file.head, MAX_SCRIPT_BYTES);
		this.texts.set(canonical, raw);
		const where: Where = { cwd: how.cwd, dir: dirname(canonical), depth: how.depth, mode: "shell", downloads: DOWNLOADERS.test(raw) };
		if (how.make || MAKEFILES.includes(basename(canonical))) {
			const make = makefile(raw);
			if (make.functions) this.note("indirect", how.shown, "uses make functions (define, call, eval) the check does not expand");
			for (const include of make.includes) {
				if (include.includes("$") || /[*?[]/.test(include)) this.note("indirect", include, "is a makefile included from a path set at runtime");
				else await this.read(resolve(how.cwd ?? dirname(canonical), expandHome(include)), { shown: include, runs: true, make: true, cwd: how.cwd, depth: how.depth });
			}
			this.queue.push({ text: make.shell, where: { ...where, mode: "make" } });
		} else if (how.shell || isShellScript(canonical, raw)) {
			this.queue.push({ text: raw, where });
		}
		return raw;
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
			} else if (PACKAGE_VALUE_OPTIONS.has(option)) {
				if (attached === undefined) i++;
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
		if (LIFECYCLE_VERBS.has(verb)) {
			this.note("indirect", line, "runs the package's lifecycle scripts (prepare, prepack, and the like), which the check does not read");
			return;
		}
		if (PACKAGE_EXEC.has(verb) || verb === "create" || (verb === "init" && pm === "npm" && next !== undefined)) {
			// `pnpm exec` and `yarn exec` run only an installed binary.
			if (!(verb === "exec" && (pm === "pnpm" || pm === "yarn"))) this.note("indirect", line, DOWNLOADS_PACKAGE);
			return;
		}
		if (pm === "yarn" && (verb === "workspace" || verb === "workspaces")) {
			this.note("indirect", line, "runs a command in workspace packages, which the check does not read");
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
		// `bun test` with no `test` script is bun's own test runner, which runs the project's test files.
		if (!found && !explicit && pm === "bun" && verb === "test") this.note("indirect", line, "runs the test files it finds, which the check does not read");
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
		this.files.set(key, "done");
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
		const whole = values.map(([key, value]) => `${key}: ${value}`).join("\n");
		const text = cutBytes(whole, MAX_SCRIPT_BYTES);
		this.scripts.push({ path, entry: this.redact(`scripts.${name}`), text, truncated: text.length < whole.length });
		for (const [, value] of values) this.queue.push({ text: value, where: { cwd: dir, dir, depth, mode: "shell", downloads: DOWNLOADERS.test(value) } });
		return true;
	}

	/**
	 * git commands that run hooks, and aliases that run a shell command: reported when the repository or the user's
	 * git config sets them up. Config files are matched here and never sent: they can hold credentials in URLs.
	 */
	private async git(args: string[], assigns: string[], line: string, where: Where): Promise<void> {
		let dir = where.cwd;
		let verb: string | undefined;
		const settings: string[] = [];
		// Config the scan cannot see: `--config-env` and the GIT_CONFIG_* variables.
		let hidden = assigns.some((assign) => /^GIT_CONFIG(_\w+)?=/.test(assign));
		for (let i = 0; i < args.length && verb === undefined; i++) {
			const arg = args[i] ?? "";
			if (arg === "-C") dir = changeDir(dir, args[++i]);
			else if (arg === "-c") settings.push(args[++i] ?? "");
			else if (arg === "--config-env" || arg.startsWith("--config-env=")) {
				hidden = true;
				if (arg === "--config-env") i++;
			}
			else if (arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--exec-path") {
				if (arg === "--git-dir" || arg === "--exec-path") dir = undefined;
				i++;
			} else if (arg.startsWith("--git-dir=") || arg.startsWith("--exec-path=")) dir = undefined;
			else if (!arg.startsWith("-")) verb = arg;
		}
		if (assigns.some((assign) => /^(GIT_DIR|GIT_COMMON_DIR|GIT_CONFIG\w*|GIT_EXEC_PATH)=/.test(assign))) dir = undefined;
		if (verb === undefined) return;
		if (hidden) this.note("indirect", line, "takes git config set at runtime (GIT_CONFIG_* or --config-env), which may run commands the check does not read");
		if (settings.some((setting) => COMMAND_SETTING.test(setting))) this.note("indirect", line, "sets git config on the command line that runs a command, which the check does not read");
		const configs = await gitConfigs(dir);
		for (const setting of configs === undefined ? [] : gitCommands(configs, NETWORK_VERBS.has(verb))) {
			this.note("indirect", line, `runs a command git config sets (${setting}), which the check does not read`);
		}
		// Which alias git would run, and through which others, is not worked out: git splits and unquotes values in ways
		// the scan does not reproduce. When the command names an alias, every alias the config defines counts: any `!`
		// in one is a shell command, and a hook verb anywhere in one may run hooks.
		const fromLine = settings
			.filter((setting) => /^alias\.[^=]+=/i.test(setting))
			.map((setting) => ({ name: setting.slice(6, setting.indexOf("=")).replace(/\.command$/i, "").toLowerCase(), value: setting.slice(setting.indexOf("=") + 1) }));
		const aliases = [...fromLine, ...(configs === undefined ? [] : gitAliases(configs))];
		// The hook verbs the command may run as: its own, or any an alias may reach.
		const effective = new Set<string>(HOOK_VERBS.has(verb) ? [verb] : []);
		if (aliases.some(({ name }) => name === verb.toLowerCase())) {
			if (aliases.some(({ value }) => value.includes("!"))) {
				this.note("indirect", line, `runs the git alias ${JSON.stringify(verb)}; the git config has aliases that run a shell command, which the check does not read`);
				return;
			}
			// A hook verb is looked for in each value with every character but letters removed, so no mix of escapes and
			// quotes hides it; `am`, too short for that, as a word in three readings (escapes as breaks, quotes and
			// backslashes removed, and both).
			const letters = aliases.map(({ value }) => value.toLowerCase().replace(/[^a-z]/g, ""));
			const readings = aliases.flatMap(({ value }) => [
				value.replace(/\\./g, " "),
				value.replace(/["'\\]/g, ""),
				value.replace(/\\(.)/g, (_all, char: string) => (/[ntb]/.test(char) ? " " : char)).replace(/["'\\]/g, ""),
			]);
			for (const hook of HOOK_VERBS) {
				if (hook === "am" ? readings.some((reading) => AM_WORD.test(reading)) : letters.some((each) => each.includes(hook.replace(/-/g, "")))) effective.add(hook);
			}
		}
		if (effective.size === 0) return;
		if (settings.some((setting) => /^core\.hookspath=/i.test(setting))) {
			this.note("indirect", line, "runs git hooks from a folder set on the command line, which the check does not read");
			return;
		}
		if (dir === undefined || configs === undefined) {
			this.note("indirect", line, "may run git hooks of a repository set at runtime, which the check does not read");
			return;
		}
		if (configs.some((config) => gitEntries(config).some(({ section, key }) => section === "core" && key === "hookspath"))) {
			this.note("indirect", line, "runs git hooks (from core.hooksPath), which the check does not read");
			return;
		}
		// `--no-verify` skips only the hooks that could stop the command; the others still run.
		const skipped = args.includes("--no-verify") || (effective.size === 1 && effective.has("commit") && args.includes("-n")) ? NO_VERIFY_HOOKS : new Set<string>();
		const hooks = ((await gitHooks(dir)) ?? []).filter((hook) => !skipped.has(hook));
		if (hooks.length > 0) this.note("indirect", line, `runs git hooks (${hooks.join(", ")}), which the check does not read`);
	}
}

interface Command {
	/** The command word after assignments, keywords, and wrappers; undefined for a segment that runs nothing to read. */
	name?: string;
	/** Its arguments, redirections removed. */
	args: string[];
	/** Environment assignments for the command, before it or after `env`. */
	assigns: string[];
	/** The file standard input comes from (`< file`). */
	input?: string;
	/** The text of a here-document or here-string fed to standard input. */
	inline?: string;
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
	let inline: string | undefined;
	for (let i = 0; i < all.length; i++) {
		const word = all[i] ?? "";
		if (/^(<|>|>>|<>|>\||&>|&>>|<&|>&)$/.test(word)) {
			const target = all[++i];
			if (word === "<" && target !== undefined) input = target;
		} else if (word === "<<<") inline = all[++i] ?? "";
		else words.push(word);
	}
	const generic = words.filter((word) => !ASSIGNMENT.test(word));
	let i = 0;
	let xargs = false;
	let project = false;
	const assigns: string[] = [];
	while (i < words.length) {
		const word = words[i] ?? "";
		const base = basename(word);
		if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
			if (ASSIGNMENT.test(word)) assigns.push(word);
			i++;
			continue;
		}
		// `function name {`: the body follows.
		if (word === "function") {
			i += 2;
			continue;
		}
		if (LOOPS.has(word) || CLOSERS.has(word)) return { args: [], assigns, inline, xargs, project, generic };
		const values = WRAPPERS[base];
		if (values && Object.hasOwn(WRAPPERS, base)) {
			if (base === "xargs") xargs = true;
			i++;
			while (i < words.length) {
				const option = words[i] ?? "";
				if (values.has(option)) i += 2;
				else if (base === "env" && ASSIGNMENT.test(option)) {
					assigns.push(option);
					i++;
				} else if (option.startsWith("-")) i++;
				else break;
			}
			// `timeout 5 cmd`, `nice 10 cmd`: a bare number is the wrapper's own value.
			if ((base === "timeout" || base === "nice") && /^\d/.test(words[i] ?? "")) i++;
			continue;
		}
		const run = Object.hasOwn(RUN_WRAPPERS, base) ? RUN_WRAPPERS[base] : undefined;
		if (run && (words[i + 1] === "run" || (base === "bundle" && words[i + 1] === "exec"))) {
			i += 2;
			while (i < words.length && (words[i] ?? "").startsWith("-")) i += run.has(words[i] ?? "") ? 2 : 1;
			project = true;
			continue;
		}
		break;
	}
	return { name: words[i], args: words.slice(i + 1), assigns, input, inline, xargs, project, generic };
}

function changeDir(cwd: string | undefined, target: string | undefined): string | undefined {
	if (target === undefined || target === "~") return homedir();
	if (cwd === undefined || target === "-" || isDynamic(target)) return undefined;
	return resolve(cwd, expandHome(target));
}

// Options that load a file before the program: node, bun, deno, tsx.
const NODE_PRELOADS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--preload"]);
// A `cd`, `pushd`, or `popd` anywhere in a text, or a `source` of another file that may hold one.
const CHANGES_DIR = /(^|[\s;&|(`{])(cd|pushd|popd|source|\.)(\s|;|$)/m;

/** `--name=value` as its name and value; any other word as itself. */
function splitOption(word: string): [string, string | undefined] {
	const at = word.indexOf("=");
	return word.startsWith("--") && at > 0 ? [word.slice(0, at), word.slice(at + 1)] : [word, undefined];
}

/** Whether a text holds only comments and literal assignments, as an env file does: nothing that runs. */
function onlyAssignments(text: string): boolean {
	return text.split("\n").every((line) => /^\s*(#.*)?$/.test(line) || /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=('[^']*'|"[^"$`\\]*"|[^\s'"$`;&|()<>\\]*)\s*(#.*)?$/.test(line));
}

/** A name that commonly holds credentials, such as an env file, a key, or a config file. */
function secretLike(path: string): boolean {
	const name = basename(path);
	if (SECRET_FILES.some((pattern) => pattern.test(name))) return true;
	// Whatever its extension: `secrets.sh` and `token.py` are as likely to hold one as `secrets.txt`.
	return /(^|[._-])(secrets?|credentials?|creds|passw(or)?ds?|passwd|tokens?|api[_-]?keys?)([._-]|$)/i.test(name);
}

// A name and its literal value, in `NAME=value`, `NAME: value`, or `"name": "value"`. Whether the name is a
// credential's is decided in code, and the name is bounded, so matching stays linear in the text.
const ASSIGNED = /(["']?)\b([A-Za-z_][\w.-]{0,63})\1[ \t]*[:=][ \t]*((?:Bearer|Basic|Token|Digest)[ \t]+[^\s"'`]{1,4096}|"[^"$`\n]*"|'[^'\n]*'|[^\s"'$`;&|()#,}]+)/gi;
// Words of a name that hold a credential (`DB_PASSWORD`, `clientSecret`, `x-api-key`), and words that do with `key`.
const CREDENTIAL_WORDS = new Set(["secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "pwd", "pass", "passphrase", "credential", "credentials", "auth", "authorization", "apikey", "accesskey", "privatekey", "secretkey", "authtoken", "accesstoken", "refreshtoken", "clientsecret"]);
const KEY_PREFIXES = new Set(["api", "access", "private", "secret", "signing", "encryption", "master"]);
// Options that take a credential, and the user:password of curl's `-u`.
const SECRET_OPTION = /(--(?:password|passwd|token|api-key|apikey|secret|auth-token|access-token)(?:[ \t]+|=))("[^"$`\n]*"|'[^'\n]*'|[^\s"'$`;&|()]+)/gi;
const USER_PASSWORD = /((?:^|\s)(?:-u|--user)[ \t]+["']?[^\s:"'$/]{1,256}:)(?!\/\/)([^\s"'@$]{1,256})/g;
const SSHPASS = /(\bsshpass[ \t]+-p[ \t]*)([^\s"'$]+|"[^"$\n]*"|'[^'\n]*')/g;
// Credential formats that are recognizable on their own, private keys, and passwords in URLs (the user may be empty).
const SECRET_VALUES = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,1024}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,1024}|gh[pousr]_[A-Za-z0-9]{20,1024}|github_pat_\w{20,1024}|glpat-[\w-]{20,1024}|npm_[A-Za-z0-9]{36,1024}|xox[abprs]-[\w-]{10,1024}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]{8,2048}\.eyJ[\w-]{8,4096}\.[\w-]{8,2048})|-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,64}PRIVATE KEY-----|$)/g;
const URL_PASSWORD = /(\b[a-z][\w+.-]{0,31}:\/\/[^\s:/@]{0,256}:)[^\s@/]{1,256}@/gi;

/** Whether a name is a credential's, by its words: `API_KEY` and `clientSecret` are; `AUTHOR` and `tokenizer` are not. */
function credentialName(name: string): boolean {
	const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[._-]+/);
	return words.some((word, i) => CREDENTIAL_WORDS.has(word) || (KEY_PREFIXES.has(word) && words[i + 1] === "key"));
}

/**
 * Text with values that look like credentials replaced by `[REDACTED]`: literal values of names such as `API_KEY`
 * or `password`, credential options, known token formats, private keys, and passwords in URLs. secret_drop redacts
 * only the values it knows; this covers files that hold one it never saw. A value built at runtime (`$(…)`, `$VAR`)
 * and a path are kept, so what the command runs stays visible. A value that may be code (a git `!` helper, a
 * `*_COMMAND`, anything with a space) is masked too, and `onCode` gets its name, so the scan can say the check did
 * not see it.
 */
export function maskSecrets(text: string, onCode?: (name: string) => void): string {
	const masked = (value: string) => (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]");
	return text
		.replace(ASSIGNED, (all, _quote: string, name: string, value: string) => {
			if (!credentialName(name)) return all;
			const scheme = /^(Bearer|Basic|Token|Digest)[ \t]+/i.exec(value);
			if (scheme) return `${all.slice(0, all.length - value.length)}${scheme[0]}[REDACTED]`;
			const inner = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
			if (/^(\.{0,2}\/|~\/)[^\s]*$/.test(inner)) return all;
			if (/(cmd|command|helper|hook|process|exec)$/i.test(name) || inner.startsWith("!") || /\s/.test(inner)) onCode?.(name);
			return `${all.slice(0, all.length - value.length)}${masked(value)}`;
		})
		.replace(SECRET_OPTION, (_all, option: string, value: string) => `${option}${masked(value)}`)
		.replace(USER_PASSWORD, "$1[REDACTED]")
		.replace(SSHPASS, (_all, option: string, value: string) => `${option}${masked(value)}`)
		.replace(SECRET_VALUES, "[REDACTED]")
		.replace(URL_PASSWORD, "$1[REDACTED]@");
}

/** The first `bytes` bytes of `text`, without a character cut in half. */
function cutBytes(text: string, bytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= bytes) return text;
	let end = bytes;
	// Back up to the start of a UTF-8 character.
	while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

async function locate(word: string, where: Where): Promise<string | undefined> {
	const expanded = expandHome(word);
	if (isAbsolute(expanded)) return (await exists(expanded)) ? expanded : undefined;
	const bases = [where.cwd, where.dir].filter((base): base is string => base !== undefined);
	return firstFile(bases.map((base) => resolve(base, expanded)));
}

/** Whether something is at `path`; it only asks the file system, so nothing is opened. */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

async function firstFile(paths: readonly string[]): Promise<string | undefined> {
	for (const path of paths) if (await exists(path)) return path;
	return undefined;
}

type FileRead = { kind: "absent" } | { kind: "other" } | { kind: "binary" } | { kind: "text"; head: string; size: number };

/**
 * The start of a regular text file. Anything else (a FIFO, a device, a folder) is never opened, since opening
 * one can release a waiting writer or reset a serial device. The open is non-blocking and the opened handle is
 * checked again, so a file swapped for one of those after the check never stalls the scan.
 */
async function readText(path: string, bytes: number): Promise<FileRead> {
	try {
		if (!(await stat(path)).isFile()) return { kind: "other" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "other" };
	}
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		return { kind: "other" };
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
	const found = await firstFile(MAKEFILES.map((name) => join(dir, name)));
	return found === undefined ? undefined : realpath(found).catch(() => found);
}

const NO_VERIFY_HOOKS = new Set(["pre-commit", "commit-msg", "pre-merge-commit", "pre-push", "pre-rebase", "pre-applypatch", "applypatch-msg"]);

/** The git folder (shared by worktrees) of the repository holding `dir`, or undefined outside one. */
async function gitDir(dir: string): Promise<string | undefined> {
	for (let at = dir; ; at = dirname(at)) {
		const dotGit = join(at, ".git");
		const info = await stat(dotGit).catch(() => undefined);
		if (info) {
			let found = dotGit;
			if (info.isFile()) {
				const pointer = await readText(dotGit, 4_096);
				const target = pointer.kind === "text" ? /^gitdir:\s*(.+)$/m.exec(pointer.head)?.[1] : undefined;
				if (!target) return undefined;
				found = resolve(at, target.trim());
			}
			const common = await readText(join(found, "commondir"), 4_096);
			return common.kind === "text" ? resolve(found, common.head.trim()) : found;
		}
		if (dirname(at) === at) return undefined;
	}
}

/**
 * The texts of the git config files that apply in `dir` (system, user, repository, worktree), for matching only;
 * undefined when `dir` is unknown. A file another one includes is not followed.
 */
async function gitConfigs(dir: string | undefined): Promise<string[] | undefined> {
	if (dir === undefined) return undefined;
	const repo = await gitDir(dir);
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const paths = ["/etc/gitconfig", join(homedir(), ".gitconfig"), join(xdg, "git", "config"), ...(repo ? [join(repo, "config"), join(repo, "config.worktree")] : [])];
	const texts: string[] = [];
	for (const path of paths) {
		const file = await readText(path, 64_000);
		if (file.kind !== "text") continue;
		texts.push(file.head);
		// `[include]` and `[includeIf …]` files, one level deep: they can set hooks and aliases too.
		for (const include of gitIncludes(file.head).slice(0, 8)) {
			const included = await readText(resolve(dirname(path), expandHome(include)), 64_000);
			if (included.kind === "text") texts.push(included.head);
		}
	}
	return texts;
}

/** The `path` values of the `[include]` and `[includeIf …]` sections of a git config text. */
function gitIncludes(config: string): string[] {
	return gitEntries(config)
		.filter(({ section, key }) => (section === "include" || section === "includeif") && key === "path")
		.map(({ value }) => value);
}

/**
 * The entries of a git config text, as section (lower case, without a subsection), key (lower case), and value
 * (outer quotes removed). As git reads it: a subsection may hold escaped quotes (`[filter "a\"b"]`), the old
 * `[section.sub]` form names `section`, an entry may follow its header on the same line, and CRLF ends a line.
 * Whether a trailing backslash continues a line depends on quotes and comments; rather than decide, the text is
 * read both ways and the entries of both kept, so a setting either reading finds is reported.
 */
function gitEntries(config: string): GitEntry[] {
	const text = config.replace(/\r\n/g, "\n");
	const joined = text.replace(/(?<!\\)((?:\\\\)*)\\\n/g, "$1");
	return joined === text ? gitLines(text) : [...gitLines(text), ...gitLines(joined)];
}

function gitLines(text: string): GitEntry[] {
	const entries: GitEntry[] = [];
	let section = "";
	let sub = "";
	for (const line of text.split("\n")) {
		const header = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\s*\]/.exec(line);
		if (header) {
			const [name = "", ...rest] = (header[1] ?? "").split(".");
			section = name.toLowerCase();
			sub = header[2]?.replace(/\\(.)/g, "$1") ?? rest.join(".");
		}
		const entry = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(header ? line.slice(header[0].length) : line);
		if (entry) entries.push({ section, sub, key: (entry[1] ?? "").toLowerCase(), value: (entry[2] ?? "").trim().replace(/^"(.*)"$/, "$1") });
	}
	return entries;
}

/** One git config entry: `[section "sub"] key = value`. */
interface GitEntry {
	section: string;
	sub: string;
	key: string;
	value: string;
}

// `-c` settings that make git run a command.
const COMMAND_SETTING = /^(credential\.(?:[^=]*\.)?helper=\s*!|core\.fsmonitor=(?!\s*(?:true|false|yes|no|on|off|0|1)?\s*$)|core\.sshcommand=|filter\.[^=]*\.(?:smudge|clean|process)=|diff\.[^=]*\.textconv=|merge\.[^=]*\.driver=)/i;
// `am` as a git verb in an alias value: a word, with no letter or `-` beside it.
const AM_WORD = /(^|[^a-z-])am($|[^a-z-])/i;
// git commands that talk to a remote, which use credential helpers and the ssh command.
const NETWORK_VERBS = new Set(["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"]);

/**
 * Settings in git config texts that make git run a command: a shell credential helper (`!…`) and `core.sshCommand`
 * (for commands that talk to a remote), `core.fsmonitor` set to a program, and filter, diff, and merge drivers.
 * git-lfs's filter and a plain `ssh …` command are left out, as programs judged by their names.
 */
function gitCommands(configs: readonly string[], network: boolean): string[] {
	const found = new Set<string>();
	for (const config of configs) {
		for (const { section, key, value } of gitEntries(config)) {
			if (network && section === "credential" && key === "helper" && value.startsWith("!")) found.add("credential.helper");
			else if (network && section === "core" && key === "sshcommand" && !/^ssh(\s|$)/.test(value)) found.add("core.sshCommand");
			else if (section === "core" && key === "fsmonitor" && !/^(true|false|yes|no|on|off|0|1)?$/i.test(value)) found.add("core.fsmonitor");
			else if (section === "filter" && ["smudge", "clean", "process"].includes(key) && !/^git-lfs (clean|smudge|filter-process)( -- %f)?$/.test(value)) found.add(`filter ${key}`);
			else if ((section === "diff" && key === "textconv") || (section === "merge" && key === "driver")) found.add(`${section}.${key}`);
		}
	}
	return [...found];
}

/** Every alias in git config texts, in either reading of each: `alias.<name>`, or `[alias "<name>"] command = …`. */
function gitAliases(configs: readonly string[]): { name: string; value: string }[] {
	const found: { name: string; value: string }[] = [];
	for (const config of configs) {
		for (const { section, sub, key, value } of gitEntries(config)) {
			if (section !== "alias") continue;
			if (sub === "") found.push({ name: key, value });
			else if (key === "command") found.push({ name: sub.toLowerCase(), value });
		}
	}
	return found;
}

/** The hooks in the repository holding `dir`, by name. */
async function gitHooks(dir: string): Promise<string[] | undefined> {
	const repo = await gitDir(dir);
	if (repo === undefined) return undefined;
	return (await readdir(join(repo, "hooks")).catch(() => [] as string[])).filter((name) => !name.endsWith(".sample")).sort();
}

function isShellScript(path: string, text: string): boolean {
	if (SHELL_EXTENSIONS.has(extname(path).toLowerCase())) return true;
	const first = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
	return /^#!.*\b(ba|z|k|da)?sh\b/.test(first);
}

// Make variables that name a tool on PATH, judged by name like any command.
const MAKE_TOOLS = /^\$\{(CC|CXX|CPP|LD|AR|AS|FC|RANLIB|STRIP|NM|OBJCOPY|MAKE|RM|CP|MV|MKDIR|INSTALL|LN|ECHO|SED|AWK|GREP|TAR|PKG_CONFIG|GO|CARGO|NPM|NODE|PYTHON|PYTHON3|PIP|DOCKER|KUBECTL|GIT|SHELL)\}$/;

/**
 * What a makefile runs, as shell text, and the files it includes. Continuation lines are joined; recipe lines
 * (after a tab, or after `;` on a rule line) lose their `@`, `-`, and `+`; `$(shell …)` and `!=` anywhere run too.
 * Variables are expanded through other variables, to a depth; a reference that cannot be resolved becomes `${NAME}`,
 * so the shell scan sees a value set at runtime. `$$` is the shell's `$`. `functions` says the makefile uses
 * `define`, `$(call)`, `$(eval)`, or `$(value)`, which the scan does not expand.
 */
function makefile(text: string): { shell: string; includes: string[]; functions: boolean } {
	const lines = text.replace(/\\\r?\n[ \t]*/g, " ").split("\n");
	const vars = new Map<string, string | undefined>([["MAKE", "make"]]);
	const shells = new Set<string>();
	for (const line of lines) {
		if (line.startsWith("\t")) continue;
		const match = /^\s*(?:(?:export|override)\s+)*([A-Za-z_][\w.-]*)\s*(::?=|:::=|\?=|\+=|!=|=)\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const value = match[3]?.trim() ?? "";
		if (match[2] === "!=") {
			// `X != cmd` runs cmd as make reads the file.
			shells.add(value);
			vars.set(match[1], undefined);
		} else if (match[2] === "+=") {
			const before = vars.get(match[1]);
			vars.set(match[1], vars.has(match[1]) && before === undefined ? undefined : `${before ?? ""} ${value}`.trim());
		} else if (match[2] !== "?=" || !vars.has(match[1])) vars.set(match[1], value);
	}
	const expand = (part: string, depth = 0): string => {
		let out = "";
		for (let i = 0; i < part.length; i++) {
			const ch = part[i];
			if (ch !== "$") {
				out += ch;
				continue;
			}
			const next = part[i + 1];
			if (next === "$") {
				out += "$";
				i++;
			} else if (next === "(" || next === "{") {
				const end = closingBracket(part, i + 1);
				const inner = part.slice(i + 2, end);
				if (/^shell\s/.test(inner)) {
					if (depth < MAX_NEST) shells.add(expand(inner.slice(6), depth + 1));
					out += "${shell}";
				} else {
					const name = inner.split(/[\s:,]/)[0] || "make";
					const value = vars.get(inner);
					out += value !== undefined && depth < MAX_NEST ? expand(value, depth + 1) : `\${${name}}`;
				}
				i = end;
			} else {
				const value = vars.get(next ?? "");
				out += value !== undefined && depth < MAX_NEST ? expand(value, depth + 1) : `\${${next ?? ""}}`;
				i++;
			}
		}
		return out;
	};
	const recipes: string[] = [];
	const includes: string[] = [];
	for (const line of lines) {
		if (line.startsWith("\t")) {
			recipes.push(expand(line.slice(1).replace(/^[@+-]+/, "")));
			continue;
		}
		const include = /^\s*-?s?include[ \t]+(.+)$/.exec(line);
		if (include?.[1]) {
			includes.push(...expand(include[1]).trim().split(/[ \t]+/).filter(Boolean));
			continue;
		}
		const rule = /^([^#\t=:][^#=:]*)::?(?!=)([^;=#]*);(.*)$/.exec(line);
		if (rule?.[3]) recipes.push(expand(rule[3].trim().replace(/^[@+-]+/, "")));
		else expand(line);
	}
	const functions = /\$[({](call|eval|value)\s|^\s*define\s/m.test(text);
	return { shell: [...recipes, ...[...shells].map((cmd) => expand(cmd))].join("\n"), includes, functions };
}

/** The index of the bracket that closes the `(` or `{` at `start`, counting only that kind, or the text's end. */
function closingBracket(text: string, start: number): number {
	const open = text[start];
	const close = open === "(" ? ")" : "}";
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return i;
	}
	return text.length - 1;
}

/**
 * Script files the command runs, read for the check, and what it runs that could not be read. Secret files
 * (secret_drop's registry and staging, and files whose names commonly hold credentials) are never read; every
 * text read is redacted.
 */
export async function findScripts(command: string, cwd: string, isSecret: (canonical: string) => boolean, redact: Redact = keep): Promise<ScriptScan> {
	return new Scanner(cwd, isSecret, redact).run(command);
}
