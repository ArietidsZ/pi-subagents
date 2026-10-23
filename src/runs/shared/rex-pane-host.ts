import { createHash } from "node:crypto";
import * as path from "node:path";
import { Type, type StaticEncode, type TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { PlacementMachineReference, RexMachineReference } from "../../shared/types.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { localMachineAccess } from "./local-machine-access.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createPlacedRuntimeDir, PlacedRunOwner, removePlacedRuntimeDir } from "./placed-run-owner.ts";
import type { PlacementCommandResult, PlacementEvidenceProof, PlacementMachineAccess, PlacementOwnedPane, PlacementPaneHost, PlacementReconnectCheck, PlacementSockets } from "./placement-host.ts";
import { REX_EXIT_GONE, REX_EXIT_UNREACHABLE, resolveRexBinary, rexCommandEnv } from "./rex-machine.ts";

const REX_CALL_TIMEOUT_MS = 15_000, REX_MAX_OUTPUT = 1024 * 1024, REX_CLOSE_POLLS = 20, REX_CLOSE_POLL_MS = 50;
const sessionInspection = Compile(Type.Object({ session_id: Type.String() }));
const createdWindow = Compile(Type.Object({ window_id: Type.String(), block_ids: Type.Tuple([Type.String()]) }));
const sessionWindows = Compile(Type.Object({ windows: Type.Array(Type.Object({ window_id: Type.String(), label: Type.Optional(Type.String()), layers: Type.Array(Type.Object({ blocks: Type.Array(Type.Object({ block_id: Type.String() })) })) })) }));
const blockProcess = Compile(Type.Object({ foreground: Type.Object({ pid: Type.Integer() }) }));
const bridgeManifestPid = Compile(Type.Object({ pid: Type.Integer() }));

/** Rex runtime directories go under /tmp: the bridge socket path inside a macOS TMPDIR exceeds the unix socket path limit. */
function rexAccess(): PlacementMachineAccess { return localMachineAccess({ env: { ...rexCommandEnv(), TMPDIR: "/tmp" } }); }

interface RexEndpoint { access: PlacementMachineAccess; bin: string; session: string; server?: string }
export interface RexConnection extends RexEndpoint, PlacementSockets {}
export interface RexPaneCandidate { present: boolean; foregroundPid?: number; bridgePid?: number }

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
 * `window new` failed, timed out, or printed something unreadable, so the server may still have opened this run's window.
 * Find it by the run's tab label in the recorded session and close its blocks with the same close-then-prove-gone rule.
 */
async function closeUntrackedRexWindow(connection: RexConnection, label: string, failure: Error): Promise<never> {
	try {
		const inspected = await runRex(connection, ["session", "inspect", connection.session, "--json"], "session inspect");
		if (inspected.status === REX_EXIT_GONE) throw failure;
		requireRexSuccess(inspected, "session inspect");
		const windows = parseRexJson(inspected.stdout, sessionWindows, "session inspect")?.windows.filter((window) => window.label === label);
		if (!windows) throw new Error("Rex session inspect did not list the session's windows.");
		if (windows.length > 1) throw new Error(`The Rex session has ${windows.length} windows labeled ${label}; refusing to guess which one this run opened.`);
		for (const window of windows) for (const layer of window.layers) for (const block of layer.blocks) await closeOwnedRexPane(connection, { workspaceId: connection.session, tabId: window.window_id, paneId: block.block_id });
	} catch (cleanupError) {
		if (cleanupError === failure) throw failure;
		throw new AggregateError([failure, cleanupError], `Rex window new failed, and the window labeled ${label} that it may have opened could not be closed.`, { cause: failure });
	}
	throw failure;
}

/** Opens the run's background window; on any failure, closes the window the server may have opened before rethrowing. */
async function openRexWindow(connection: RexConnection, label: string, cwd: string, argv: string[]) {
	try {
		const created = await runRex(connection, ["window", "new", "-s", connection.session, label, "-c", cwd, "--focus=false", "--json", "--", ...argv], "window new");
		requireRexSuccess(created, "window new");
		const window = parseRexJson(created.stdout, createdWindow, "window new");
		if (!window) throw new Error(`Rex window new did not return exactly one block: ${created.stdout.trim().slice(0, 512)}`);
		return window;
	} catch (error) { return closeUntrackedRexWindow(connection, label, error instanceof Error ? error : new Error(String(error))); }
}

/**
 * Rex pane host: rex CLI calls on this machine, always with an explicit session. A local child opens as a background
 * window in the parent's session, started through the login shell's environment (as Rex starts any window) with the
 * bridge variables set by /usr/bin/env. There is no status subscription: the bridge socket is a direct local socket, so a
 * dead Pi closes it, and the reconnect that follows checks the block with `rex block call process` and fails closed.
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
		const window = await openRexWindow(connection, `subagent-${runId.slice(-8)}`, asRexMachine(machine).cwd, ["/usr/bin/env", ...environment.map(([name, value]) => `${name}=${value}`), pi.command, ...pi.args]);
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
		if (processInfo.status === REX_EXIT_GONE) return { present: false };
		requireRexSuccess(processInfo, "block process");
		const candidate: RexPaneCandidate = { present: true };
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
		// A short hash names the directory, so /tmp/pi-subagents-herdr-<hash>-XXXXXXXX/bridge.sock (57 bytes) fits the 103-byte macOS socket path limit for any run id.
		const access = rexAccess(), runtimeDir = await createPlacedRuntimeDir(access, createHash("sha256").update(runId).digest("hex").slice(0, 12));
		try { return new RexPlacedRunOwner(machine, runId, runtimeDir, await connectRex(machine, { access }), access); }
		catch (error) { try { removeRexRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Rex owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
	}
}
