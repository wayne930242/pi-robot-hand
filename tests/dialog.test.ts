import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HandSelect } from "../src/hand-select.ts";
import { digestOf } from "../src/dialog.ts";
import { dialogTitle, resultText, toOffer } from "../src/hand.ts";
import { createRobotHand } from "../src/index.ts";
import secretDrop from "../src/secret-drop/index.ts";

type Handler = (data: unknown) => void;
interface Pending {
	version: 1;
	id: string;
	toolCallId: string;
	digest: string;
	cancellable?: true;
	select: { title: string; choices: { label: string; note?: string; localOnly?: true; next?: "terminal" | "pane"; tagged?: true }[]; copy: string };
}
const GOOD = "answer-id-0123456789";
const ENV = { HERDR_PANE_ID: "w1:p2", PATH: "" };

// A synchronous bus like pi's: emit runs the listeners before it returns.
function makeBus() {
	const handlers = new Map<string, Handler[]>();
	const log: { channel: string; data: any }[] = [];
	return {
		log,
		emit(channel: string, data: unknown) {
			log.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: Handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((item) => item !== handler));
		},
		listeners: (channel: string) => handlers.get(channel)?.length ?? 0,
		of: (channel: string) => log.filter((entry) => entry.channel === channel).map((entry) => entry.data),
	};
}

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Drives robot_hand like pi does. The selector stays open until the test picks, presses Esc, or aborts.
function start(params: Record<string, unknown>, setup: { signal?: AbortSignal; hasUI?: boolean; copy?: (text: string) => Promise<void>; selectThrows?: boolean; tagFails?: "exit" | "throw"; herdr?: (args: string[]) => string } = {}) {
	const bus = makeBus();
	const copied: string[] = [];
	const herdr: string[][] = [];
	const state = { editor: "", options: [] as string[], selects: 0, pick: (_label: string | undefined) => {} };
	let tool: ToolDefinition | undefined;
	const hooks = new Map<string, () => void>();
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		events: bus,
		on: (name: string, hook: () => void) => hooks.set(name, hook),
		exec: async (_bin: string, args: string[]) => {
			herdr.push(args);
			if (args[1] === "report-metadata" && setup.tagFails === "throw") throw new Error("herdr is gone");
			if (args[1] === "report-metadata" && setup.tagFails === "exit") return { stdout: "", code: 1, stderr: "nope", killed: false };
			return { stdout: setup.herdr?.(args) ?? "", code: 0, stderr: "", killed: false };
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	createRobotHand(setup.copy ?? (async (text) => void copied.push(text)), ENV, mkdtempSync(join(tmpdir(), "robot-hand-dialog-")), mkdtempSync(join(tmpdir(), "robot-hand-agent-")))(pi);
	const ctx = {
		hasUI: setup.hasUI ?? true,
		mode: "tui",
		cwd: "/repo",
		ui: {
			getEditorText: () => state.editor,
			setEditorText: (text: string) => {
				state.editor = text;
			},
			notify: () => {},
			// The terminal selector robot_hand opens in tui mode, picked by keys.
			custom: (factory: (...args: unknown[]) => HandSelect) => {
				if (setup.selectThrows) return Promise.reject(new Error("selector broke"));
				return new Promise<number | undefined>((resolve) => {
					const select = factory({ requestRender: () => {} }, plain, {}, resolve);
					state.selects++;
					state.options = [...select.props.labels];
					state.pick = (label) => {
						const at = label === undefined ? -1 : state.options.indexOf(label);
						if (at < 0) return select.handleInput("\x1b");
						for (let i = 0; i < at; i++) select.handleInput("\x1b[B");
						select.handleInput("\r");
					};
				});
			},
			select: (_title: string, options: string[], opts?: { signal?: AbortSignal }) => {
				if (setup.selectThrows) return Promise.reject(new Error("selector broke"));
				state.selects++;
				state.options = options;
				return new Promise<string | undefined>((resolve) => {
					state.pick = (label) => resolve(label);
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
					if (opts?.signal?.aborted) resolve(undefined);
				});
			},
		},
	} as unknown as ExtensionContext;
	assert.ok(tool);
	const done = Promise.resolve(tool.execute("call-1", params as never, setup.signal, undefined, ctx));
	return {
		bus,
		state,
		// Stops the Herdr watcher a pane run starts, which would otherwise keep polling.
		shutdown: () => hooks.get("session_shutdown")?.(),
		copied,
		herdr,
		done,
		pending: () => bus.of("robot-hand:pending")[0] as Pending,
		pick: (pattern: RegExp) => state.pick(state.options.find((option) => pattern.test(option))),
		answer: (extra: Record<string, unknown> = {}) => {
			const pending = bus.of("robot-hand:pending")[0] as Pending;
			bus.emit("robot-hand:answer", { version: 1, id: pending.id, answerId: GOOD, digest: pending.digest, ...extra });
		},
		indexOf: (pattern: RegExp) => (bus.of("robot-hand:pending")[0] as Pending).select.choices.findIndex((choice) => pattern.test(choice.label)),
		blocked: () => bus.of("herdr:blocked").map((data) => data.active),
	};
}

const PARAMS = { command: "sudo apt upgrade", reason: "需要密碼", default: "herdr-type" };
const text = (result: { content: { type: string; text?: string }[] }) => result.content[0]?.text;

test("digest vector 1 is reproduced, also through dialogTitle", () => {
	const title = dialogTitle(toOffer("npm run deploy", "shell"), "Deploy needs your sudo password");
	assert.equal(title, "Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy");
	const labels = ["Type it into a new Herdr pane (I press Enter)", "Put it in my prompt", "No, thanks"];
	assert.equal(digestOf(title, labels), "2974924308b3389b43761124fc7cbc4a4feced24e7f83706ae3f568a21b45faf");
});

test("pending carries the id, the call, the digest of what the selector shows, and notes on each choice", async () => {
	const run = start(PARAMS);
	const pending = run.pending();
	assert.equal(pending.version, 1);
	assert.match(pending.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(pending.toolCallId, "call-1");
	assert.equal(pending.cancellable, true);
	assert.deepEqual(Object.keys(pending).sort(), ["cancellable", "digest", "id", "select", "toolCallId", "version"]);
	assert.equal(pending.select.title, dialogTitle(toOffer("sudo apt upgrade", "shell"), "需要密碼"));
	assert.equal(pending.select.copy, "sudo apt upgrade");
	assert.deepEqual(
		pending.select.choices.map((choice) => choice.label),
		run.state.options,
	);
	assert.equal(pending.digest, createHash("sha256").update(JSON.stringify(["pi-dialog/1", "select", pending.select.title, run.state.options])).digest("hex"));
	assert.deepEqual(pending.select.choices, [
		{ label: "Type it into a new Herdr pane (I press Enter)", note: "Opens a pane with the command typed; press Enter there", next: "pane", tagged: true },
		{ label: "Put it in my prompt", note: "Lands in the terminal's prompt; press Enter there", next: "terminal" },
		{ label: "Copy it to the clipboard", note: "Copies on this computer", localOnly: true },
		{ label: "Run it in a new Herdr pane", note: "Runs it at once in a new pane", next: "pane", tagged: true },
		{ label: "No, thanks" },
	]);
	run.pick(/No, thanks/);
	await run.done;
});

test("each choice answered remotely runs as if picked in the terminal", async () => {
	const split = (args: string[]) => (args[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }) : "");
	const prompt = start(PARAMS);
	prompt.answer({ selections: [prompt.indexOf(/prompt/)] });
	const promptResult = await prompt.done;
	assert.equal(prompt.state.editor, "! sudo apt upgrade");
	assert.equal(text(promptResult), resultText("prompt", toOffer("sudo apt upgrade", "shell")));
	assert.deepEqual(promptResult.details, { command: "! sudo apt upgrade", status: "prompt", answeredFrom: "browser" });
	assert.equal(promptResult.terminate, true);

	const clip = start(PARAMS);
	clip.answer({ selections: [clip.indexOf(/clipboard/)] });
	const clipResult = await clip.done;
	assert.deepEqual(clip.copied, ["sudo apt upgrade"]);
	assert.equal(text(clipResult), resultText("clipboard", toOffer("sudo apt upgrade", "shell")));

	const typed = start(PARAMS, { herdr: split });
	typed.answer({ selections: [typed.indexOf(/Type it/)] });
	assert.match(text(await typed.done) ?? "", /It runs when the user presses Enter there/);
	assert.ok(typed.herdr.some((args) => args[1] === "split"));
	typed.shutdown();

	const ran = start(PARAMS, { herdr: split });
	ran.answer({ selections: [ran.indexOf(/Run it/)] });
	assert.match(text(await ran.done) ?? "", /It is running there/);
	assert.ok(ran.herdr.some((args) => args[0] === "pane" && args[1] === "run"));
	ran.shutdown();

	const no = start({ ...PARAMS, default: "prompt" });
	no.answer({ selections: [no.indexOf(/No, thanks/)] });
	const noResult = await no.done;
	assert.equal(no.state.editor, "");
	assert.equal(noResult.terminate, false);
	assert.equal(text(noResult), resultText("cancel", toOffer("sudo apt upgrade", "shell")));
	for (const run of [prompt, clip, typed, ran, no]) assert.equal(run.state.selects, 1, "the selector was opened and then closed by the answer");
});

test("an accepted answer reports accepted, then closed by remote with its answerId, and closes the selector", async () => {
	const run = start(PARAMS);
	const id = run.pending().id;
	run.answer({ selections: [run.indexOf(/prompt/)] });
	assert.deepEqual(
		run.bus.log.map((entry) => entry.channel).filter((channel) => channel.startsWith("robot-hand:")),
		["robot-hand:pending", "robot-hand:answer", "robot-hand:answer-result", "robot-hand:closed"],
	);
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), [{ version: 1, id, answerId: GOOD, accepted: true }]);
	assert.deepEqual(run.bus.of("robot-hand:closed"), [{ version: 1, id, by: "remote", answerId: GOOD }]);
	await run.done;
	assert.equal(run.bus.of("robot-hand:closed").length, 1);
});

