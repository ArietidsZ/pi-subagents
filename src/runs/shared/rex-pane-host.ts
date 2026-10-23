import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type StaticEncode, type TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { PlacementMachineReference, RexMachineReference } from "../../shared/types.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { localMachineAccess } from "./local-machine-access.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createPlacedRuntimeDir, PlacedRunOwner, removePlacedRuntimeDir } from "./placed-run-owner.ts";
import type { PlacementCommandResult, PlacementEvidenceProof, PlacementMachineAccess, PlacementOwnedPane, PlacementPaneHost, PlacementReconnectCheck, PlacementSockets } from "./placement-host.ts";

/** Rex CLI exit codes: 3 means the target is gone, 4 means the server is unreachable (state unknown, never "gone"). */
export const REX_EXIT_GONE = 3, REX_EXIT_UNREACHABLE = 4;
const REX_BUNDLE_BIN = "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex";
const REX_CALL_TIMEOUT_MS = 15_000, REX_MAX_OUTPUT = 1024 * 1024, REX_CLOSE_POLLS = 20, REX_CLOSE_POLL_MS = 50;
const sessionInspection = Compile(Type.Object({ session_id: Type.String() }));
const createdWindow = Compile(Type.Object({ window_id: Type.String(), block_ids: Type.Tuple([Type.String()]) }));
const blockProcess = Compile(Type.Object({ foreground: Type.Object({ pid: Type.Integer() }) }));
const bridgeManifestPid = Compile(Type.Object({ pid: Type.Integer() }));

function executable(file: string): boolean { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }

/** `$REX_BIN_DIR/rex`, then `rex` on PATH, then the Rex server bundle. */
export function resolveRexBinary(env: NodeJS.ProcessEnv = process.env): string {
	const fromDir = env.REX_BIN_DIR ? [path.join(env.REX_BIN_DIR, "rex")] : [];
	const fromPath = (env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, "rex"));
	const found = [...fromDir, ...fromPath, path.join(os.homedir(), REX_BUNDLE_BIN)].find(executable);
	if (!found) throw new Error("The Rex CLI was not found: set REX_BIN_DIR, put rex on PATH, or install Rex.");
	return found;
}

/** Every Rex selector comes from the recorded machine reference, never from the calling process's own Rex pane variables. */
export function rexCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const { REX_SESSION: _session, REX_BLOCK: _block, REX_SERVER: _server, ...env } = source;
	return env;
}

/** Rex runtime directories go under /tmp: the bridge socket path inside a macOS TMPDIR exceeds the unix socket path limit. */
function rexAccess(): PlacementMachineAccess { return localMachineAccess({ env: { ...rexCommandEnv(), TMPDIR: "/tmp" } }); }

interface RexEndpoint { access: PlacementMachineAccess; bin: string; session: string; server?: string }
export interface RexConnection extends RexEndpoint, PlacementSockets {}
export interface RexPaneCandidate { session: string; present: boolean; foregroundPid?: number; bridgePid?: number }

function asRexMachine(machine: PlacementMachineReference): RexMachineReference { if (machine.provider !== "rex") throw new Error("The Rex pane host only places runs on machine 'local'."); return machine; }

/** Runs one rex command with --autostart=false and the recorded server; exit 4 always throws. */
export async function runRex(endpoint: RexEndpoint, args: string[], what: string): Promise<PlacementCommandResult & { status: number }> {
	const globals = endpoint.server ? ["--autostart=false", "-S", endpoint.server] : ["--autostart=false"];
	const result = await endpoint.access.runAsync(endpoint.access.shellCommand('exec "$@"', [endpoint.bin, ...globals, ...args]), { timeout: REX_CALL_TIMEOUT_MS, maxBuffer: REX_MAX_OUTPUT });
	if (result.error) throw new Error(`Rex ${what} failed: ${result.error.message}`, { cause: result.error });
	if (result.status === REX_EXIT_UNREACHABLE) throw new Error(`The Rex server is unreachable (rex ${what} exited 4); the placed pane's state is unknown.`);
	if (result.status === null) throw new Error(`Rex ${what} did not finish; the placed pane's state is unknown.`);
	return { ...result, status: result.status };
}

function requireRexSuccess(result: PlacementCommandResult, what: string): void {
	if (result.status === REX_EXIT_GONE) throw new Error(`Rex ${what} failed because its target no longer exists (exit 3): ${result.stderr.trim().slice(0, 512)}`);
	if (result.status !== 0) throw new Error(`Rex ${what} exited with code ${result.status}: ${result.stderr.trim().slice(0, 512)}`);
}

