import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatHerdrMachineRunnerUnsupported, resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

describe("Rex SSH machine resolution", () => {
	let home: string, project: string, userSettings: string, projectSettings: string, noHerdr: string;
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "rex-ssh-home-"));
		project = fs.mkdtempSync(path.join(os.tmpdir(), "rex-ssh-project-"));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		userSettings = path.join(home, ".pi", "agent", "settings.json");
		projectSettings = path.join(project, ".pi", "settings.json");
		noHerdr = path.join(home, "no-herdr");
	});
	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("resolves a user-settings rex entry to a Rex SSH machine without reading the Herdr catalog", () => {
		writeJson(userSettings, { subagents: { machines: { workmac: { rex: { ssh: "100.82.67.118" } } } } });
		writeJson(projectSettings, { subagents: { machines: { workmac: { cwd: "~/dev/app" } } } });
		assert.deepEqual(resolveMachinePlacement({ machine: "workmac", cwd: project, stepCwd: "packages/api", herdrBin: noHerdr }), { machine: { provider: "rex", id: "workmac", target: "100.82.67.118", cwd: "~/dev/app/packages/api" } });
		assert.throws(() => resolveMachinePlacement({ machine: "macmini", cwd: project, herdrBin: noHerdr }), /Herdr CLI .* was not found/u);
	});

	it("refuses a rex entry in project settings, under the reserved name local, or with unknown fields", () => {
		writeJson(projectSettings, { subagents: { machines: { workmac: { cwd: "/srv/app", rex: { ssh: "evil.example" } } } } });
		assert.throws(() => resolveMachinePlacement({ machine: "workmac", cwd: project, herdrBin: noHerdr }), /Move the rex entry to your user settings/u);
		fs.rmSync(projectSettings);
		writeJson(userSettings, { subagents: { machines: { local: { rex: { ssh: "100.82.67.118" } }, workmac: { cwd: "/srv/app", rex: { ssh: "100.82.67.118", session: "mine" } } } } });
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: project, herdrBin: noHerdr }), /'local' is reserved/u);
		assert.throws(() => resolveMachinePlacement({ machine: "workmac", cwd: project, herdrBin: noHerdr }), /invalid 'machines\.workmac\.rex'/u);
	});

	it("rejects non-Pi runners on a Rex SSH name before launch, where Herdr would accept them", () => {
		const claude = { machine: "workmac", agentName: "claude", runnerType: "external-cli", adapter: "claude-code" };
		assert.equal(formatHerdrMachineRunnerUnsupported(claude), undefined);
		writeJson(userSettings, { subagents: { machines: { workmac: { rex: { ssh: "100.82.67.118" } } } } });
		assert.match(formatHerdrMachineRunnerUnsupported(claude) ?? "", /machine 'workmac', but Rex supports native Pi children only/u);
		assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker" }), undefined);
	});
});
