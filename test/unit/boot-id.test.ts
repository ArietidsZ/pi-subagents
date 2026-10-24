import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { currentBootId, resetBootIdForTesting } from "../../src/runs/background/boot-id.ts";
import { runConfiguredSubagent } from "../../src/runs/background/subagent-runner-bootstrap.ts";

describe("boot id", () => {
	afterEach(() => resetBootIdForTesting());

	it("reads the OS once per process and caches the value", () => {
		let reads = 0;
		resetBootIdForTesting(() => {
			reads += 1;
			return "boot-a";
		});
		assert.equal(currentBootId(), "boot-a");
		assert.equal(currentBootId(), "boot-a");
		assert.equal(reads, 1);
	});

	it("caches a missing boot id instead of reading the OS again", () => {
		let reads = 0;
		resetBootIdForTesting(() => {
			reads += 1;
			return undefined;
		});
		assert.equal(currentBootId(), undefined);
		assert.equal(currentBootId(), undefined);
		assert.equal(reads, 1);
	});

	it("reads a real boot id on Linux and macOS", { skip: process.platform !== "linux" && process.platform !== "darwin" ? "no boot id on this platform" : undefined }, () => {
		assert.match(currentBootId() ?? "", /^[0-9a-f-]{36}$/i);
	});

	it("primes the runner from its config, so the runner never reads the boot id itself", async () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-id-runner-"));
		try {
			for (const [bootId, expected] of [["boot-from-pi", "boot-from-pi"], [undefined, undefined], ["", undefined]] as const) {
				let reads = 0;
				resetBootIdForTesting(() => {
					reads += 1;
					return "boot-read-by-runner";
				});
				let seen: string | undefined = "not-run";
				await runConfiguredSubagent({
					id: "run-boot",
					steps: [{ agent: "worker", task: "work", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }],
					resultPath: path.join(asyncDir, "result.json"),
					cwd: asyncDir,
					asyncDir,
					placeholder: "pending",
					...(bootId !== undefined ? { bootId } : {}),
				}, { loadExecutionModule: async () => ({ runConfiguredSubagentExecution: async () => { seen = currentBootId(); } }) });
				assert.equal(seen, expected, `config bootId ${JSON.stringify(bootId)}`);
				assert.equal(reads, 0);
			}
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});
});
