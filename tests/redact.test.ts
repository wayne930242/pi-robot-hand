import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, Redactor } from "../src/secret-drop/redact.ts";

test("redacts values in nested structures and keeps references when unchanged", () => {
	const r = new Redactor();
	r.add("hunter2-secret");
	const content = [{ type: "text", text: "token=hunter2-secret done" }];
	const out = r.redactDeep(content);
	assert.notEqual(out, content);
	assert.equal(out[0]?.text, `token=${REDACTED} done`);
	const clean = [{ type: "text", text: "nothing" }];
	assert.equal(r.redactDeep(clean), clean);
});

test("short values are ignored; multi-line secrets redact per line", () => {
	const r = new Redactor();
	r.add("abc");
	assert.equal(r.size, 0);
	r.add("-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END KEY-----\n");
	assert.equal(r.redactText("line MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"), `line ${REDACTED}`);
});
