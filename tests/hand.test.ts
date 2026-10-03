import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogTitle, options, promptText, type Reach, toOffer } from "../src/hand.ts";

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

const reach = (over: Partial<Reach> = {}): Reach => ({ hasDraft: false, canCopy: true, inHerdr: false, ...over });
const order = (list: { choice: string }[]) => list.map((option) => option.choice);

test("the clipboard and Herdr panes are offered only for shell commands where they work", () => {
	const shell = toOffer("ls", "shell");
	assert.deepEqual(order(options(shell, reach())), ["prompt", "clipboard", "cancel"]);
	assert.deepEqual(order(options(shell, reach({ canCopy: false }))), ["prompt", "cancel"]);
	assert.deepEqual(order(options(shell, reach({ inHerdr: true }))), ["prompt", "clipboard", "herdr-type", "herdr-run", "cancel"]);
	assert.deepEqual(order(options(toOffer("/reload", "pi"), reach({ inHerdr: true }))), ["prompt", "cancel"]);
});

test("the preferred choice comes first, falling back to what this session can reach", () => {
	const shell = toOffer("sudo apt upgrade", "shell");
	assert.deepEqual(order(options(shell, reach(), "clipboard")), ["clipboard", "prompt", "cancel"]);
	assert.deepEqual(order(options(shell, reach({ inHerdr: true }), "herdr-type")), ["herdr-type", "prompt", "clipboard", "herdr-run", "cancel"]);
	assert.deepEqual(order(options(shell, reach({ inHerdr: true }), "herdr-run"))[0], "herdr-run");
	assert.deepEqual(order(options(shell, reach(), "herdr-type")), ["clipboard", "prompt", "cancel"]);
	assert.deepEqual(order(options(shell, reach({ canCopy: false }), "herdr-run")), ["prompt", "cancel"]);
	assert.deepEqual(order(options(toOffer("/reload", "pi"), reach({ inHerdr: true }), "herdr-type")), ["prompt", "cancel"]);
});

test("the prompt choice says when it replaces the user's draft", () => {
	const shell = toOffer("ls", "shell");
	assert.equal(options(shell, reach())[0]?.label, "Put it in my prompt");
	assert.match(options(shell, reach({ hasDraft: true }))[0]?.label ?? "", /replaces my draft/);
});

test("the dialog title shows the reason and every line the user would run", () => {
	const title = dialogTitle(toOffer("cd /srv &&\nmake deploy", "shell"), "需要 sudo 權限");
	assert.equal(title, "Robot Hand — 需要 sudo 權限\n\n  ! cd /srv &&\n  make deploy");
});
