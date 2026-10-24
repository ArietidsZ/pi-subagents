import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, waitForAsyncState, ASYNC_DIR, tempDir, mockPi } from "../support/async-execution-fixture.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function pollFor<T>(label: string, read: () => T | undefined, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

type JournalRecord = { type: "start" | "settle"; key: string; runId?: string };
function readJournal(runId: string): JournalRecord[] {
	try {
		return fs.readFileSync(path.join(ASYNC_DIR, runId, "workflow-children.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JournalRecord);
	} catch {
		return [];
	}
}

describe("a workflow whose Pi process is killed", { skip: process.platform === "win32" ? "SIGKILL of a host process is POSIX-only here" : undefined }, () => {
	installAsyncExecutionHooks();

	it("reuses its finished child, re-attaches its running child, and launches the rest once after a SIGKILL", { timeout: 120_000 }, async () => {
		assert.ok(available && createSubagentExecutor, "fixture must not skip");
		const nonce = `owner-killed-${Date.now()}`;
		const release = path.join(tempDir, `${nonce}.release`);
		const script = `const first = await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); const second = await runs.run("stage2", { agent: "bg", task: "Stage two ${nonce}" }); const third = await runs.run("stage3", { agent: "echo", task: "Stage three ${nonce}" }); return { first: first.output, firstReused: first.reused === true, second: second.output, secondReused: second.reused === true, third: third.output };`;
		const args = { nonce };
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, waitForPath: release, output: "stage two done" });
		const callsBefore = mockPi.callCount();

		const hostOutput = path.join(tempDir, `${nonce}-host.json`);
		let host: ChildProcess | undefined;
		let stage2RunId: string | undefined;
		try {
			// The host inherits the test env: the same temp root and DIRS, the mock queue, and
			// PI_SUBAGENTS_TEST_PARENT_PID naming this test process, so its detached runner exits with the test.
			host = spawn(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(path.join(repo, "test/support/register-loader.mjs")).href, path.join(repo, "test/support/killable-workflow-host.mjs"), tempDir, `session-killed-${nonce}`, JSON.stringify({ workflowScript: script, args, async: true, mission: false }), hostOutput], { cwd: repo, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
			let hostStderr = "";
			host.stderr?.on("data", (chunk) => { hostStderr += String(chunk); });
			const hostExited = once(host, "exit");
			const launched = await pollFor("the host to launch the workflow", () => readJson<{ isError: boolean; text?: string; runId?: string }>(hostOutput), 30_000).catch((error: Error) => assert.fail(`${error.message}; host stderr: ${hostStderr}`));
			assert.equal(launched.isError, false, launched.text);
			const killedId = launched.runId!;

			// Kill only once stage1's result is journaled and stage2's runner is live.
			const journal = await pollFor("settle(stage1) and start(stage2) in the host's journal", () => {
				const records = readJournal(killedId);
				return records.some((record) => record.type === "settle" && record.key === "stage1") && records.some((record) => record.type === "start" && record.key === "stage2") ? records : undefined;
			}, 30_000);
			stage2RunId = journal.find((record) => record.type === "start" && record.key === "stage2")?.runId;
			assert.ok(stage2RunId);
			await pollFor("stage2's child to start", () => mockPi.callCount() >= callsBefore + 2 ? true : undefined, 30_000);
			assert.equal(process.kill(host.pid!, "SIGKILL"), true);
			const [, signal] = await Promise.race([hostExited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host did not exit after SIGKILL")), 10_000))]);
			assert.equal(signal, "SIGKILL");
			assert.equal((readJson<AsyncStatus>(path.join(ASYNC_DIR, killedId, "status.json")))?.state, "running", "a killed host leaves its run marked running");

			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage: () => {} },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo"), makeAgent("bg", { defaultAsync: true })] }),
			});
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => `session-relaunch-${nonce}`;
			mockPi.onCall({ matchArgIncludes: `Stage three ${nonce}`, output: "stage three done" });
			const relaunch = await executor.execute(`${nonce}-relaunch`, { workflowScript: script, args, async: true, mission: false, reuseFrom: killedId }, new AbortController().signal, undefined, ctx);
			assert.notEqual(relaunch.isError, true, relaunch.content[0]?.text);
			const relaunchId = relaunch.details.asyncId!;
			const killed = readJson<AsyncStatus>(path.join(ASYNC_DIR, killedId, "status.json"));
			assert.equal(killed?.state, "failed");
			assert.equal(killed?.workflow?.stopCause, "owner-exited");

			await waitForAsyncState(relaunchId, (status) => (status as AsyncStatus).workflow?.trace.some((entry) => entry.key === "stage2" && entry.state === "started") ?? false, 30_000);
			assert.equal(mockPi.callCount(), callsBefore + 2, "the relaunch launched nothing for stage1 or stage2");
			fs.writeFileSync(release, "go");
			const done = await waitForAsyncState(relaunchId, (status) => status.state === "complete" || status.state === "failed", 60_000) as AsyncStatus;
			assert.equal(done.state, "complete", done.error);
			assert.equal(done.workflow?.reusedFrom, killedId);
			assert.deepEqual(done.workflow?.value, { first: "stage one done", firstReused: true, second: "stage two done", secondReused: true, third: "stage three done" });
			assert.equal(done.steps?.find((step) => step.workflowKey === "stage2")?.runId, stage2RunId, "stage2 is the same run, not a second copy");
			assert.equal(mockPi.callCount(), callsBefore + 3, "stage1 and stage2 ran once each, stage3 exactly once");
		} finally {
			fs.writeFileSync(release, "go");
			if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
			// The stage2 runner outlives the host by design; once released it finishes and exits.
			if (stage2RunId) await waitForAsyncState(stage2RunId, (status) => ["complete", "failed", "stopped", "paused"].includes(status.state), 30_000).catch(() => undefined);
		}
	});
});
