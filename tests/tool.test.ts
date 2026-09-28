import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRobotHand } from "../src/index.ts";

interface Harness {
	editor: string;
	copied: string[];
	selects: { title: string; options: string[] }[];
	events: unknown[];
}

// Registers the extension against a minimal pi and drives its tool the way pi does, with the
// user picking the option whose label matches `pick` (undefined = Esc).
async function run(params: Record<string, unknown>, pick: RegExp | undefined, setup: Partial<{ editor: string; mode: string; hasUI: boolean }> = {}) {
	const harness: Harness = { editor: setup.editor ?? "", copied: [], selects: [], events: [] };
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		events: { emit: (_channel: string, data: unknown) => harness.events.push(data) },
	} as unknown as ExtensionAPI;
	createRobotHand(async (text) => {
		harness.copied.push(text);
	})(pi);
	const ctx = {
		hasUI: setup.hasUI ?? true,
		mode: setup.mode ?? "tui",
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
