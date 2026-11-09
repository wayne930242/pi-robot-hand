import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findScripts, lastUserText, parseCheck, protectedPaths, secretGuard } from "../src/check.ts";

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
	writeFileSync(join(agentDir, "secret-drop", "registry.json"), JSON.stringify({ version: 1, entries: [{ path: join(dir, "secret.sh") }] }));
	const isSecret = secretGuard(await protectedPaths(join(agentDir, "secret-drop", "registry.json")), join(agentDir, "secret-drop"));
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