test("a terminal pick first: a later answer is refused as closed and has no second effect", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const copied: string[] = [];
	const run = start(PARAMS, { copy: async (value) => { await gate; copied.push(value); } });
	const id = run.pending().id;
	run.pick(/clipboard/);
	await flush();
	assert.deepEqual(run.bus.of("robot-hand:closed"), [{ version: 1, id, by: "local" }]);
	run.answer({ selections: [run.indexOf(/prompt/)] });
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), [{ version: 1, id, answerId: GOOD, accepted: false, reason: "closed" }]);
	release();
	const result = await run.done;
	assert.deepEqual(copied, ["sudo apt upgrade"]);
	assert.equal(run.state.editor, "", "the answer did not also fill the prompt");
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "clipboard" });
	assert.equal(run.bus.of("robot-hand:closed").length, 1);
});

test("a second answer after a remote winner is refused as closed", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const copied: string[] = [];
	const run = start(PARAMS, { copy: async (value) => { await gate; copied.push(value); } });
	run.answer({ selections: [run.indexOf(/clipboard/)] });
	run.answer({ answerId: "another-answer-id-01", selections: [run.indexOf(/prompt/)] });
	assert.deepEqual(run.bus.of("robot-hand:answer-result").map((result) => [result.accepted, result.reason]), [[true, undefined], [false, "closed"]]);
	release();
	await run.done;
	assert.deepEqual(copied, ["sudo apt upgrade"]);
	assert.equal(run.state.editor, "");
});

