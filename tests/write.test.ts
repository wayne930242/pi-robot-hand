import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "../src/secret-drop/registry.ts";
import { writeSecret } from "../lib/write.ts";

const dir = mkdtempSync(join(tmpdir(), "secret-drop-write-"));

test("new file is created with 0600 in a new directory", async () => {
	const path = join(dir, "nested", "key.pem");
	const outcome = await writeSecret(path, { mode: "file" }, "PEMDATA", undefined);
	assert.equal(readFileSync(path, "utf8"), "PEMDATA");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(outcome.created, true);
});

test("existing file keeps its mode unless fileMode is given, and leaves no temp files", async () => {
	const path = join(dir, ".env");
	writeFileSync(path, "A=1\n", { mode: 0o644 });
	await writeSecret(path, { mode: "env", key: "TOKEN", quote: "auto" }, "abc", undefined);
	assert.equal(readFileSync(path, "utf8"), "A=1\nTOKEN=abc\n");
	assert.equal(statSync(path).mode & 0o777, 0o644);
	await writeSecret(path, { mode: "env", key: "TOKEN", quote: "auto" }, "def", 0o600);
	assert.equal(readFileSync(path, "utf8"), "A=1\nTOKEN=def\n");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("a failed verification restores the original content and mode without leaving files", async () => {
	const sub = mkdtempSync(join(dir, "rollback-"));
	const path = join(sub, ".env");
	writeFileSync(path, "A=1\nTOKEN=old\n", { mode: 0o640 });
	await assert.rejects(
		writeSecret(path, { mode: "env", key: "TOKEN", quote: "auto" }, "new", 0o600, () => false),
		/restored the original content/,
	);
	assert.equal(readFileSync(path, "utf8"), "A=1\nTOKEN=old\n");
	assert.equal(statSync(path).mode & 0o777, 0o640);
	assert.deepEqual(readdirSync(sub), [".env"]);

	const fresh = join(sub, "new.key");
	await assert.rejects(writeSecret(fresh, { mode: "file" }, "k", undefined, () => false), /removed the new file/);
	assert.deepEqual(readdirSync(sub), [".env"]);
});

test("registry stores locations, not values, and dedupes by slot", async () => {
	const file = join(dir, "registry.json");
	const registry = new Registry(file);
	await registry.load();
	const base = { path: "/x/.env", label: "l", updatedAt: "t" };
	await registry.upsert({ ...base, placement: { mode: "env", key: "A", quote: "auto" } });
	await registry.upsert({ ...base, placement: { mode: "env", key: "A", quote: "auto" } });
	await registry.upsert({ ...base, placement: { mode: "env", key: "B", quote: "auto" } });
	const reloaded = new Registry(file);
	await reloaded.load();
	assert.equal(reloaded.list().length, 2);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(await reloaded.forget("/x/.env"), 2);
});
