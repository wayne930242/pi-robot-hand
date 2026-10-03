import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlacement, checkValue, extractSecret, type Placement, validatePlacement, verifyPlaced } from "../lib/placement.ts";

const env = (key: string): Placement => ({ mode: "env", key, quote: "auto" });

test("file mode replaces the whole content", () => {
	assert.equal(applyPlacement(undefined, { mode: "file" }, "abc").content, "abc");
	assert.equal(applyPlacement("old", { mode: "file" }, "new").content, "new");
});

test("env mode appends to a new or existing file", () => {
	assert.equal(applyPlacement(undefined, env("TOKEN"), "abc123").content, "TOKEN=abc123\n");
	assert.equal(applyPlacement("A=1", env("TOKEN"), "abc123").content, "A=1\nTOKEN=abc123\n");
});

test("env mode replaces existing lines, keeping export and other keys", () => {
	const before = "A=1\nexport TOKEN=old\nTOKEN_X=keep\n";
	const { content, summary } = applyPlacement(before, env("TOKEN"), "new");
	assert.equal(content, "A=1\nexport TOKEN=new\nTOKEN_X=keep\n");
	assert.match(summary, /updated TOKEN/);
});

test("env quoting round-trips through extractSecret", () => {
	for (const value of ["plain", "has space", "it's", 'q"uo$te`\\', "p@ss:w/rd+="]) {
		const { content } = applyPlacement(undefined, env("K"), value);
		assert.equal(extractSecret(content, env("K")), value, content);
	}
});

test("regex mode replaces capture group 1 and fails when absent", () => {
	const placement: Placement = { mode: "regex", pattern: "password:\\s*(\\S+)", flags: "" };
	const before = "user: a\npassword: CHANGEME\n";
	validatePlacement(placement, before);
	const { content } = applyPlacement(before, placement, "s3cret!");
	assert.equal(content, "user: a\npassword: s3cret!\n");
	assert.equal(extractSecret(content, placement), "s3cret!");
	assert.throws(() => validatePlacement(placement, "nothing here"), /does not match/);
	assert.throws(() => validatePlacement(placement, undefined), /existing file/);
	assert.ok(verifyPlaced(content, placement, "s3cret!"));
});

test("regex g flag replaces every match; value with $ is literal", () => {
	const placement: Placement = { mode: "regex", pattern: "<TOKEN>", flags: "g" };
	assert.equal(applyPlacement("a <TOKEN> b <TOKEN>", placement, "$1&x").content, "a $1&x b $1&x");
});

test("checkValue rejects empty and multi-line values outside file mode", () => {
	assert.match(checkValue({ mode: "file" }, "") ?? "", /empty/);
	assert.equal(checkValue({ mode: "file" }, "a\nb"), undefined);
	assert.match(checkValue(env("K"), "a\nb") ?? "", /single-line/);
	assert.match(checkValue({ mode: "env", key: "K", quote: "single" }, "it's") ?? "", /single quote/);
});

test("invalid env key is rejected", () => {
	assert.throws(() => validatePlacement(env("1BAD"), undefined), /Invalid env key/);
});

test("env replacement keeps trailing comments and CRLF line endings", () => {
	const before = "A=1\r\nTOKEN=old # rotated monthly\r\nQ=\"x y\" # quoted\r\n";
	const first = applyPlacement(before, env("TOKEN"), "it's new").content;
	assert.equal(first, "A=1\r\nTOKEN=\"it's new\" # rotated monthly\r\nQ=\"x y\" # quoted\r\n");
	assert.equal(extractSecret(first, env("TOKEN")), "it's new");
	const second = applyPlacement(first, env("Q"), "a#b c");
	assert.equal(extractSecret(second.content, env("Q")), "a#b c");
	assert.match(second.content, /^Q='a#b c' # quoted\r$/m);
	assert.ok(verifyPlaced(second.content, env("Q"), "a#b c"));
});

test("file placement refuses an existing destination unless overwrite is set", () => {
	assert.throws(() => validatePlacement({ mode: "file" }, "old"), /replace all of it/);
	validatePlacement({ mode: "file" }, "old", true);
	validatePlacement({ mode: "file" }, undefined);
});