test("answers for another id get no result; every malformed or unsuitable answer is refused whole and the dialog stays open", async () => {
	const run = start(PARAMS);
	const { id, digest } = run.pending();
	const base = { version: 1, id, answerId: GOOD, digest, selections: [0] };
	const { selections: _dropped, ...wordsOnly } = base;
	run.bus.emit("robot-hand:answer", { ...base, id: "00000000-0000-4000-8000-000000000000" });
	run.bus.emit("robot-hand:answer", "not an object");
	run.bus.emit("robot-hand:answer", null);
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), []);
	const refused: [Record<string, unknown>, string][] = [
		[{ ...base, digest: "0".repeat(64) }, "digest"],
		[{ ...base, selections: [5] }, "malformed"],
		[{ ...base, selections: [-1] }, "malformed"],
		[{ ...base, selections: [0.5] }, "malformed"],
		[{ ...base, selections: ["0"] }, "malformed"],
		[{ ...base, selections: [] }, "malformed"],
		[{ ...base, selections: [0, 0] }, "malformed"],
		[{ ...base, selections: 0 }, "malformed"],
		[{ ...base, selections: [0, 1] }, "not-allowed"],
		[{ ...wordsOnly, text: "yes" }, "not-allowed"],
		[{ ...base, selections: undefined, text: "yes" }, "malformed"],
		[{ ...base, text: "yes" }, "malformed"],
		[{ ...wordsOnly, text: "   " }, "malformed"],
		[wordsOnly, "malformed"],
		[{ ...wordsOnly, text: "yes", comment: "no" }, "malformed"],
		[{ ...base, comment: "ok" }, "not-allowed"],
		[{ ...base, comment: 3 }, "malformed"],
		[{ ...base, extra: true }, "malformed"],
		[{ ...base, version: 2 }, "malformed"],
		[{ ...base, answerId: "short" }, "malformed"],
		[{ ...base, answerId: "has spaces in it 1234" }, "malformed"],
		[{ ...base, answerId: undefined }, "malformed"],
		[{ ...base, text: undefined }, "malformed"],
		[{ ...base, comment: undefined }, "malformed"],
	];
	for (const [payload] of refused) run.bus.emit("robot-hand:answer", payload);
	const results = run.bus.of("robot-hand:answer-result");
	assert.deepEqual(results.map((result) => result.reason), refused.map(([, reason]) => reason));
	assert.ok(results.every((result) => result.accepted === false && result.id === id));
	assert.equal(results[refused.findIndex(([payload]) => payload.answerId === "short")]?.answerId, "", "an answerId that fails the pattern is not echoed");
	assert.deepEqual(run.bus.of("robot-hand:closed"), []);
	assert.equal(run.state.editor, "", "nothing was applied");
	run.answer({ selections: [run.indexOf(/prompt/)] });
	await run.done;
	assert.equal(run.state.editor, "! sudo apt upgrade");
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["remote"]);
});

