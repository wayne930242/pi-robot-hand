import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findLegacySecretDrop, legacyNotice } from "../src/secret-drop/legacy.ts";

function setup(global: unknown[] | undefined, project: unknown[] | undefined) {
	const agentDir = mkdtempSync(join(tmpdir(), "robot-hand-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "robot-hand-cwd-"));
	if (global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: global }));
	if (project) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: project }));
	}
	return { agentDir, cwd };
}

test("a separately configured pi-secret-drop is found in global or project settings", () => {
	let dirs = setup(["npm:pi-robot-hand@0.2.0", "npm:pi-secret-drop@0.1.6"], undefined);
	assert.deepEqual(findLegacySecretDrop(dirs.agentDir, dirs.cwd), {
		source: "npm:pi-secret-drop@0.1.6",
		settings: join(dirs.agentDir, "settings.json"),
		local: false,
	});
	dirs = setup(["npm:pi-robot-hand"], [{ source: "git:github.com/wayne930242/pi-secret-drop@abc" }]);
	assert.equal(findLegacySecretDrop(dirs.agentDir, dirs.cwd)?.local, true);
	dirs = setup(["npm:pi-robot-hand", "npm:pi-secret-drop-extra", "../pi-secret-dropper"], undefined);
	assert.equal(findLegacySecretDrop(dirs.agentDir, dirs.cwd), undefined);
	dirs = setup(undefined, undefined);
	assert.equal(findLegacySecretDrop(dirs.agentDir, dirs.cwd), undefined);
});

test("the notice gives the exact remove command", () => {
	assert.match(legacyNotice({ source: "npm:pi-secret-drop@0.1.6", settings: "/s.json", local: false }), /`pi remove npm:pi-secret-drop@0\.1\.6`/);
	assert.match(legacyNotice({ source: "npm:pi-secret-drop", settings: "/s.json", local: true }), /`pi remove -l npm:pi-secret-drop`/);
});
