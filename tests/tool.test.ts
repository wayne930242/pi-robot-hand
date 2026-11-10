import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ClassifierResultLike, JevContext } from "../src/check.ts";
import { HandSelect, type Picked, REFUSE_LABEL } from "../src/hand-select.ts";
import { startMarker } from "../src/herdr.ts";
import { createRobotHand, HERDR_RESULT_TYPE, WATCH_MS } from "../src/index.ts";

const jevModel = { type: "classifier", provider: "typesafe", id: "jev-latest" };
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

interface Harness {
	editor: string;
	copied: string[];
	selects: { title: string; options: string[] }[];
	events: unknown[];
	herdr: string[][];
	sent: { message: Record<string, unknown>; options: unknown }[];
	screens: (() => string)[];
}

// Registers the extension against a minimal pi and drives its tool the way pi does, with the
// user picking the option whose label matches `pick` (undefined = Esc).
async function run(
	params: Record<string, unknown>,
	pick: RegExp | undefined,
	setup: Partial<{
		editor: string;
		mode: string;
		hasUI: boolean;
		env: NodeJS.ProcessEnv;
		tmp: string;
		herdr: (args: string[]) => { stdout: string; code: number };
		agentDir: string;
		cwd: string;
		models: { provider: string; id: string }[];
		complete: (model: { provider: string; id: string }, context: Context) => Promise<Partial<AssistantMessage>>;
		branch: unknown[];
		current: string;
		// Jev in pi's classifier registry: present when `classify` is set; `jevSignedIn` defaults to true.
		classify: (model: unknown, context: JevContext, options?: { signal?: AbortSignal }) => Promise<ClassifierResultLike>;
		jevSignedIn: boolean;
		// Runs against the terminal selector before the pick, e.g. pressing `e`.
		drive: (select: HandSelect) => Promise<void>;
	}> = {},
) {
	const harness: Harness = { editor: setup.editor ?? "", copied: [], selects: [], events: [], herdr: [], sent: [], screens: [] };
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		// harness.events keeps the herdr:blocked events; the dialog contract has its own tests.
		events: { emit: (channel: string, data: unknown) => channel === "herdr:blocked" && harness.events.push(data), on: () => () => {} },
		on: () => {},
		exec: async (_bin: string, args: string[]) => {
			harness.herdr.push(args);
			return { stderr: "", killed: false, ...(setup.herdr?.(args) ?? { stdout: "", code: 0 }) };
		},
		sendMessage: (message: Record<string, unknown>, options: unknown) => harness.sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	createRobotHand(
		async (text) => {
			harness.copied.push(text);
		},
		setup.env ?? {},
		setup.tmp ?? tmpdir(),
		setup.agentDir ?? mkdtempSync(join(tmpdir(), "robot-hand-agent-")),
	)(pi);
	const ctx = {
		hasUI: setup.hasUI ?? true,
		mode: setup.mode ?? "tui",
		cwd: setup.cwd ?? "/repo",
		model: setup.current ? { provider: setup.current, id: "main" } : undefined,
		modelRegistry: {
			getAvailable: () => setup.models ?? [],
			complete: async (model: { provider: string; id: string }, context: Context) => ({ stopReason: "stop", content: [], ...(await setup.complete?.(model, context)) }),
			...(setup.classify
				? {
						findOfType: (type: string, provider: string, id: string) => (type === "classifier" && provider === "typesafe" && id === "jev-latest" ? jevModel : undefined),
						getProviderAuthStatus: (provider: string) => ({ configured: provider === "typesafe" && (setup.jevSignedIn ?? true) }),
						classify: setup.classify,
					}
				: {}),
		},
		sessionManager: { getBranch: () => setup.branch ?? [] },
		ui: {
			getEditorText: () => harness.editor,
			setEditorText: (text: string) => {
				harness.editor = text;
			},
			notify: () => {},
			select: async (title: string, options: string[]) => {
				harness.selects.push({ title, options });
				return pick ? options.find((option) => pick.test(option)) : undefined;
			},
			// The terminal selector: built as pi builds it, then driven by keys.
			custom: async (factory: (...args: unknown[]) => HandSelect) => {
				let result: Picked | null = null;
				const select = factory({ requestRender: () => {} }, plain, {}, (value: Picked) => {
					result = value;
				});
				harness.selects.push({ title: select.props.title, options: [...select.props.labels] });
				harness.screens.push(() => select.render(100).join("\n"));
				await setup.drive?.(select);
				const at = pick ? [...select.props.labels, REFUSE_LABEL].findIndex((label) => pick.test(label)) : -1;
				if (at < 0) select.handleInput("\x1b");
				else {
					for (let i = 0; i < at; i++) select.handleInput("\x1b[B");
					select.handleInput("\r");
				}
				return result;
			},
		},
	} as unknown as ExtensionContext;
	assert.ok(tool);
	const result = await tool.execute("call-1", params as never, undefined, undefined, ctx);
	const first = result.content[0];
	return { harness, result, text: first?.type === "text" ? first.text : "" };
}

