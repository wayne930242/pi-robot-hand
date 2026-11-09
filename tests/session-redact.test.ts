import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadSecrets } from "../src/check.ts";
import { REDACT_CHANNEL, Redactor, redactThrough, serveRedaction } from "../src/secret-drop/redact.ts";
import secretDrop from "../src/secret-drop/index.ts";

test("a secret fed to a command is redacted in the check through secret_drop, though no registry records it", async () => {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "robot-hand-agent-")));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const events = createEventBus();
	let tool: ToolDefinition | undefined;
	secretDrop({ registerTool: (definition: ToolDefinition) => (tool = definition), registerCommand: () => {}, on: () => {}, events } as unknown as ExtensionAPI);
	const value = "vault-pass-Q9x!7Lm2";
	let editor = "";
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: agentDir,
		ui: {
			custom: async () => ({ kind: "secret", value }),
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
				// The user runs the prefilled command: the apply script reports through the result file.
				const staged = text.match(/--from (\S+)/)?.[1];
				if (staged) writeFileSync(`${resolve(agentDir, staged)}.result`, JSON.stringify({ ok: true, message: "ran the command" }));
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	const params = { label: "Vault password", instructions: ["Type it"], format: "command", command: "ansible-vault view --vault-password-file {secret} vault.yml" };
	const result = await tool?.execute("call-1", params as never, undefined, undefined, ctx);
	assert.equal((result?.details as { status?: string }).status, "applied");

	const text = `the user said ${value} in chat`;
	const withoutSession = await loadSecrets(join(agentDir, "secret-drop"));
	assert.equal(withoutSession.redact(text), text, "the registry alone does not know the value");
	const secrets = await loadSecrets(join(agentDir, "secret-drop"), (t) => redactThrough(events, t));
	assert.equal(secrets.redact(text), "the user said [REDACTED] in chat");

	// `/secret-drop forget` clears the redactor; values fed to a command come back after it.
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const events2 = createEventBus();
	secretDrop({ registerTool: (definition: ToolDefinition) => (tool = definition), registerCommand: (name: string, command: never) => (commands[name] = command), on: () => {}, events: events2 } as unknown as ExtensionAPI);
	await tool?.execute("call-2", params as never, undefined, undefined, ctx);
	await commands["secret-drop"]?.handler("forget /nowhere/.env", { cwd: agentDir, ui: { notify: () => {} } });
	assert.equal(redactThrough(events2, text), "the user said [REDACTED] in chat");
});

test("the redaction channel answers during emit, ignores malformed requests, and leaves text alone without secret_drop", () => {
	const events = createEventBus();
	assert.equal(redactThrough(events, "abc s3cret-value"), "abc s3cret-value");
	const redactor = new Redactor();
	redactor.add("s3cret-value");
	const stop = serveRedaction(events, redactor);
	assert.equal(redactThrough(events, "abc s3cret-value"), "abc [REDACTED]");
	for (const bad of [null, { version: 2, text: "s3cret-value", reply: () => assert.fail() }, { version: 1, text: 3, reply: () => assert.fail() }, { version: 1, text: "x" }]) {
		events.emit(REDACT_CHANNEL, bad);
	}
	// A later responder sees the text already redacted, so echoing it back undoes nothing.
	const echo = events.on(REDACT_CHANNEL, (data) => (data as { text: string; reply: (t: string) => void }).reply((data as { text: string }).text));
	assert.equal(redactThrough(events, "abc s3cret-value"), "abc [REDACTED]");
	echo();
	stop();
	assert.equal(redactThrough(events, "abc s3cret-value"), "abc s3cret-value");
});