test("an answer arriving while pending is emitted wins before the selector opens", async () => {
	const bus = makeBus();
	let tool: ToolDefinition | undefined;
	const state = { selects: 0, editor: "" };
	bus.on("robot-hand:pending", (data) => {
		const pending = data as Pending;
		bus.emit("robot-hand:answer", { version: 1, id: pending.id, answerId: GOOD, digest: pending.digest, selections: [0] });
	});
	const pi = { registerTool: (definition: ToolDefinition) => (tool = definition), events: bus, on: () => {} } as unknown as ExtensionAPI;
	createRobotHand(async () => {}, {}, tmpdir())(pi);
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/repo",
		ui: {
			getEditorText: () => "",
			setEditorText: (value: string) => (state.editor = value),
			notify: () => {},
			select: async () => {
				state.selects++;
				return undefined;
			},
		},
	} as unknown as ExtensionContext;
	const result = await tool?.execute("call-1", { command: "ls", reason: "x" } as never, undefined, undefined, ctx);
	assert.equal(state.selects, 0);
	assert.equal(state.editor, "! ls");
	assert.deepEqual(result?.details, { command: "! ls", status: "prompt", answeredFrom: "browser" });
	assert.deepEqual(bus.of("herdr:blocked").map((data) => data.active), [true, false]);
	assert.deepEqual(bus.of("robot-hand:closed").map((closed) => closed.by), ["remote"]);
});

test("Escape closes with cancel and the terminal result is unchanged", async () => {
	const run = start(PARAMS);
	run.state.pick(undefined);
	const result = await run.done;
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["cancel"]);
	assert.equal(text(result), resultText("cancel", toOffer("sudo apt upgrade", "shell")));
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "cancel" });
});

const cancelText = (result: { content: { type: string; text?: string }[] }) => text(result) ?? "";

test("a remote cancel closes with cancel and its answerId, ends the selector, runs nothing, and does not abort the turn", async () => {
	const turn = new AbortController();
	const run = start(PARAMS, { signal: turn.signal });
	const { id } = run.pending();
	run.bus.emit("robot-hand:answer", { version: 1, id, answerId: GOOD, cancel: true });
	assert.deepEqual(
		run.bus.log.map((entry) => entry.channel).filter((channel) => channel.startsWith("robot-hand:")),
		["robot-hand:pending", "robot-hand:answer", "robot-hand:answer-result", "robot-hand:closed"],
	);
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), [{ version: 1, id, answerId: GOOD, accepted: true }]);
	assert.deepEqual(run.bus.of("robot-hand:closed"), [{ version: 1, id, by: "cancel", answerId: GOOD }]);
	const result = await run.done;
	assert.equal(turn.signal.aborted, false, "the turn is not aborted");
	assert.equal(run.state.editor, "");
	assert.deepEqual(run.copied, []);
	assert.deepEqual(run.herdr, []);
	assert.match(cancelText(result), /cancelled from another device or by auto mode/);
	assert.match(cancelText(result), /nothing was placed or run/);
	assert.notEqual(text(result), resultText("cancel", toOffer("sudo apt upgrade", "shell")));
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "cancel", cancelledFrom: "remote" });
	assert.equal(result.terminate, false, "the agent answers");
	assert.deepEqual(run.blocked(), [true, false]);
	assert.equal(run.bus.listeners("robot-hand:answer"), 0);
	assert.equal(run.bus.of("robot-hand:closed").length, 1);
});

