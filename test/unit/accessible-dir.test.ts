import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureAccessibleDir } from "../../src/shared/accessible-dir.ts";

class FakeFs {
	mkdirCalls = 0;
	accessCalls = 0;
	failMkdirCodes: string[] = [];
	failAccessCodes: string[] = [];

	mkdirSync(): void {
		this.mkdirCalls++;
		const failureCode = this.failMkdirCodes.shift();
		if (failureCode) {
			const error = new Error(`mkdir failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}

	accessSync(): void {
		this.accessCalls++;
		const failureCode = this.failAccessCodes.shift();
		if (failureCode) {
			const error = new Error(`access failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}
}

describe("ensureAccessibleDir", () => {
	it("retries transient shared-directory mkdir failures before validating access", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EBUSY"];
		const waits: number[] = [];

		ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		});

		assert.equal(fakeFs.mkdirCalls, 3);
		assert.equal(fakeFs.accessCalls, 1);
		assert.deepEqual(waits, [1, 2]);
	});

	it("retries transient shared-directory access failures without recreating the directory", () => {
		const fakeFs = new FakeFs();
		fakeFs.failAccessCodes = ["EPERM", "EACCES"];
		const waits: number[] = [];

		ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		});

		assert.equal(fakeFs.mkdirCalls, 1);
		assert.equal(fakeFs.accessCalls, 3);
		assert.deepEqual(waits, [1, 2]);
	});

	it("falls back to the pid directory after a short wait when the primary directory stays inaccessible", () => {
		const dirPath = "/tmp/pi-subagents-user/async-subagent-results";
		const denied = (target: string): void => {
			if (target !== dirPath) return;
			const error = new Error(`EPERM: ${target}`) as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		};

		for (const fsImpl of [{ mkdirSync: denied, accessSync: () => {} }, { mkdirSync: () => {}, accessSync: denied }]) {
			const waits: number[] = [];

			const result = ensureAccessibleDir(dirPath, {
				fs: fsImpl as any,
				pid: 4242,
				retryDirectoryErrors: true,
				wait: (delayMs) => waits.push(delayMs),
			});

			assert.equal(result, `${dirPath}-4242`);
			assert.ok(waits.length > 0);
			assert.ok(waits.reduce((sum, delayMs) => sum + delayMs, 0) <= 200, `waited ${waits.join("+")} ms`);
		}
	});

	it("keeps the primary directory when a permission error clears within the startup retries", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EPERM"];
		fakeFs.failAccessCodes = ["EACCES", "EACCES"];
		const waits: number[] = [];

		const result = ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			pid: 4242,
			retryDirectoryErrors: true,
			wait: (delayMs) => waits.push(delayMs),
		});

		assert.equal(result, "/tmp/pi-subagents-user/async-subagent-results");
		assert.equal(waits.length, 4);
	});

	it("throws non-retryable access failures without retrying", () => {
		const fakeFs = new FakeFs();
		fakeFs.failAccessCodes = ["ENOENT"];
		const waits: number[] = [];

		assert.throws(() => ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		}), /ENOENT/);
		assert.equal(fakeFs.mkdirCalls, 1);
		assert.equal(fakeFs.accessCalls, 1);
		assert.deepEqual(waits, []);
	});
});
