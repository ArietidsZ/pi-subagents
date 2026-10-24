import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { awaitExistingAsyncRun, claimWorkflowAwaitedResult } from "../../src/runs/background/await-async-run.ts";
import { resetBootIdForTesting } from "../../src/runs/background/boot-id.ts";
import { currentPidNamespaceScope } from "../../src/runs/background/pid-namespace.ts";
import { resultFilesForToolCall, resultPayloadPathForIndexedRun, resultPayloadPathForSessionRun, retireResultSnapshot, withResultRunLease, writeAsyncResultFile, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";

let tempDir: string;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function childDir(runId = "child-run"): string {
	return path.join(tempDir, runId);
}

function writeStatus(asyncDir: string, fields: Record<string, unknown>): void {
	writeJson(path.join(asyncDir, "status.json"), {
		runId: path.basename(asyncDir),
		mode: "single",
		parentWorkflowRunId: "workflow-parent",
		sessionId: "session-a",
		state: "running",
		startedAt: 1,
		steps: [{ agent: "worker", status: "running" }],
		...fields,
	});
}

function writeResult(asyncDir: string, output: string): void {
	writeJson(path.join(asyncDir, "workflow-result.json"), {
		id: path.basename(asyncDir),
		runId: path.basename(asyncDir),
		sessionId: "session-a",
		toolCallId: "tool-call-a",
		state: "complete",
		success: true,
		results: [{ agent: "worker", output, success: true }],
	});
}

function deadPid(): number {
	const exited = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(exited.pid);
	return exited.pid;
}

describe("awaitExistingAsyncRun", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-await-async-run-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns an already published result without consuming or rewriting files", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { state: "complete", steps: [{ agent: "worker", status: "complete" }] });
		writeResult(asyncDir, "finished output");
		const files = ["status.json", "workflow-result.json"].map((name) => path.join(asyncDir, name));
		const before = files.map((file) => fs.readFileSync(file));

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "settled");
		assert.equal(outcome.status === "settled" && outcome.result.output, "finished output");
		assert.equal(outcome.status === "settled" && outcome.result.success, true);
		assert.equal(outcome.status === "settled" && outcome.result.exitCode, 0);
		assert.deepEqual(outcome.status === "settled" && outcome.result.importedPublication, { sessionId: "session-a", toolCallId: "tool-call-a", snapshot: before[1]!.toString("utf-8") });
		files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
	});

	it("waits for an active run to publish its result", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: process.pid });
		setTimeout(() => {
			writeResult(asyncDir, "late output");
			writeStatus(asyncDir, { pid: process.pid, state: "complete", steps: [{ agent: "worker", status: "complete" }] });
		}, 50);

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "settled");
		assert.equal(outcome.status === "settled" && outcome.result.output, "late output");
	});

	it("is unavailable when the status belongs to a different run", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { runId: "other-run", state: "complete" });
		writeResult(asyncDir, "other output");

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /belongs to run 'other-run'/);
	});

	it("is unavailable when the run directory is missing", async () => {
		const outcome = await awaitExistingAsyncRun(childDir("missing-run"), "missing-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /No async status/);
	});

	it("is unavailable when a terminal run has no result file", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { state: "complete", steps: [{ agent: "worker", status: "complete" }] });

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /ended without a result file/);
		assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "complete");
	});

	it("is unavailable when the runner died while status still says running", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: deadPid() });

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /exited without publishing a result/);
		assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "running");
	});

	it("is unavailable when a live-looking runner pid was saved before a reboot", async () => {
		const asyncDir = childDir();
		// This test process is alive, so only the boot id can say the recorded runner is gone.
		writeStatus(asyncDir, { pid: process.pid, pidNamespaceScope: currentPidNamespaceScope(), bootId: "boot-before" });
		resetBootIdForTesting(() => "boot-now");
		try {
			// Without the boot check the live pid would keep the wait open until this signal fires.
			const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", AbortSignal.timeout(5_000));

			assert.equal(outcome.status, "unavailable");
			assert.match(outcome.status === "unavailable" ? outcome.reason : "", /exited without publishing a result/);
		} finally {
			resetBootIdForTesting();
		}
	});

	it("ends a zombie wait only when the runner's PID namespace is verified", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
		const script = String.raw`
			const { spawn } = require("node:child_process");
			const fs = require("node:fs");
			const child = spawn(process.execPath, ["-e", 'process.title = "pi) zombie"; process.exit(0);'], { stdio: "ignore" });
			process.stdout.write(String(child.pid) + "\n");
			fs.readSync(0, Buffer.alloc(1), 0, 1, null);
		`;
		const parent = spawn(process.execPath, ["--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
		const closed = once(parent, "close");
		parent.stdin.on("error", () => {});
		try {
			const [output] = await once(parent.stdout, "data", { signal: AbortSignal.timeout(5_000) });
			const pid = Number(String(output).trim());
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			const deadline = Date.now() + 5_000;
			let stat = "";
			while (Date.now() < deadline) {
				stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
				if (stat[stat.lastIndexOf(") ") + 2] === "Z") break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.match(stat, /\(pi\) zombie\) Z /);
			assert.equal(process.kill(pid, 0), true);
			const scope = fs.readlinkSync("/proc/self/ns/pid", "utf-8").trim();
			for (const scenario of [
				{ name: "matching", recorded: scope, exited: true },
				{ name: "missing-recorded", recorded: undefined, exited: false },
				{ name: "different", recorded: "pid:[other]", exited: false },
			]) {
				const runId = `zombie-${scenario.name}`;
				const asyncDir = childDir(runId);
				writeStatus(asyncDir, { pid, ...(scenario.recorded !== undefined ? { pidNamespaceScope: scenario.recorded } : {}) });
				const statusPath = path.join(asyncDir, "status.json");
				const before = fs.readFileSync(statusPath);
				const publication = scenario.exited ? undefined : setTimeout(() => writeResult(asyncDir, "late output"), 50);
				try {
					const outcome = await awaitExistingAsyncRun(asyncDir, runId, AbortSignal.timeout(1500))
						.catch((error) => ({ status: "aborted" as const, reason: String(error) }));
					assert.equal(outcome.status, scenario.exited ? "unavailable" : "settled", scenario.name);
					if (outcome.status === "unavailable") assert.match(outcome.reason, /exited without publishing a result/);
					if (outcome.status === "settled") assert.equal(outcome.result.output, "late output");
					assert.deepEqual(fs.readFileSync(statusPath), before, "the exit probe must remain read-only");
				} finally {
					clearTimeout(publication);
				}
			}
		} finally {
			parent.stdin.end("reap");
			await closed;
		}
	});

	it("rejects with the abort reason while waiting", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: process.pid });
		const controller = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => controller.abort(new Error("workflow replaced")), 20);

		await assert.rejects(awaitExistingAsyncRun(asyncDir, "child-run", controller.signal), /workflow replaced/);
		assert.ok(Date.now() - startedAt < 2_000);
	});

	it("rejects immediately when already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already stopped"));

		await assert.rejects(awaitExistingAsyncRun(childDir(), "child-run", controller.signal), /already stopped/);
	});
});

