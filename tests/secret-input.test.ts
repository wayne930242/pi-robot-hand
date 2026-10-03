import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogOptions } from "../src/secret-drop/secret-input.ts";

test("PI_ASK_USER_DISPLAY_MODE=inline renders the dialog inline", () => {
	assert.deepEqual(dialogOptions({ PI_ASK_USER_DISPLAY_MODE: "inline" }), { overlay: false });
});

test("the dialog is a centered overlay by default and for other values", () => {
	for (const env of [{}, { PI_ASK_USER_DISPLAY_MODE: "overlay" }, { PI_ASK_USER_DISPLAY_MODE: "Inline" }]) {
		const options = dialogOptions(env);
		assert.equal(options.overlay, true, JSON.stringify(env));
		assert.equal(options.overlayOptions?.anchor, "center");
	}
});

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type DialogResult, SecretInput, type SecretPrompt } from "../src/secret-drop/secret-input.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function dialog(prompt: Partial<SecretPrompt> = {}) {
	const results: (DialogResult | null)[] = [];
	const input = new SecretInput(
		{
			title: "Secret Drop",
			label: "GitHub PAT",
			steps: ["Open Settings → Developer settings", "Create a fine-grained token for merlin-pai-2", "Copy the token"],
			url: "https://github.com/settings/personal-access-tokens/new",
			rows: [["Goes to", "vault.yml"]],
			footer: "Stuck? Press Tab and ask.",
			check: (v) => (v ? undefined : "Value is empty."),
			maxLines: () => 60,
			...prompt,
		},
		plain,
		() => {},
		(r) => results.push(r),
	);
	const type = (text: string) => {
		for (const ch of text) input.handleInput(ch);
	};
	return { input, results, type, screen: () => input.render(80).join("\n") };
}

test("the dialog shows numbered steps and the link above the input", () => {
	const { screen } = dialog();
	const text = screen();
	assert.match(text, /How to get it/);
	assert.match(text, /1\. Open Settings → Developer settings/);
	assert.match(text, /3\. Copy the token/);
	assert.match(text, /Open {2}https:\/\/github\.com\/settings\/personal-access-tokens\/new/);
	assert.ok(text.indexOf("Copy the token") < text.indexOf("type or paste the secret"));
});

test("Enter stages the masked secret", () => {
	const { input, results, type, screen } = dialog();
	type("ghp_abc");
	assert.doesNotMatch(screen(), /ghp_abc/);
	input.handleInput("\r");
	assert.deepEqual(results, [{ kind: "secret", value: "ghp_abc" }]);
});

test("Tab switches to a visible question; Enter returns it and drops the secret", () => {
	const { input, results, type, screen } = dialog();
	type("half-typed");
	input.handleInput("\t");
	type("哪裡找 Workflows 權限？");
	assert.match(screen(), /\? 哪裡找 Workflows 權限？/);
	assert.match(screen(), /Enter send question/);
	input.handleInput("\r");
	assert.deepEqual(results, [{ kind: "question", text: "哪裡找 Workflows 權限？" }]);
});

test("an empty question keeps the dialog open; Tab goes back to the secret", () => {
	const { input, results, type, screen } = dialog();
	input.handleInput("\t");
	input.handleInput("\r");
	assert.deepEqual(results, []);
	assert.match(screen(), /Type your question first/);
	input.handleInput("\t");
	type("s3cret");
	input.handleInput("\r");
	assert.deepEqual(results, [{ kind: "secret", value: "s3cret" }]);
});

test("Esc cancels", () => {
	const { input, results } = dialog();
	input.handleInput("\x1b");
	assert.deepEqual(results, [null]);
});

test("long steps give way so the input stays on screen", () => {
	const steps = Array.from({ length: 10 }, (_, i) => `step ${i + 1} with some words`);
	const { input } = dialog({ steps, maxLines: () => 20 });
	const lines = input.render(80);
	assert.ok(lines.length <= 20, `${lines.length} lines`);
	const text = lines.join("\n");
	assert.match(text, /type or paste the secret/);
	assert.match(text, /more lines?; the full steps are in the chat above/);
});
