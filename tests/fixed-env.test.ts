import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedEnvLine, fixedEnvPath, startRun, type Exec } from "../src/herdr.ts";

function fakeHerdr() {
	const calls: string[][] = [];
	const exec: Exec = async (args) => {
		calls.push(args);
		if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }), code: 0 };
		return { stdout: "", code: 0 };
	};
	return { calls, exec };
}

const python = spawnSync("python3", ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], { encoding: "utf8" });
const git = spawnSync("git", ["--version"], { encoding: "utf8" });

test("the fixed line replaces the shell with a startup-free bash that inherits only a fixed list", () => {
	const line = fixedEnvLine("/tmp/x/run.bash", { TERM: "xterm", LANG: "C.UTF-8", BASH_ENV: "/home/u/evil", SSH_AUTH_SOCK: "/run/user/1/ssh" }, "u", "/home/u");
	assert.match(line, /^exec \/usr\/bin\/env -i /);
	assert.match(line, / bash --noprofile --norc \/tmp\/x\/run\.bash$/);
	assert.match(line, /PATH=\/run\/current-system\/sw\/bin:\/etc\/profiles\/per-user\/u\/bin:\/usr\/bin:\/bin/);
	for (const part of ["HOME=/home/u", "TERM=xterm", "LANG=C.UTF-8", "INPUTRC=/dev/null", "PYTHONNOUSERSITE=1", "GIT_CONFIG_KEY_0=core.fsmonitor", "GIT_CONFIG_VALUE_0=false", "SSH_AUTH_SOCK=/run/user/1/ssh"]) {
		assert.ok(line.includes(part), part);
	}
	assert.doesNotMatch(line, /BASH_ENV|\/home\/u\/evil/);
	assert.equal(fixedEnvPath("u").includes("/home/"), false);
});

test("an answered run types the fixed line and always writes a bash wrapper", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
	const { calls, exec } = fakeHerdr();
	const run = await startRun(exec, { piPane: "w1:p2", cwd: "/repo", tmp, command: "ls", type: false, shell: "zsh", answerId: "answer-id-0123456789" });
	const typed = calls.find((args) => args[1] === "run");
	assert.ok(typed);
	assert.match(typed[3] ?? "", /^exec \/usr\/bin\/env -i .* bash --noprofile --norc .*run\.bash$/);
	assert.ok(existsSync(join(run.dir, "run.bash")));
	assert.equal(existsSync(join(run.dir, "run.zsh")), false);
});

test("a run a person chose keeps the user's shell as before", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
	const { calls, exec } = fakeHerdr();
	await startRun(exec, { piPane: "w1:p2", cwd: "/repo", tmp, command: "ls", type: false, shell: "bash" });
	const typed = calls.find((args) => args[1] === "run");
	assert.match(typed?.[3] ?? "", /^bash \S+run\.bash$/);
});

test("the fixed line runs the command without code planted in the environment or home", { skip: python.status !== 0 || git.status !== 0 ? "python3 and git are needed" : false }, async () => {
	const home = mkdtempSync(join(tmpdir(), "robot-hand-home-"));
	const marks = join(home, "marks");
	mkdirSync(marks);
	const plant = (name: string) => `touch ${join(marks, name)}`;
	writeFileSync(join(home, "evil-env.sh"), `${plant("bash_env")}\n`);
	writeFileSync(join(home, ".bashrc"), `${plant("bashrc")}\n`);
	writeFileSync(join(home, ".bash_profile"), `${plant("bash_profile")}\n`);
	writeFileSync(join(home, ".profile"), `${plant("profile")}\n`);
	const site = join(home, ".local", "lib", `python${python.stdout.trim()}`, "site-packages");
	mkdirSync(site, { recursive: true });
	writeFileSync(join(site, "usercustomize.py"), `open(${JSON.stringify(join(marks, "usercustomize"))}, "w").close()\n`);
	writeFileSync(join(site, "planted.pth"), `import os; open(${JSON.stringify(join(marks, "pth"))}, "w").close()\n`);
	const repo = join(home, "repo");
	mkdirSync(repo);
	const fsmonitor = join(home, "fsmonitor.sh");
	writeFileSync(fsmonitor, `#!/bin/sh\n${plant("fsmonitor")}\n`, { mode: 0o755 });
	const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
	for (const args of [["init", "-q"], ["config", "core.fsmonitor", fsmonitor]]) spawnSync("git", args, { cwd: repo, env: gitEnv });

	const dir = mkdtempSync(join(tmpdir(), "robot-hand-run-"));
	const script = join(dir, "run.bash");
	writeFileSync(script, `git status --short >/dev/null 2>&1\npython3 -c 'print(1)' >/dev/null\n[ "$(type -t git)" = file ] && echo ran > ${join(dir, "out")}\n`);
	const line = fixedEnvLine(script, { TERM: "dumb", PI_ROBOT_HAND_FIXED_PATH: process.env.PATH }, "robot", home);
	// POSIX-mode sh ignores BASH_ENV itself, so only an inherited copy could reach the fixed bash.
	const result = spawnSync("/bin/sh", ["-c", line], {
		cwd: repo,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: home, BASH_ENV: join(home, "evil-env.sh"), ENV: join(home, "evil-env.sh"), "BASH_FUNC_git%%": "() { echo shadowed; }", PYTHONPATH: site },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(dir, "out"), "utf8").trim(), "ran");
	for (const name of ["bash_env", "bashrc", "bash_profile", "profile", "usercustomize", "pth", "fsmonitor"]) {
		assert.equal(existsSync(join(marks, name)), false, `${name} ran`);
	}
});