test("a local Escape stays by cancel without an answerId and keeps the plain declined text", async () => {
	const run = start(PARAMS);
	run.state.pick(undefined);
	const result = await run.done;
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => Object.keys(closed).sort()), [["by", "id", "version"]]);
	assert.equal(text(result), resultText("cancel", toOffer("sudo apt upgrade", "shell")));
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "cancel" });
});

test("a cancel for a closed dialog is refused as closed, and an unknown id gets no result", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const run = start(PARAMS, { copy: async () => gate });
	const { id } = run.pending();
	run.bus.emit("robot-hand:answer", { version: 1, id: "00000000-0000-4000-8000-000000000000", answerId: GOOD, cancel: true });
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), []);
	run.pick(/clipboard/);
	await flush();
	run.bus.emit("robot-hand:answer", { version: 1, id, answerId: GOOD, cancel: true });
	assert.deepEqual(run.bus.of("robot-hand:answer-result"), [{ version: 1, id, answerId: GOOD, accepted: false, reason: "closed" }]);
	assert.deepEqual(run.bus.of("robot-hand:closed"), [{ version: 1, id, by: "local" }]);
	release();
	const result = await run.done;
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "clipboard" });
});

test("after a remote cancel, a choice or a second cancel is refused as closed", async () => {
	const run = start(PARAMS);
	const { id } = run.pending();
	run.bus.emit("robot-hand:answer", { version: 1, id, answerId: GOOD, cancel: true });
	run.answer({ answerId: "another-answer-id-01", selections: [run.indexOf(/prompt/)] });
	run.bus.emit("robot-hand:answer", { version: 1, id, answerId: "another-answer-id-02", cancel: true });
	assert.deepEqual(run.bus.of("robot-hand:answer-result").map((result) => [result.accepted, result.reason]), [[true, undefined], [false, "closed"], [false, "closed"]]);
	await run.done;
	assert.equal(run.state.editor, "");
	assert.equal(run.bus.of("robot-hand:closed").length, 1);
});

test("a cancel with a choice, a digest, or anything else is refused whole as malformed and the dialog stays open", async () => {
	const run = start(PARAMS);
	const { id, digest } = run.pending();
	const base = { version: 1, id, answerId: GOOD, cancel: true };
	const refused: Record<string, unknown>[] = [
		{ ...base, selections: [0] },
		{ ...base, text: "no" },
		{ ...base, comment: "no" },
		{ ...base, digest },
		{ ...base, extra: true },
		{ ...base, cancel: false },
		{ ...base, cancel: "true" },
		{ ...base, cancel: 1 },
		{ ...base, version: 2 },
		{ ...base, answerId: "short" },
		{ ...base, answerId: undefined },
	];
	for (const payload of refused) run.bus.emit("robot-hand:answer", payload);
	const results = run.bus.of("robot-hand:answer-result");
	assert.equal(results.length, refused.length);
	assert.ok(results.every((result) => result.accepted === false && result.reason === "malformed" && result.id === id));
	assert.deepEqual(run.bus.of("robot-hand:closed"), []);
	assert.equal(run.state.editor, "", "nothing was applied");
	run.answer({ selections: [run.indexOf(/prompt/)] });
	await run.done;
	assert.equal(run.state.editor, "! sudo apt upgrade");
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["remote"]);
});