/** Parses rex's JSON output against its schema; undefined when the shape does not match. */
function parseRexJson<T extends TSchema>(text: string, validator: Validator<{}, T>, what: string): StaticEncode<T, {}> | undefined {
	let value: unknown; try { value = JSON.parse(text); } catch { throw new Error(`Rex ${what} returned malformed JSON.`); }
	return validator.Check(value) ? value : undefined;
}

/** The server must confirm the recorded session; a missing session fails closed. */
export async function connectRex(machine: PlacementMachineReference, options: { bin?: string; access?: PlacementMachineAccess } = {}): Promise<RexConnection> {
	const rex = asRexMachine(machine), access = options.access ?? rexAccess();
	const endpoint: RexEndpoint = { access, bin: options.bin ?? resolveRexBinary(), session: rex.session };
	if (rex.server) endpoint.server = rex.server;
	const inspected = await runRex(endpoint, ["session", "inspect", rex.session, "--json"], "session inspect");
	if (inspected.status === REX_EXIT_GONE) throw new Error(`Rex session ${rex.session} no longer exists on the Rex server.`);
	requireRexSuccess(inspected, "session inspect");
	if (parseRexJson(inspected.stdout, sessionInspection, "session inspect")?.session_id !== rex.session) throw new Error("Rex session identity changed: the server reported a different session id.");
	return { ...endpoint, ...access.openSockets() };
}

async function inspectBlock(connection: RexConnection, blockId: string): Promise<"present" | "gone"> {
	const inspected = await runRex(connection, ["block", "inspect", "-s", connection.session, blockId], "block inspect");
	if (inspected.status === REX_EXIT_GONE) return "gone";
	requireRexSuccess(inspected, "block inspect");
	return "present";
}

/** Ownership is the never-reused block id in the recorded session. The block counts as closed only once `block inspect` exits 3. */
export async function closeOwnedRexPane(connection: RexConnection, owned: PlacementOwnedPane): Promise<void> {
	if (owned.workspaceId !== connection.session) throw new Error("Refusing Rex cleanup: the owned pane belongs to a different Rex session.");
	if (await inspectBlock(connection, owned.paneId) === "gone") return;
	const closed = await runRex(connection, ["block", "close", "-s", connection.session, owned.paneId], "block close");
	if (closed.status !== 0 && closed.status !== REX_EXIT_GONE) throw new Error(`Rex block close exited with code ${closed.status}: ${closed.stderr.trim().slice(0, 512)}`);
	for (let poll = 0; poll < REX_CLOSE_POLLS; poll++) {
		if (await inspectBlock(connection, owned.paneId) === "gone") return;
		await new Promise((resolve) => setTimeout(resolve, REX_CLOSE_POLL_MS));
	}
	throw new Error(`Rex block ${owned.paneId} still exists after close; refusing to report the placed pane closed.`);
}

