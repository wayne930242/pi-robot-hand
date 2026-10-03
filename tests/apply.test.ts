import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApplyCommand, waitForResult } from "../src/secret-drop/stage.ts";

const script = fileURLToPath(new URL("../dist/apply.js", import.meta.url));
const SECRET = "p@ss w'rd$X`y\\z-0123456789";

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "secret-drop-apply-"));
	const staged = join(dir, "staged");
	writeFileSync(staged, SECRET, { mode: 0o600 });
	return { dir, staged };
}

/** Run the exact command line the extension pre-fills, minus the leading `!`. */
function runPrefilled(line: string, cwd: string) {
	return spawnSync("sh", ["-c", line], { cwd, encoding: "utf8" });
}

test("env: prefilled command updates the key, reports a length check, never the value", async () => {
	const { dir, staged } = setup();
	writeFileSync(join(dir, ".env"), "APP=demo\nexport DB_PASSWORD=CHANGEME\n");
	const line = buildApplyCommand(script, staged, {
		format: "placement",
		destination: join(dir, ".env"),
		placement: { mode: "env", key: "DB_PASSWORD", quote: "auto" },
	}, dir);
	assert.match(line, / env \.\/\.env DB_PASSWORD --from /);
	const run = runPrefilled(line, dir);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /updated DB_PASSWORD \(1 line\) in \.\/\.env .* length check passed \(26 chars\)/);
	assert.ok(!run.stdout.includes(SECRET) && !run.stderr.includes(SECRET));
	const env = readFileSync(join(dir, ".env"), "utf8");
	const sourced = execFileSync("sh", ["-c", ". ./.env; printf %s \"$DB_PASSWORD\""], { cwd: dir, encoding: "utf8" });
	assert.equal(sourced, SECRET, env);
	assert.equal(existsSync(staged), false);
	assert.deepEqual(await waitForResult(staged, undefined), { ok: true, message: run.stdout.replace(/^✓ secret-drop: /, "").trim() });
});

test("regex: replaces the slot in a config file", () => {
	const { dir, staged } = setup();
	writeFileSync(join(dir, "config.yml"), 'db:\n  password: "CHANGEME"\n');
	const line = buildApplyCommand(script, staged, {
		format: "placement",
		destination: join(dir, "config.yml"),
		placement: { mode: "regex", pattern: 'password: "([^"]*)"', flags: "" },
	}, dir);
	const run = runPrefilled(line, dir);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(readFileSync(join(dir, "config.yml"), "utf8"), `db:\n  password: "${SECRET}"\n`);
});

test("regex mismatch fails and discards the staged file", async () => {
	const { dir, staged } = setup();
	writeFileSync(join(dir, "config.yml"), "nothing\n");
	const line = buildApplyCommand(script, staged, {
		format: "placement",
		destination: join(dir, "config.yml"),
		placement: { mode: "regex", pattern: "password: (.*)", flags: "" },
	}, dir);
	const run = runPrefilled(line, dir);
	assert.equal(run.status, 1);
	assert.match(run.stderr, /does not match/);
	assert.equal(existsSync(staged), false);
	assert.equal((await waitForResult(staged, undefined))?.ok, false);
});

test("exec: {secret} is the staged path, stdout is suppressed, stderr is redacted", () => {
	const { dir, staged } = setup();
	const ok = buildApplyCommand(script, staged, { format: "exec", command: "cat {secret} > out.txt; cat {secret}" }, dir);
	const run = runPrefilled(ok, dir);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), SECRET);
	assert.match(run.stdout, /command exited 0 .* bytes of stdout suppressed/);
	assert.ok(!run.stdout.includes(SECRET));

	const second = setup();
	const bad = buildApplyCommand(script, second.staged, { format: "exec", command: "cat {secret} >&2; exit 3" }, second.dir);
	const failed = runPrefilled(bad, second.dir);
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /command exited 3:\n\[REDACTED\]/);
	assert.ok(!failed.stderr.includes(SECRET));
});

test("file: an existing destination is kept unless the command carries --overwrite", () => {
	const { dir, staged } = setup();
	writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
	const plan = { format: "placement" as const, destination: join(dir, ".env"), placement: { mode: "file" as const } };
	const refused = runPrefilled(buildApplyCommand(script, staged, plan, dir), dir);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /replace all of it/);
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=1\nB=2\n");
	assert.equal(existsSync(staged), false);

	const second = setup();
	writeFileSync(join(second.dir, "tls.key"), "OLD");
	const line = buildApplyCommand(script, second.staged, { ...plan, destination: join(second.dir, "tls.key"), overwrite: true }, second.dir);
	assert.match(line, / file \.\/tls\.key --overwrite --from /);
	const run = runPrefilled(line, second.dir);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(readFileSync(join(second.dir, "tls.key"), "utf8"), SECRET);
});

test("rerunning after apply reports the staged value is gone", () => {
	const { dir, staged } = setup();
	const line = buildApplyCommand(script, staged, { format: "placement", destination: join(dir, "k"), placement: { mode: "file" } }, dir);
	assert.equal(runPrefilled(line, dir).status, 0);
	const again = runPrefilled(line, dir);
	assert.equal(again.status, 1);
	assert.match(again.stderr, /staged secret not found/);
});

test("waitForResult resolves null on abort", async () => {
	const { staged } = setup();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	assert.equal(await waitForResult(staged, controller.signal, 10), null);
});