test("choosing the prompt pre-fills `! command` and ends the agent's turn without running it", async () => {
	const { harness, result, text } = await run({ command: "sudo apt upgrade", reason: "需要 sudo" }, /prompt/);
	assert.equal(harness.editor, "! sudo apt upgrade");
	assert.deepEqual(harness.copied, []);
	assert.match(harness.selects[0]?.title ?? "", /需要 sudo\n\n {2}! sudo apt upgrade/);
	assert.match(text, /runs only when they press Enter/);
	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "prompt" });
	assert.deepEqual(harness.events, [{ active: true, label: "Waiting for the user to take a command" }, { active: false }]);
});

test("a pi command lands in the prompt as-is", async () => {
	const { harness } = await run({ command: "/reload", reason: "載入新設定", kind: "pi" }, /prompt/);
	assert.equal(harness.editor, "/reload");
	assert.deepEqual(harness.selects[0]?.options, ["Put it in my prompt", "No, thanks"]);
});

test("choosing the clipboard copies the raw command and leaves the prompt alone", async () => {
	const { harness, result, text } = await run({ command: "make deploy", reason: "在正式機執行" }, /clipboard/, { editor: "my draft" });
	assert.deepEqual(harness.copied, ["make deploy"]);
	assert.equal(harness.editor, "my draft");
	assert.match(harness.selects[0]?.options[0] ?? "", /replaces my draft/);
	assert.match(text, /clipboard/);
	assert.equal(result.terminate, true);
});

test("declining or pressing Esc places nothing and lets the agent respond", async () => {
	for (const pick of [/No, thanks/, undefined]) {
		const { harness, result, text } = await run({ command: "rm -rf build", reason: "清掉舊檔" }, pick, { editor: "keep me" });
		assert.equal(harness.editor, "keep me");
		assert.deepEqual(harness.copied, []);
		assert.match(text, /declined/);
		assert.equal(result.terminate, false);
	}
});

test("RPC clients get no clipboard option", async () => {
	const { harness } = await run({ command: "ls", reason: "看檔案" }, /prompt/, { mode: "rpc" });
	assert.deepEqual(harness.selects[0]?.options, ["Put it in my prompt", "No, thanks"]);
});

test("without a UI the tool fails and asks the agent to show the command in chat", async () => {
	await assert.rejects(run({ command: "ls", reason: "x" }, /prompt/, { hasUI: false }), /show the command to the user in chat/);
});

test("the default option leads the selector", async () => {
	const { harness } = await run({ command: "sudo apt upgrade", reason: "需要密碼", default: "clipboard" }, /prompt/);
	assert.deepEqual(harness.selects[0]?.options, ["Copy it to the clipboard", "Put it in my prompt", "No, thanks"]);
});