export function reconcileRexPlacedRun(identity: HerdrRunIdentity, candidate: RexPaneCandidate, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck {
	if (candidate.session !== identity.session) return { ok: false, reason: "Rex session changed during reconnect." };
	if (!candidate.present) return { ok: false, reason: "Owned Rex block is gone." };
	if (candidate.foregroundPid === undefined || candidate.foregroundPid !== candidate.bridgePid) return { ok: false, reason: "The owned Rex block's foreground process is not the placed Pi." };
	const proof = proveEvidence(); if (!proof.ok) return proof;
	return { ok: true, state: "unknown", paneId: identity.paneId, cursor: proof.cursor };
}

async function readBridgePid(connection: RexConnection, runtimeDir: string): Promise<number | undefined> {
	const manifest = await connection.access.runAsync(connection.access.shellCommand('p="$1/manifest.json"; test -f "$p" && test ! -L "$p" && cat "$p"', [runtimeDir]), { timeout: 5_000, maxBuffer: 64 * 1024 });
	if (manifest.status !== 0) return undefined;
	return parseRexJson(manifest.stdout, bridgeManifestPid, "bridge manifest")?.pid;
}

/**
 * Rex pane host: rex CLI calls on this machine, always with an explicit session. A local child opens as a background
 * window in the parent's session. There is no status subscription: the bridge socket is a direct local socket, so a dead
 * Pi closes it, and the reconnect that follows checks the block with `rex block call process` and fails closed.
 */
export const rexPaneHost = {
	connect(machine) { return connectRex(machine); },
	sessionOf(connection) { return connection.session; },
	async launch(connection, machine, runId, _runtimeDir, request, onPane) {
		if (request.kind !== "pi") throw new Error("Rex supports native Pi children only for now.");
		const environment = Object.entries(request.environment ?? {});
		if (environment.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new Error("Rex launch environment names must be shell variable names.");
		const pi = getPiSpawnCommand(request.args);
		if (!path.isAbsolute(pi.command)) throw new Error("Rex placement needs an absolute Pi executable; set PI_SUBAGENT_PI_BINARY to the Pi binary path.");
		const created = await runRex(connection, ["window", "new", "-s", connection.session, `subagent-${runId.slice(-8)}`, "-c", asRexMachine(machine).cwd, "--focus=false", "--shell=none", "--json", "--", "/usr/bin/env", ...environment.map(([name, value]) => `${name}=${value}`), pi.command, ...pi.args], "window new");
		requireRexSuccess(created, "window new");
		const window = parseRexJson(created.stdout, createdWindow, "window new");
		if (!window) throw new Error("Rex window new did not return exactly one block.");
		const owned = { workspaceId: connection.session, tabId: window.window_id, paneId: window.block_ids[0] };
		await onPane(owned);
		return { owned, terminalId: owned.paneId };
	},
	async prompt(connection, identity, text) {
		requireRexSuccess(await runRex(connection, ["send", "-s", connection.session, "-b", identity.paneId, "--", text], "send"), "send");
		requireRexSuccess(await runRex(connection, ["send-key", "-s", connection.session, "-b", identity.paneId, "enter"], "send-key"), "send-key");
	},
	async subscribe() { return () => {}; },
	paneEvent() { return undefined; },
	async panes(connection, identity) {
		const processInfo = await runRex(connection, ["block", "call", "-s", connection.session, "-b", identity.paneId, "process"], "block process");
		if (processInfo.status === REX_EXIT_GONE) return { session: connection.session, present: false };
		requireRexSuccess(processInfo, "block process");
		const candidate: RexPaneCandidate = { session: connection.session, present: true };
		const foregroundPid = parseRexJson(processInfo.stdout, blockProcess, "block process")?.foreground.pid;
		if (foregroundPid !== undefined) candidate.foregroundPid = foregroundPid;
		const bridgePid = await readBridgePid(connection, identity.runtimeDir);
		if (bridgePid !== undefined) candidate.bridgePid = bridgePid;
		return candidate;
	},
	reconcile: reconcileRexPlacedRun,
	closeOwnedPane(connection, owned) { return closeOwnedRexPane(connection, owned); },
} satisfies PlacementPaneHost<RexConnection, RexPaneCandidate>;

function runtimeDirPresent(access: PlacementMachineAccess, runtimeDir: string): boolean {
	const result = access.run(access.shellCommand('test -e "$1" || test -L "$1"', [runtimeDir]), { timeout: 10_000, maxBuffer: 4096 });
	if (result.error) throw new Error(`Could not check the owned runtime directory: ${result.error.message}`, { cause: result.error });
	return result.status === 0;
}

/** A closed local Pi removes its own runtime directory on shutdown, so already-removed counts as removed. */
function removeRexRuntimeDir(access: PlacementMachineAccess, runtimeDir: string): void {
	if (!runtimeDirPresent(access, runtimeDir)) return;
	try { removePlacedRuntimeDir(access, runtimeDir); } catch (error) { if (runtimeDirPresent(access, runtimeDir)) throw error; }
}

/** The placed-run owner bound to Rex and local access. */
export class RexPlacedRunOwner extends PlacedRunOwner<RexConnection, RexMachineReference> {
	private constructor(machine: RexMachineReference, runId: string, runtimeDir: string, connection: RexConnection, access: PlacementMachineAccess) { super(machine, runId, runtimeDir, connection, rexPaneHost, access, () => removeRexRuntimeDir(access, runtimeDir)); }
	static async create(machine: RexMachineReference, runId: string): Promise<RexPlacedRunOwner> {
		const access = rexAccess(), runtimeDir = await createPlacedRuntimeDir(access, runId);
		try { return new RexPlacedRunOwner(machine, runId, runtimeDir, await connectRex(machine, { access }), access); }
		catch (error) { try { removeRexRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Rex owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
	}
}
