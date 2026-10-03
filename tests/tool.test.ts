import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startMarker } from "../src/herdr.ts";
import { createRobotHand, HERDR_RESULT_TYPE, WATCH_MS } from "../src/index.ts";

interface Harness {
	editor: string;
	copied: string[];
	selects: { title: string; options: string[] }[];
	events: unknown[];
	herdr: string[][];
	sent: { message: Record<string, unknown>; options: unknown }[];
}

// Registers the extension against a minimal pi and drives its tool the way pi does, with the
// user picking the option whose label matches `pick` (undefined = Esc).
async function run(
	params: Record<string, unknown>,
	pick: RegExp | undefined,
	setup: Partial<{ editor: string; mode: string; hasUI: boolean; env: NodeJS.ProcessEnv; tmp: string; herdr: (args: string[]) => { stdout: string; code: number } }> = {},
) {
	const harness: Harness = { editor: setup.editor ?? "", copied: [], selects: [], events: [], herdr: [], sent: [] };
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		events: { emit: (_channel: string, data: unknown) => harness.events.push(data) },
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
	)(pi);
	const ctx = {
		hasUI: setup.hasUI ?? true,
		mode: setup.mode ?? "tui",
		cwd: "/repo",
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
