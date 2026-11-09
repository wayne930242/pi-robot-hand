import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContext, findScripts, lastUserText, loadSecrets, parseCheck, redactInput, sinceUserText } from "../src/check.ts";

test("scripts the command runs are read; secret files, plain files, and binaries are not", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "robot-hand-check-")));
	const agentDir = join(dir, "agent");
	mkdirSync(join(agentDir, "secret-drop", "staging"), { recursive: true });
	writeFileSync(join(dir, "run.py"), "print('hi')\n");
	writeFileSync(join(dir, "tool"), "#!/bin/sh\necho tool\n");
	chmodSync(join(dir, "tool"), 0o755);
	writeFileSync(join(dir, "secret.sh"), "export TOKEN=abc\n");
	writeFileSync(join(dir, ".env"), "TOKEN=abc\n");
	writeFileSync(join(dir, "blob.sh"), Buffer.from([0x23, 0x21, 0x00, 0x01]));
	writeFileSync(join(agentDir, "secret-drop", "staging", "x.sh"), "#!/bin/sh\nstaged\n");
	writeFileSync(join(agentDir, "secret-drop", "registry.json"), JSON.stringify({ version: 1, entries: [{ path: join(dir, "secret.sh"), placement: { mode: "file" }, label: "x", updatedAt: "" }] }));
	const { isSecret } = await loadSecrets(join(agentDir, "secret-drop"));
	const scripts = await findScripts(
		`python3 run.py && ./tool --flag; source secret.sh; cat .env | sh blob.sh; sh ${join(agentDir, "secret-drop", "staging", "x.sh")}`,
		dir,
		isSecret,
	);
	assert.deepEqual(
		scripts.map((script) => script.path),
		[join(dir, "run.py"), join(dir, "tool")],
	);
	assert.equal(scripts[0]?.text, "print('hi')\n");
});

test("a long script is cut and marked", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "robot-hand-check-")));
	writeFileSync(join(dir, "big.sh"), `#!/bin/sh\n${"echo x\n".repeat(5000)}`);
	const [script] = await findScripts("sh big.sh", dir, () => false);
	assert.equal(script?.truncated, true);
	assert.equal(script?.text.length, 16_000);
});

test("a reply outside the asked JSON is shown as is with verdict unclear", () => {
	assert.deepEqual(parseCheck("m/x", 'Sure: {"verdict":"partial","does":"a","gaps":"b"}'), { model: "m/x", verdict: "partial", does: "a", gaps: "b" });
	assert.deepEqual(parseCheck("m/x", "It deletes files."), { model: "m/x", verdict: "unclear", does: "It deletes files.", gaps: "" });
	assert.equal(parseCheck("m/x", '{"verdict":"safe","does":"a"}').verdict, "unclear");
});

test("the user's last non-empty message is taken from the branch", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "first" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "second" }, { type: "image" }] } },
		{ type: "custom", message: undefined },
	];
	assert.equal(lastUserText(branch), "second");
	assert.equal(lastUserText([]), undefined);
	assert.equal(lastUserText([{ type: "message", message: { role: "user", content: "x".repeat(3000) } }])?.length, 2001);
});

test("a registry that cannot be read fails the check instead of protecting nothing", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "robot-hand-check-")));
	writeFileSync(join(dir, "registry.json"), "{ half written");
	await assert.rejects(loadSecrets(dir), /secret_drop's registry could not be read .*nothing was sent to the check model/);
	writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 2, entries: [] }));
	await assert.rejects(loadSecrets(dir), /could not be read/);
	const missing = await loadSecrets(join(dir, "nowhere"));
	assert.equal(missing.isSecret(join(dir, "x.sh")), false);
});

test("secret values are hidden from the check model wherever they appear", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "robot-hand-check-")));
	const drop = join(dir, "secret-drop");
	mkdirSync(drop);
	writeFileSync(join(dir, ".env"), "API_TOKEN=tok-s3cret-123\n");
	writeFileSync(drop + "/registry.json", JSON.stringify({ version: 1, entries: [{ path: join(dir, ".env"), placement: { mode: "env", key: "API_TOKEN", quote: "auto" }, label: "t", updatedAt: "" }] }));
	writeFileSync(join(dir, "uses.sh"), "curl -H 'Authorization: tok-s3cret-123' example.com\n");
	const secrets = await loadSecrets(drop);
	const scripts = await findScripts("bash uses.sh", dir, secrets.isSecret);
	const input = redactInput({ command: "TOKEN=tok-s3cret-123 bash uses.sh", kind: "shell", reason: "r", userMessage: "my token is tok-s3cret-123", scripts }, secrets.redact);
	const prompt = String(checkContext(input).messages[0]?.content);
	assert.doesNotMatch(prompt, /tok-s3cret-123/);
	assert.equal(prompt.split("[REDACTED]").length - 1, 3);
});

test("script text is fenced so it cannot close its own block", () => {
	const prompt = String(checkContext({ command: "sh x.sh", kind: "shell", reason: "r", scripts: [{ path: "/x.sh", text: "echo ```\n```", truncated: false }] }).messages[0]?.content);
	assert.match(prompt, /````\necho ```\n```\n````/);
});

test("what happened after the user's last message reaches the check, so a reply inside a tool counts", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "earlier" } },
		{ type: "message", message: { role: "user", content: "用 secret_drop 請我輸入 GitHub token" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好，開對話框。" }, { type: "toolCall", name: "secret_drop" }] } },
		{ type: "message", message: { role: "toolResult", toolName: "secret_drop", content: [{ type: "text", text: 'replied instead: "已經在 ~/.config/gh/hosts.yml 了"' }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "robot_hand" }] } },
	];
	assert.equal(
		sinceUserText(branch),
		'Agent: 好，開對話框。\nAgent called secret_drop\nsecret_drop result: replied instead: "已經在 ~/.config/gh/hosts.yml 了"\nAgent called robot_hand',
	);
	const prompt = String(checkContext({ command: "x", kind: "shell", reason: "r", userMessage: lastUserText(branch), since: sinceUserText(branch), scripts: [] }).messages[0]?.content);
	assert.match(prompt, /The user's last message:\n用 secret_drop.*What happened after that message, latest last:\nAgent: 好/s);
	assert.equal(sinceUserText([{ type: "message", message: { role: "user", content: "only" } }]), undefined);
	assert.equal(sinceUserText([]), undefined);
	const long = [{ type: "message", message: { role: "user", content: "u" } }, ...Array.from({ length: 20 }, () => ({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "y".repeat(400) }] } }))];
	const since = sinceUserText(long) ?? "";
	assert.equal(since.length, 2001);
	assert.ok(since.startsWith("…"));
});

test("text after the user's message is redacted too", () => {
	const input = redactInput({ command: "c", kind: "shell", reason: "r", since: "bash result: tok-123456", scripts: [] }, (text) => text.replaceAll("tok-123456", "[REDACTED]"));
	assert.equal(input.since, "bash result: [REDACTED]");
});