test("Herdr options appear only when pi runs inside Herdr", async () => {
	const outside = await run({ command: "ls", reason: "x", default: "herdr-type" }, undefined);
	assert.equal(outside.harness.selects[0]?.options[0], "Copy it to the clipboard");
	const inside = await run({ command: "ls", reason: "x", default: "herdr-type" }, undefined, { env: { HERDR_PANE_ID: "w1:p2" } });
	assert.equal(inside.harness.selects[0]?.options[0], "Type it into a new Herdr pane (I press Enter)");
});

test("a Herdr run opens a pane, ends the turn, and brings the agent back with the output", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
	let token = "";
	const herdr = (args: string[]) => {
		if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }), code: 0 };
		if (args[1] === "read") return { stdout: `${startMarker(token)}\nupgraded\n`, code: 0 };
		return { stdout: "", code: 0 };
	};
	const { harness, result, text } = await run({ command: "sudo apt upgrade", reason: "需要密碼", default: "herdr-type" }, /Herdr pane \(I press Enter\)/, {
		env: { HERDR_PANE_ID: "w1:p2", PATH: "" },
		tmp,
		herdr,
	});
	assert.equal(result.terminate, true);
	assert.match(text, /new Herdr pane.*arrives as a new message/s);
	assert.equal(harness.editor, "");
	assert.deepEqual(harness.herdr[2], ["pane", "run", "w1:p9", `bash ${join(tmp, "pi-robot-hand", readdirSync(join(tmp, "pi-robot-hand"))[0] ?? "", "run.bash")}`]);

	token = readdirSync(join(tmp, "pi-robot-hand"))[0] ?? "";
	writeFileSync(join(tmp, "pi-robot-hand", token, "status"), "0\n");
	await new Promise((resolve) => setTimeout(resolve, WATCH_MS * 3));
	assert.equal(harness.sent.length, 1);
	assert.equal(harness.sent[0]?.message.customType, HERDR_RESULT_TYPE);
	assert.match(String(harness.sent[0]?.message.content), /\$ sudo apt upgrade\nupgraded/);
	assert.deepEqual(harness.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(harness.herdr.at(-1), ["pane", "close", "w1:p9"]);
	assert.deepEqual(readdirSync(join(tmp, "pi-robot-hand")), [], "the run's files are removed");
});

// Waits until the selector shows `pattern`; the check gathers its input asynchronously.
async function until(select: HandSelect, pattern: RegExp): Promise<string> {
	for (let i = 0; i < 200; i++) {
		const screen = select.render(100).join("\n");
		if (pattern.test(screen)) return screen;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`never showed ${pattern}:\n${select.render(100).join("\n")}`);
}
const answer = (text: string) => async () => ({ content: [{ type: "text" as const, text }] });

test("the first e asks for a model, checks the command with its scripts and the user's message, and remembers the model", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "robot-hand-cwd-"));
	writeFileSync(join(cwd, "deploy.sh"), "#!/bin/bash\nrm -rf /var/www\n");
	writeFileSync(join(cwd, "notes.txt"), "not a script");
	const seen: { model: string; prompt: string }[] = [];
	let screen = "";
	const { harness, result, text } = await run({ command: "bash deploy.sh && cat notes.txt", reason: "只看部署狀態" }, /No, thanks/, {
		agentDir,
		cwd,
		models: [{ provider: "anthropic", id: "claude-haiku-5-5" }, { provider: "openai", id: "luna" }],
		branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "幫我看部署狀態就好" }] } }],
		complete: async (model, context) => {
			const first = context.messages[0];
			seen.push({ model: `${model.provider}/${model.id}`, prompt: typeof first?.content === "string" ? first.content : "" });
			return answer('{"verdict":"mismatch","does":"刪除 /var/www。","gaps":"說是看狀態，實際會刪檔。"}')();
		},
		drive: async (select) => {
			select.handleInput("e");
			assert.match(select.render(100).join("\n"), /Check with which model\?/);
			select.handleInput("\x1b[B");
			select.handleInput("\r");
			screen = await until(select, /Does not match/);
		},
	});
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.model, "openai/luna");
	assert.match(seen[0]?.prompt ?? "", /只看部署狀態/);
	assert.match(seen[0]?.prompt ?? "", /幫我看部署狀態就好/);
	assert.match(seen[0]?.prompt ?? "", /rm -rf \/var\/www/);
	assert.doesNotMatch(seen[0]?.prompt ?? "", /not a script/);
	assert.match(screen, /✗ Does not match the stated intent — openai\/luna/);
	assert.match(screen, /說是看狀態，實際會刪檔。/);
	assert.match(text, /declined.*verdict: mismatch.*刪除 \/var\/www。.*Differences: 說是看狀態/s);
	assert.deepEqual((result.details as { check?: unknown }).check, { model: "openai/luna", verdict: "mismatch" });
	assert.equal(JSON.parse(readFileSync(join(agentDir, "robot-hand.json"), "utf8")).checkModel, "openai/luna");
	assert.equal(harness.selects.length, 1);
});