describe("claimWorkflowAwaitedResult", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claim-awaited-result-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// The runner's paused result has no tool-call id and its final result adds one; state and timestamp can match.
	const paused = { id: "child-run", runId: "child-run", sessionId: "session-a", state: "paused", timestamp: 1_000, results: [{ agent: "worker", output: "", success: false }] };
	const final = { id: "child-run", toolCallId: "tool-call-a", sessionId: "session-a", state: "paused", timestamp: 1_000, results: [{ agent: "worker", output: "paused after interrupt", success: false }] };

	async function importPaused(asyncDir: string) {
		writeStatus(asyncDir, { state: "paused", steps: [{ agent: "worker", status: "paused" }] });
		writePendingAsyncResultFile(path.join(asyncDir, "workflow-result.json"), paused);
		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);
		assert.equal(outcome.status, "settled");
		return { runId: "child-run", ...(outcome.status === "settled" ? outcome.result.importedPublication : {}) };
	}

	function assertFinalPublished(asyncDir: string): void {
		const resultPath = path.join(asyncDir, "workflow-result.json");
		assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).toolCallId, "tool-call-a");
		assert.equal(resultPayloadPathForSessionRun(asyncDir, "session-a", "child-run"), resultPath);
		assert.equal(resultPayloadPathForIndexedRun(asyncDir, "child-run"), resultPath);
		assert.deepEqual(resultFilesForToolCall(asyncDir, "tool-call-a"), ["workflow-result.json"]);
	}

	it("does not claim a final result that replaced the paused result the claimant imported", async () => {
		const asyncDir = childDir();
		const read = await importPaused(asyncDir);
		writeAsyncResultFile(path.join(asyncDir, "workflow-result.json"), final);

		assert.equal(claimWorkflowAwaitedResult(asyncDir, "workflow-b", read), undefined);
		assertFinalPublished(asyncDir);
	});

	it("keeps a final result published after the claim when the claimed paused result is removed", async () => {
		const asyncDir = childDir();
		const resultPath = path.join(asyncDir, "workflow-result.json");
		const read = await importPaused(asyncDir);
		const claimedPath = claimWorkflowAwaitedResult(asyncDir, "workflow-b", read);
		assert.equal(claimedPath, `${resultPath}.workflow-b.claimed`);
		writeAsyncResultFile(resultPath, final);

		assert.equal(retireResultSnapshot(resultPath, read, claimedPath), "replaced");
		assert.equal(fs.existsSync(claimedPath!), false);
		assertFinalPublished(asyncDir);
	});

	it("does not claim while another process holds the run's lease", async () => {
		const asyncDir = childDir();
		const read = await importPaused(asyncDir);
		withResultRunLease(asyncDir, "child-run", () => assert.equal(claimWorkflowAwaitedResult(asyncDir, "workflow-b", read), undefined));
		assert.equal(fs.readFileSync(path.join(asyncDir, "workflow-result.json"), "utf-8"), read.snapshot);
	});
});
