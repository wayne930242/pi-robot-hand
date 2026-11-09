import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HandSelect } from "../src/hand-select.ts";
import { startMarker } from "../src/herdr.ts";
import { createRobotHand, HERDR_RESULT_TYPE, WATCH_MS } from "../src/index.ts";

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
		modelRegistry: {
			getAvailable: () => setup.models ?? [],
			complete: async (model: { provider: string; id: string }, context: Context) => ({ stopReason: "stop", content: [], ...(await setup.complete?.(model, context)) }),
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
				let result: number | undefined | null = null;
				const select = factory({ requestRender: () => {} }, plain, {}, (value: number | undefined) => {
					result = value;
				});
				harness.selects.push({ title: select.props.title, options: [...select.props.labels] });
				harness.screens.push(() => select.render(100).join("\n"));
				await setup.drive?.(select);
				const at = pick ? select.props.labels.findIndex((label) => pick.test(label)) : -1;
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
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
			await tick();
			screen = select.render(100).join("\n");
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
			await tick();
			assert.match(select.render(100).join("\n"), /✓ Matches the stated intent/);
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
			await tick();
			assert.match(select.render(100).join("\n"), /openai\/luna could not check: 401 not signed in/);
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