test("with a saved model, e checks at once; E opens the list again", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	writeFileSync(join(agentDir, "robot-hand.json"), JSON.stringify({ checkModel: "openai/luna" }));
	const used: string[] = [];
	await run({ command: "ls", reason: "看檔案" }, /prompt/, {
		agentDir,
		models: [{ provider: "openai", id: "luna" }],
		complete: async (model) => {
			used.push(model.id);
			return answer('{"verdict":"match","does":"列出檔案。","gaps":""}')();
		},
		drive: async (select) => {
			select.handleInput("e");
			await until(select, /✓ Matches the stated intent/);
			select.handleInput("E");
			assert.match(select.render(100).join("\n"), /openai\/luna \(saved\)/);
			select.handleInput("\x1b");
		},
	});
	assert.deepEqual(used, ["luna"]);
});

test("a failed check shows the error, the next e asks for another model, and the choices keep working", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	writeFileSync(join(agentDir, "robot-hand.json"), JSON.stringify({ checkModel: "openai/luna" }));
	const { harness, text } = await run({ command: "ls", reason: "看檔案" }, /prompt/, {
		agentDir,
		models: [{ provider: "openai", id: "luna" }],
		complete: async () => ({ stopReason: "error", errorMessage: "401 not signed in" }),
		drive: async (select) => {
			select.handleInput("e");
			await until(select, /openai\/luna could not check: 401 not signed in/);
			select.handleInput("e");
			assert.match(select.render(100).join("\n"), /Check with which model\?/);
			select.handleInput("\x1b");
		},
	});
	assert.equal(harness.editor, "! ls");
	assert.doesNotMatch(text, /verdict/);
});

test("a saved model that is no longer signed in sends e to the list", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	writeFileSync(join(agentDir, "robot-hand.json"), JSON.stringify({ checkModel: "gone/model" }));
	await run({ command: "ls", reason: "x" }, undefined, {
		agentDir,
		models: [{ provider: "openai", id: "luna" }],
		drive: async (select) => {
			select.handleInput("e");
			assert.match(select.render(100).join("\n"), /Check with which model\?/);
		},
	});
});

test("a provider whose check failed is marked and listed last; the current provider leads", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	const models = [{ provider: "anthropic", id: "haiku" }, { provider: "google", id: "flash" }, { provider: "openai", id: "luna" }];
	const listed: string[][] = [];
	const setup = {
		agentDir,
		current: "openai",
		models,
		complete: async (model: { provider: string }) =>
			model.provider === "anthropic" ? { stopReason: "error" as const, errorMessage: "OAuth refresh failed for anthropic" } : answer('{"verdict":"match","does":"ok","gaps":""}')(),
	};
	const pickerList = (select: HandSelect) =>
		select
			.render(100)
			.join("\n")
			.split("\n")
			.map((line) => line.match(/(anthropic|google|openai)\/\w+.*?(?=\s*│)/)?.[0])
			.filter((line): line is string => Boolean(line));
	await run({ command: "ls", reason: "x" }, undefined, {
		...setup,
		drive: async (select) => {
			select.handleInput("e");
			listed.push(pickerList(select));
			select.handleInput("\x1b[B");
			select.handleInput("\r");
			await until(select, /could not check/);
			select.handleInput("e");
			listed.push(pickerList(select));
			select.handleInput("\x1b");
		},
	});
	assert.deepEqual(listed[0], ["openai/luna", "anthropic/haiku", "google/flash"]);
	assert.deepEqual(listed[1], ["openai/luna", "google/flash", "anthropic/haiku (saved, sign-in failed)"]);
});