test("a cancel sent while pending is emitted wins before the selector opens", async () => {
	const bus = makeBus();
	let tool: ToolDefinition | undefined;
	const state = { selects: 0 };
	bus.on("robot-hand:pending", (data) => bus.emit("robot-hand:answer", { version: 1, id: (data as Pending).id, answerId: GOOD, cancel: true }));
	createRobotHand(async () => {}, ENV, mkdtempSync(join(tmpdir(), "robot-hand-dialog-")), mkdtempSync(join(tmpdir(), "robot-hand-agent-")))({
		registerTool: (definition: ToolDefinition) => (tool = definition),
		events: bus,
		on: () => {},
		exec: async () => ({ stdout: "", code: 0, stderr: "", killed: false }),
		sendMessage: () => {},
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/repo",
		ui: { getEditorText: () => "", setEditorText: () => {}, notify: () => {}, custom: async () => void state.selects++, select: async () => void state.selects++ },
	} as unknown as ExtensionContext;
	const result = await tool!.execute("call-1", PARAMS as never, undefined, undefined, ctx);
	assert.equal(state.selects, 0);
	assert.match(cancelText(result), /cancelled from another device or by auto mode/);
	assert.deepEqual(bus.of("robot-hand:closed").map((closed) => closed.by), ["cancel"]);
});

test("a tool abort closes with abort and a later answer is refused", async () => {
	const controller = new AbortController();
	const run = start(PARAMS, { signal: controller.signal });
	controller.abort();
	run.answer({ selections: [run.indexOf(/prompt/)] });
	assert.deepEqual(run.bus.of("robot-hand:answer-result").map((result) => [result.accepted, result.reason]), [[false, "closed"]]);
	const result = await run.done;
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["abort"]);
	assert.equal(result.details && (result.details as { status: string }).status, "cancel");
	assert.equal(run.state.editor, "");
});

test("a tool signal that was already aborted closes with abort and applies nothing", async () => {
	const controller = new AbortController();
	controller.abort();
	const run = start(PARAMS, { signal: controller.signal });
	await run.done;
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["abort"]);
	assert.equal(run.state.editor, "");
});

test("a selector that throws closes with error, rethrows, and still balances blocked", async () => {
	const run = start(PARAMS, { selectThrows: true });
	await assert.rejects(run.done, /selector broke/);
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["error"]);
	assert.deepEqual(run.blocked(), [true, false]);
	assert.equal(run.bus.listeners("robot-hand:answer"), 0);
});

test("blocked is balanced and the answer listener is gone after every way out", async () => {
	const controller = new AbortController();
	const runs = [
		start(PARAMS),
		start(PARAMS),
		start(PARAMS),
		start(PARAMS, { signal: controller.signal }),
	];
	assert.ok(runs.every((run) => run.bus.listeners("robot-hand:answer") === 1));
	runs[0]?.pick(/prompt/);
	runs[1]?.state.pick(undefined);
	runs[2]?.answer({ selections: [runs[2].indexOf(/prompt/)] });
	controller.abort();
	await Promise.all(runs.map((run) => run.done));
	for (const run of runs) {
		assert.deepEqual(run.blocked(), [true, false]);
		assert.equal(run.bus.listeners("robot-hand:answer"), 0);
		assert.equal(run.bus.of("robot-hand:closed").length, 1);
	}
	const late = runs[0];
	late?.bus.emit("robot-hand:answer", { version: 1, id: late.pending().id, answerId: GOOD, digest: late.pending().digest, selections: [0] });
	assert.deepEqual(late?.bus.of("robot-hand:answer-result"), [], "after return an answer for the id gets no result");
});

test("without a UI nothing is emitted", async () => {
	const run = start(PARAMS, { hasUI: false });
	await assert.rejects(run.done, /interactive pi UI/);
	assert.deepEqual(run.bus.log, []);
	assert.equal(run.bus.listeners("robot-hand:answer"), 0);
});

test("secret_drop emits no robot-hand event", async () => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	const bus = makeBus();
	let tool: ToolDefinition | undefined;
	secretDrop({ registerTool: (definition: ToolDefinition) => (tool = definition), registerCommand: () => {}, on: () => {}, events: bus } as unknown as ExtensionAPI);
	assert.equal(tool?.name, "secret_drop");
	const ctx = { hasUI: true, mode: "tui", cwd: "/repo", ui: { custom: async () => null, getEditorText: () => "", setEditorText: () => {}, notify: () => {} } } as unknown as ExtensionContext;
	const params = { label: "Token", instructions: ["Copy it"], format: "command", command: "cat {secret}" };
	const result = await tool?.execute("call-1", params as never, undefined, undefined, ctx);
	assert.match(String(result?.content[0] && "text" in result.content[0] ? result.content[0].text : ""), /User cancelled/);
	assert.deepEqual(bus.log.map((entry) => entry.channel).filter((channel) => channel.startsWith("robot-hand")), []);
	assert.deepEqual(bus.log.map((entry) => entry.channel), ["herdr:blocked", "herdr:blocked"]);
});

