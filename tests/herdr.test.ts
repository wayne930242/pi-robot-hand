import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkRun,
	endMarker,
	type Exec,
	findShell,
	MAX_OUTPUT_LINES,
	outcomeText,
	sliceOutput,
	startMarker,
	startRun,
	wrapperScript,
} from "../src/herdr.ts";

const shells = (["zsh", "bash"] as const).filter((shell) => findShell(process.env.PATH) === "zsh" || shell === "bash");

for (const shell of shells) {
	test(`the ${shell} wrapper runs the command, prints its markers, and records the exit code last`, () => {
		const dir = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
		writeFileSync(join(dir, "command"), "echo 'it''s here'; echo oops >&2; exit 7");
		writeFileSync(join(dir, "run"), wrapperScript(shell, dir, "t1", false));
		const out = execFileSync(shell, [join(dir, "run")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		assert.equal(readFileSync(join(dir, "status"), "utf8").trim(), "7");
		assert.equal(readFileSync(join(dir, "ran"), "utf8").trim(), "echo 'it''s here'; echo oops >&2; exit 7");
		assert.equal(out, `${startMarker("t1")}\nits here\n${endMarker("t1")}\n`);
	});
}

test("the typed form edits the line before running it", () => {
	assert.match(wrapperScript("zsh", "/tmp/x", "t", true), /vared -p '\$ ' cmd/);
	assert.match(wrapperScript("bash", "/tmp/x", "t", true), /read -r -e -i "\$cmd"/);
	assert.doesNotMatch(wrapperScript("zsh", "/tmp/x", "t", false), /vared/);
});

test("only the output between this run's markers reaches the model", () => {
	const screen = ["❯ zsh /tmp/run.zsh", "$ make", startMarker("ab"), "built", "", endMarker("ab"), "❯ "].join("\n");
	assert.equal(sliceOutput(screen, "ab"), "built");
	const long = [startMarker("ab"), ...Array.from({ length: MAX_OUTPUT_LINES + 5 }, (_, i) => `line ${i}`), endMarker("ab")].join("\n");
	const sliced = sliceOutput(long, "ab").split("\n");
	assert.equal(sliced[0], "[earlier output omitted]");
	assert.equal(sliced.length, MAX_OUTPUT_LINES + 1);
	assert.equal(sliced.at(-1), `line ${MAX_OUTPUT_LINES + 4}`);
});

function fakeHerdr(responses: Partial<Record<string, { stdout: string; code: number }>> = {}) {
	const calls: string[][] = [];
	const exec: Exec = async (args) => {
		calls.push(args);
		return responses[args[1] ?? ""] ?? { stdout: "", code: 0 };
	};
	return { calls, exec };
}

test("starting a run opens a pane below pi, focuses it, and types the wrapper into it", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
	const { calls, exec } = fakeHerdr({ split: { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }), code: 0 } });
	const run = await startRun(exec, { piPane: "w1:p2", cwd: "/repo", tmp, command: "sudo ls", type: true, shell: "zsh" });
	assert.equal(run.paneId, "w1:p9");
	assert.equal(readFileSync(join(run.dir, "command"), "utf8"), "sudo ls");
	assert.deepEqual(calls[0], ["pane", "split", "--pane", "w1:p2", "--direction", "down", "--ratio", "0.4", "--cwd", "/repo"]);
	assert.deepEqual(calls[1], ["pane", "focus", "--pane", "w1:p2", "--direction", "down"]);
	assert.deepEqual(calls[2], ["pane", "run", "w1:p9", `zsh ${join(run.dir, "run.zsh")}`]);
});

test("a failed split reports herdr's answer", async () => {
	const { exec } = fakeHerdr({ split: { stdout: '{"error":{"code":"pane_not_found"}}', code: 1 } });
	await assert.rejects(
		startRun(exec, { piPane: "x", cwd: "/", tmp: mkdtempSync(join(tmpdir(), "robot-hand-test-")), command: "ls", type: false, shell: "bash" }),
		/could not open a pane: .*pane_not_found/,
	);
});

test("the watcher reads a finished run, closes its pane, and notices a pane closed early", async () => {
	const dir = mkdtempSync(join(tmpdir(), "robot-hand-test-"));
	const run = { token: "ab", dir, paneId: "w1:p9", command: "make" };
	const screen = { stdout: [startMarker("ab"), "built", endMarker("ab")].join("\n"), code: 0 };

	let herdr = fakeHerdr({ read: screen });
	assert.equal(await checkRun(herdr.exec, run, false), undefined, "still running");
	assert.deepEqual(herdr.calls, []);

	herdr = fakeHerdr({ get: { stdout: "", code: 1 } });
	assert.deepEqual(await checkRun(herdr.exec, run, true), { kind: "closed" });

	writeFileSync(join(dir, "ran"), "make all\n");
	writeFileSync(join(dir, "status"), "2\n");
	herdr = fakeHerdr({ read: screen });
	assert.deepEqual(await checkRun(herdr.exec, run, false), { kind: "finished", ran: "make all", exitCode: 2, output: "built" });
	assert.deepEqual(herdr.calls.at(-1), ["pane", "close", "w1:p9"]);

	writeFileSync(join(dir, "status"), "cancelled\n");
	herdr = fakeHerdr();
	assert.deepEqual(await checkRun(herdr.exec, run, false), { kind: "cancelled" });
	assert.deepEqual(herdr.calls, [["pane", "close", "w1:p9"]]);
});

test("the result message tells the agent what ran and what to do next", () => {
	const text = outcomeText({ kind: "finished", ran: "make all", exitCode: 2, output: "built" }, "make");
	assert.match(text, /edited from `make`/);
	assert.match(text, /Exit code 2/);
	assert.match(text, /\$ make all\nbuilt/);
	assert.match(outcomeText({ kind: "cancelled" }, "make"), /nothing ran/);
	assert.match(outcomeText({ kind: "closed" }, "make"), /unknown/);
});
