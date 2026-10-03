import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import followUp, { FOLLOW_UP_TYPE, POLL_MS } from "../src/follow-up.ts";

interface Entry {
	id: string;
	parentId: string | null;
	type: string;
	message?: Record<string, unknown>;
}

test("a recorded `!` command starts one turn; `!!`, busy, cancelled, and pre-empted commands do not", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const sent: { message: Record<string, unknown>; options: unknown }[] = [];
	followUp({
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
		sendMessage: (message: Record<string, unknown>, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI);

	const entries = new Map<string, Entry>([["root", { id: "root", parentId: null, type: "message", message: { role: "user" } }]]);
	let leaf = "root";
	let idle = true;
	let pending = false;
	let next = 0;
	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: { getLeafId: () => leaf, getEntry: (id: string) => entries.get(id) },
	};
	const append = (entry: Omit<Entry, "id" | "parentId">) => {
		const id = `e${next++}`;
		entries.set(id, { id, parentId: leaf, ...entry });
		leaf = id;
	};
	const record = (command: string, extra: Record<string, unknown> = {}) =>
		append({ type: "message", message: { role: "bashExecution", command, output: "ok", exitCode: 0, cancelled: false, ...extra } });
	const wait = () => new Promise((resolve) => setTimeout(resolve, POLL_MS * 2 + 30));
	const bash = (command: string, excludeFromContext = false) =>
		handlers.get("user_bash")?.({ type: "user_bash", command, excludeFromContext, cwd: "/" }, ctx);

	bash("git status");
	await wait();
	assert.equal(sent.length, 0, "no turn before the output is recorded");
	append({ type: "custom" });
	record("git status");
	await wait();
	assert.equal(sent.length, 1, "recorded `!` output starts one turn");
	assert.equal(sent[0]?.message.customType, FOLLOW_UP_TYPE);
	assert.equal(sent[0]?.message.display, false);
	assert.deepEqual(sent[0]?.options, { triggerTurn: true });
	await wait();
	assert.equal(sent.length, 1, "one turn per command");

	bash("ls", true);
	record("ls", { excludeFromContext: true });
	await wait();
	assert.equal(sent.length, 1, "`!!` starts no turn");

	idle = false;
	bash("pwd");
	record("pwd");
	await wait();
	assert.equal(sent.length, 1, "a command typed during a turn keeps pi's deferred behavior");
	idle = true;

	bash("sleep 9");
	record("sleep 9", { cancelled: true });
	await wait();
	assert.equal(sent.length, 1, "a cancelled command starts no turn");

	bash("make");
	handlers.get("agent_start")?.({}, ctx);
	record("make");
	await wait();
	assert.equal(sent.length, 1, "a prompt that started a turn meanwhile wins");

	bash("make");
	pending = true;
	record("make");
	await wait();
	assert.equal(sent.length, 1, "queued messages go first");
	pending = false;

	bash("npm test");
	handlers.get("session_shutdown")?.({}, ctx);
	record("npm test");
	await wait();
	assert.equal(sent.length, 1, "shutdown stops watching");
});