test("the terminal pick settles before herdr:blocked ends, so a listener there cannot override it", async () => {
	const run = start(PARAMS);
	const { id, digest } = run.pending();
	run.bus.on("herdr:blocked", (data) => {
		if ((data as { active: boolean }).active) return;
		run.bus.emit("robot-hand:answer", { version: 1, id, answerId: GOOD, digest, selections: [run.indexOf(/No, thanks/)] });
	});
	run.pick(/prompt/);
	const result = await run.done;
	assert.deepEqual(result.details, { command: "! sudo apt upgrade", status: "prompt" });
	assert.equal(run.state.editor, "! sudo apt upgrade");
	assert.deepEqual(run.bus.of("robot-hand:answer-result").map((entry) => entry.reason), ["closed"]);
});

test("a pane that fails to open closes the dialog once and leaves no listener", async () => {
	const run = start(PARAMS);
	run.pick(/Type it/);
	await assert.rejects(run.done, /herdr could not open a pane/);
	assert.deepEqual(run.bus.of("robot-hand:closed").map((closed) => closed.by), ["local"]);
	assert.equal(run.bus.listeners("robot-hand:answer"), 0);
	assert.deepEqual(run.blocked(), [true, false]);
});

test("the published choices are a copy: changing them does not change what answers are checked against", async () => {
	const run = start(PARAMS);
	const prompt = run.indexOf(/prompt/);
	run.pending().select.choices.length = 0;
	run.answer({ selections: [prompt] });
	assert.deepEqual(run.bus.of("robot-hand:answer-result").map((entry) => entry.accepted), [true]);
	await run.done;
});

// The pane an accepted answer opens carries the answer's own id, so Straw Boss can tell which pane is the owner's.
const split = (args: string[]) => (args[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }) : "");
const TAG = ["pane", "report-metadata", "w1:p9", "--source", "robot-hand", "--token", `sb_answer=${GOOD}`, "--ttl-ms", "600000"];

test("an accepted answer for a pane choice tags the new pane with its answerId, right after the split and before the command is started", async () => {
	for (const pattern of [/Type it/, /Run it/]) {
		const run = start(PARAMS, { herdr: split });
		run.answer({ selections: [run.indexOf(pattern)] });
		await run.done;
		const verbs = run.herdr.map((args) => args[1]);
		assert.deepEqual(verbs.slice(0, 2), ["split", "report-metadata"]);
		assert.deepEqual(run.herdr[1], TAG);
		assert.ok(verbs.indexOf("report-metadata") < verbs.indexOf("run"), "tagged before anything runs in the pane");
		assert.equal(run.herdr.filter((args) => args[1] === "report-metadata").length, 1);
		run.shutdown();
	}
});

test("a terminal pick never tags", async () => {
	for (const pattern of [/Type it/, /Run it/]) {
		const run = start(PARAMS, { herdr: split });
		run.pick(pattern);
		await run.done;
		assert.ok(run.herdr.some((args) => args[1] === "run"));
		assert.ok(!run.herdr.some((args) => args[1] === "report-metadata"));
		run.shutdown();
	}
});

test("an answer for a choice that opens no pane tags nothing", async () => {
	for (const pattern of [/prompt/, /clipboard/, /No, thanks/]) {
		const run = start(PARAMS, { herdr: split });
		run.answer({ selections: [run.indexOf(pattern)] });
		await run.done;
		assert.deepEqual(run.herdr, []);
	}
});

test("a refused answer tags nothing and leaves the selector to the terminal", async () => {
	const run = start(PARAMS, { herdr: split });
	run.answer({ selections: [run.indexOf(/Run it/)], digest: "0".repeat(64) });
	assert.deepEqual(run.herdr, []);
	run.pick(/No, thanks/);
	await run.done;
	assert.deepEqual(run.herdr, []);
});

test("when tagging fails the command still runs, once and untagged, with no retry", async () => {
	for (const failure of ["exit", "throw"] as const) {
		const run = start(PARAMS, { herdr: split, tagFails: failure });
		run.answer({ selections: [run.indexOf(/Run it/)] });
		const result = await run.done;
		assert.match(text(result) ?? "", /It is running there/);
		assert.equal(run.herdr.filter((args) => args[1] === "report-metadata").length, 1, "one attempt, no retry");
		assert.ok(run.herdr.some((args) => args[1] === "run"));
		run.shutdown();
	}
});
