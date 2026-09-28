import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogTitle, options, promptText, toOffer } from "../src/hand.ts";

test("a shell command goes to the prompt behind pi's ! prefix", () => {
	const offer = toOffer("  sudo systemctl restart nginx ", undefined);
	assert.deepEqual(offer, { command: "sudo systemctl restart nginx", kind: "shell" });
	assert.equal(promptText(offer), "! sudo systemctl restart nginx");
});

test("a pi slash command goes to the prompt as-is", () => {
	assert.equal(promptText(toOffer("/reload", "pi")), "/reload");
});

test("malformed commands are refused with a message the agent can act on", () => {
	assert.throws(() => toOffer("   ", undefined), /empty/);
	assert.throws(() => toOffer("! ls", "shell"), /without a leading `!`/);
	assert.throws(() => toOffer("reload", "pi"), /slash command/);
});

test("the clipboard is offered only for shell commands in the terminal UI", () => {
	const shell = toOffer("ls", "shell");
	assert.deepEqual(
		options(shell, false, true).map((option) => option.choice),
		["prompt", "clipboard", "cancel"],
	);
	assert.deepEqual(
		options(shell, false, false).map((option) => option.choice),
		["prompt", "cancel"],
	);
	assert.deepEqual(
		options(toOffer("/reload", "pi"), false, true).map((option) => option.choice),
		["prompt", "cancel"],
	);
});

test("the prompt choice says when it replaces the user's draft", () => {
	const shell = toOffer("ls", "shell");
	assert.equal(options(shell, false, true)[0]?.label, "Put it in my prompt");
	assert.match(options(shell, true, true)[0]?.label ?? "", /replaces my draft/);
});

test("the dialog title shows the reason and every line the user would run", () => {
	const title = dialogTitle(toOffer("cd /srv &&\nmake deploy", "shell"), "需要 sudo 權限");
	assert.equal(title, "Robot Hand — 需要 sudo 權限\n\n  ! cd /srv &&\n  make deploy");
});