const jevSays = (choice: string, probabilities: Record<string, number> = {}) => async (): Promise<ClassifierResultLike> => ({
	stopReason: "stop",
	answers: { verdict: { type: "choice", choice, probabilities } },
});

test("Jev checks on its own when the selector opens; after a mismatch the user can refuse and the agent hears why", async () => {
	const calls: { model: unknown; context: JevContext; signal?: AbortSignal }[] = [];
	let screen = "";
	const { harness, result, text } = await run({ command: "rm -rf build", reason: "只看建置結果" }, /Report the mismatch/, {
		editor: "keep me",
		branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "幫我看建置結果" }] } }],
		classify: async (model, context, options) => {
			calls.push({ model, context, signal: options?.signal });
			return jevSays("mismatch", { match: 0.05, partial: 0.15, mismatch: 0.8 })();
		},
		drive: async (select) => {
			screen = await until(select, /Jev: Does not match/);
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.model, jevModel);
	assert.equal(calls[0]?.context.state.command, "rm -rf build");
	assert.equal(calls[0]?.context.state.reason, "只看建置結果");
	assert.equal(calls[0]?.context.state.userMessage, "幫我看建置結果");
	assert.deepEqual(Object.keys(calls[0]?.context.questions.verdict.criteria ?? {}), ["match", "partial", "mismatch"]);
	assert.equal(calls[0]?.signal?.aborted, true, "closing the selector aborts Jev");
	assert.match(screen, /✗ Jev: Does not match the stated intent \(match 0\.05, partial 0\.15, mismatch 0\.80\)/);
	assert.match(screen, new RegExp(`No, thanks[\\s│]*${REFUSE_LABEL}`));
	assert.equal(harness.editor, "keep me");
	assert.deepEqual(harness.copied, []);
	assert.match(text, /declined because a check found the command does not match.*typesafe\/jev-latest checked.*verdict: mismatch \(match 0\.05, partial 0\.15, mismatch 0\.80\)/s);
	assert.equal(result.terminate, false);
	assert.deepEqual(result.details, { command: "! rm -rf build", status: "refuse", jev: { model: "typesafe/jev-latest", verdict: "mismatch" } });
});

test("a Jev match offers no refuse choice and its verdict rides along with the user's choice", async () => {
	let screen = "";
	const { harness, result, text } = await run({ command: "ls", reason: "看檔案" }, /prompt/, {
		classify: jevSays("match", { match: 0.9, partial: 0.08, mismatch: 0.02 }),
		drive: async (select) => {
			screen = await until(select, /✓ Jev: Matches/);
		},
	});
	assert.doesNotMatch(screen, /Report the mismatch/);
	assert.equal(harness.editor, "! ls");
	assert.match(text, /verdict: match \(match 0\.90/);
	assert.deepEqual((result.details as { jev?: unknown }).jev, { model: "typesafe/jev-latest", verdict: "match" });
	assert.equal(result.terminate, true);
});

test("Jev stays off when jevCheck is false or TypeSafe has no credential", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	writeFileSync(join(agentDir, "robot-hand.json"), JSON.stringify({ jevCheck: false }));
	for (const setup of [{ agentDir }, { jevSignedIn: false }]) {
		let called = 0;
		let screen = "";
		const { text } = await run({ command: "ls", reason: "x" }, /prompt/, {
			...setup,
			classify: async () => {
				called++;
				return jevSays("mismatch")();
			},
			drive: async (select) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				screen = select.render(100).join("\n");
			},
		});
		assert.equal(called, 0);
		assert.doesNotMatch(screen, /Jev/);
		assert.doesNotMatch(text, /Jev|jev-latest/);
	}
});

