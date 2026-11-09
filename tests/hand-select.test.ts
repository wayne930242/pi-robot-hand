import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../src/check.ts";
import { HandSelect } from "../src/hand-select.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function selector(check: (model: string, signal: AbortSignal) => Promise<CheckResult>) {
	const picked: (number | undefined)[] = [];
	const select = new HandSelect(
		{ title: "Robot Hand — r\n\n  ! ls", labels: ["a", "b", "c"], models: () => ["p/one", "p/two"], saved: () => "p/one", pick: () => {}, check },
		plain,
		() => {},
		(index) => picked.push(index),
	);
	return { select, picked };
}

test("j and k move like pi's selector and the cursor stops at the ends", () => {
	const { select, picked } = selector(async () => ({ model: "", verdict: "match", does: "", gaps: "" }));
	select.handleInput("k");
	select.handleInput("j");
	select.handleInput("j");
	select.handleInput("j");
	select.handleInput("\r");
	assert.deepEqual(picked, [2]);
});

test("a new check aborts the one still running, and closing aborts the last", () => {
	const signals: AbortSignal[] = [];
	const { select } = selector((_model, signal) => {
		signals.push(signal);
		return new Promise(() => {});
	});
	select.handleInput("e");
	select.handleInput("E");
	select.handleInput("\x1b[B");
	select.handleInput("\r");
	assert.equal(signals.length, 2);
	assert.equal(signals[0]?.aborted, true);
	assert.equal(signals[1]?.aborted, false);
	select.handleInput("\r");
	assert.equal(signals[1]?.aborted, true);
});