test("a Jev failure shows only the status, never the provider's text, and the choices keep working", async () => {
	let screen = "";
	const { harness, text } = await run({ command: "ls", reason: "x" }, /prompt/, {
		classify: async () => ({ stopReason: "error", errorMessage: "TypeSafe API error (401): echo of rm -rf build" }),
		drive: async (select) => {
			screen = await until(select, /Jev could not check/);
		},
	});
	assert.match(screen, /Jev could not check: TypeSafe returned HTTP 401/);
	assert.doesNotMatch(screen, /echo of/);
	assert.equal(harness.editor, "! ls");
	assert.doesNotMatch(text, /verdict/);
});

test("an e check's mismatch alone also offers the refuse choice", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	writeFileSync(join(agentDir, "robot-hand.json"), JSON.stringify({ checkModel: "openai/luna" }));
	const { result, text } = await run({ command: "rm -rf build", reason: "看檔案" }, /Report the mismatch/, {
		agentDir,
		models: [{ provider: "openai", id: "luna" }],
		complete: answer('{"verdict":"mismatch","does":"刪除 build。","gaps":"說是看檔案。"}'),
		drive: async (select) => {
			select.handleInput("e");
			await until(select, /Report the mismatch and refuse/);
		},
	});
	assert.equal((result.details as { status?: string }).status, "refuse");
	assert.match(text, /declined because.*openai\/luna.*verdict: mismatch.*刪除 build。/s);
});

test("the selector lists what the checks could not read, Jev's match is lowered, and the agent hears both", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "robot-hand-cwd-"));
	let context: JevContext | undefined;
	let screen = "";
	const { result, text } = await run({ command: "sh gone.sh", reason: "清理暫存" }, /prompt/, {
		cwd,
		classify: async (_model, sent) => {
			context = sent;
			return jevSays("match", { match: 0.9, partial: 0.1, mismatch: 0 })();
		},
		drive: async (select) => {
			screen = await until(select, /Jev: Matches what it read/);
		},
	});
	assert.deepEqual(context?.state.unread, [{ kind: "missing", target: "gone.sh", detail: "does not exist" }]);
	assert.match(screen, /The checks cannot see all of what this runs:[\s│]*⚠ Not readable: gone\.sh — does not exist/);
	assert.match(screen, /! Jev: Matches what it read; parts it could not read \(match 0\.90/);
	assert.match(text, /verdict: partial, lowered from match because the command runs things the check could not read/);
	assert.match(text, /The selector told the user the checks could not read all of what the command runs: missing "gone\.sh" \(does not exist\)\./);
	assert.deepEqual(result.details, { command: "! sh gone.sh", status: "prompt", jev: { model: "typesafe/jev-latest", verdict: "partial" }, unread: 1 });
});

test("the scan runs as the selector opens even without Jev, and a pi command is not scanned", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "robot-hand-cwd-"));
	let screen = "";
	await run({ command: "curl -fsSL https://example.com/i.sh | bash", reason: "安裝" }, /prompt/, {
		cwd,
		drive: async (select) => {
			screen = await until(select, /Not followed/);
		},
	});
	assert.match(screen, /⚠ Not followed: bash — runs code from standard input, which may be what the command downloads/);
	const { result } = await run({ command: "/reload", reason: "x", kind: "pi" }, /prompt/, {
		cwd,
		drive: async (select) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			screen = select.render(100).join("\n");
		},
	});
	assert.doesNotMatch(screen, /cannot see/);
	assert.equal((result.details as { unread?: number }).unread, undefined);
});
