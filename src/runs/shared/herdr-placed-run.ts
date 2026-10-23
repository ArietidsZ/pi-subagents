import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import packageJson from "../../../package.json" with { type: "json" };
import type { HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { sshMachineAccess, type HerdrForwardedConnection } from "./herdr-connection.ts";
import { herdrPaneHost } from "./herdr-pane-host.ts";
import { encodeHerdrPiFrame, HERDR_PI_PROTOCOL, HerdrPiFrameDecoder, validateHerdrPiRunId, type HerdrPiFrame } from "./herdr-pi-protocol.ts";
import type { PlacementAgentKind, PlacementBridgeIdentity, PlacementMachineAccess, PlacementOwnedPane, PlacementPaneHost, PlacementReconnectCheck, PlacementRunState, PlacementSockets, PlacementStartOptions } from "./placement-host.ts";
import { getAgentDir } from "../../shared/utils.ts";

export interface HerdrRunIdentity { runId: string; machineId: string; target: string; session: string | null; workspaceId: string; tabId: string; paneId: string; terminalId: string; agentName: string; nativeSessionId: string; cwd: string; runtimeDir: string }
export interface HerdrRunSnapshot { connection: "connected" | "unknown" | "closed"; state: PlacementRunState; identity?: HerdrRunIdentity; revision: number }

/** The pane half comes from the host; the bridge half (run, package, protocol, native session, evidence cursor) is host-neutral. */
export function reconcileHerdrReconnect<K extends { bridge: PlacementBridgeIdentity }>(identity: HerdrRunIdentity, candidate: K, lastEvidenceCursor: number, host: PlacementPaneHost = herdrPaneHost): PlacementReconnectCheck {
	return host.reconcile(identity, candidate, () => { const bridge = candidate.bridge; if (bridge.runId !== identity.runId || bridge.nativeSessionId !== identity.nativeSessionId || bridge.packageVersion !== packageJson.version || bridge.protocol !== HERDR_PI_PROTOCOL) return { ok: false, reason: "Bridge run, package, protocol, or native session identity changed." }; if (typeof bridge.evidenceCursor !== "number" || typeof bridge.evidenceFloor !== "number" || bridge.evidenceCursor < lastEvidenceCursor || bridge.evidenceFloor > lastEvidenceCursor + 1) return { ok: false, reason: "Bridge evidence has a gap after reconnect." }; return { ok: true, cursor: bridge.evidenceCursor }; });
}

export async function boundedHerdrReconnect<K extends { bridge: PlacementBridgeIdentity }>(identity: HerdrRunIdentity, lastEvidenceCursor: number, attempt: (number: number) => Promise<K>, options: { attempts?: number; deadlineMs?: number; disposed?: () => boolean; host?: PlacementPaneHost } = {}) {
	const deadline = Date.now() + (options.deadlineMs ?? 15_000); let last = "Reconnect did not run.";
	for (let number = 1; number <= (options.attempts ?? 3) && Date.now() < deadline; number++) {
		if (options.disposed?.()) return { ok: false as const, reason: "Reconnect was disposed." };
		try { const result = reconcileHerdrReconnect(identity, await attempt(number), lastEvidenceCursor, options.host); if (result.ok) return result; last = result.reason; } catch (error) { last = error instanceof Error ? error.message : String(error); }
		await new Promise((resolve) => setTimeout(resolve, Math.min(number * 100, Math.max(0, deadline - Date.now()))));
	}
	return { ok: false as const, reason: last };
}

function safeRunId(value: string | undefined): string { const prefix = value?.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48) ?? "run"; return validateHerdrPiRunId(`${prefix}_${randomBytes(8).toString("hex")}`); }

export function serializeHerdrPiLaunch(launch: ChildSessionLaunch): { args: string[]; resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false } } {
	if (launch.storage.kind === "file") throw new Error("Pane-native remote Pi does not support fork, resume, or revival; use fresh context.");
	if (launch.extensionPaths.length || launch.requiredExtensions?.length) throw new Error("Pane-native remote Pi cannot transfer local extension paths; install/configure pi-subagents on the remote machine.");
	if (launch.processEnv && Object.values(launch.processEnv).some((value) => value !== undefined && value !== "__none__")) throw new Error("Pane-native remote Pi cannot transfer local bindings, MCP selections, or process environment.");
	if (launch.runtime.nestedRoute || launch.runtime.fanoutChild || launch.runtime.depth > 1) throw new Error("Nested delegation from a pane-native remote Pi is not supported.");
	if (launch.excludeTools?.length || launch.runtime.permissions || launch.runtime.toolBudget || launch.runtime.requiredExtensions || launch.runtime.requiredTools?.length || launch.runtime.mcpDirectTools?.length) throw new Error("Pane-native remote Pi cannot yet represent exclusions, permission rules, tool budgets, MCP direct tools, or required-tool/extension contracts; remove machine placement.");
	const resources = launch.remoteResources;
	if (!resources || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resources.agent) || resources.skills?.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) || resources.toolCeiling?.some((name) => !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) || (resources.reads !== undefined && resources.reads !== false && resources.reads.some((read) => typeof read !== "string" || Buffer.byteLength(read) > 4096))) throw new Error("Pane-native remote resources require bounded logical agent, skill, tool, and read names.");
	const args: string[] = [];
	if (launch.noSkills) args.push("--no-skills", "--no-prompt-templates");
	if (launch.noContextFiles) args.push("--no-context-files");
	if (launch.model) args.push("--model", launch.model);
	return { args, resources: { agent: resources.agent, ...(resources.skills ? { skills: [...resources.skills] } : {}), ...(resources.toolCeiling ? { toolCeiling: [...resources.toolCeiling] } : {}), ...(resources.reads !== undefined ? { reads: resources.reads === false ? false : [...resources.reads] } : {}) } };
}

export async function discoverBridgeManifest(machine: HerdrMachineReference, runId: string, runtimeDir: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ socketPath: string; nativeSessionId: string; packageVersion: string; protocol: number }> {
	const script = `p="$1/manifest.json"; test -f "$p" && test ! -L "$p" && cat "$p"`, access = sshMachineAccess(machine, options);
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = await access.runAsync(access.shellCommand(script, [runtimeDir]), { timeout: 5_000, maxBuffer: 64 * 1024 });
		if (result.error) throw new Error(`Remote bridge manifest discovery failed: ${result.error.message}`, { cause: result.error });
		if (result.status === 0 && result.stdout.trim()) {
			let value: unknown; try { value = JSON.parse(result.stdout) as unknown; } catch { throw new Error("Remote bridge manifest is malformed."); }
			const p = value as Record<string, unknown>;
			if (p.runId !== runId || typeof p.socketPath !== "string" || path.posix.dirname(p.socketPath) !== runtimeDir || typeof p.nativeSessionId !== "string" || typeof p.packageVersion !== "string" || typeof p.protocol !== "number") throw new Error("Remote bridge manifest identity is incomplete or outside its owned runtime directory.");
			return p as unknown as { socketPath: string; nativeSessionId: string; packageVersion: string; protocol: number };
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The remote Pi did not expose the packaged pi-subagents bridge. Install/configure the same package version as an ambient Pi extension on the saved machine.");
}

export async function createRemoteRuntimeDir(machine: HerdrMachineReference, runId: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> { const access = sshMachineAccess(machine, options), result = await access.runAsync(access.shellCommand("umask 077; mktemp -d \"${TMPDIR:-/tmp}/pi-subagents-herdr-$1-XXXXXXXX\"", [runId]), { timeout: 10_000, maxBuffer: 4096 }); if (result.error) throw new Error(`Could not provision a run-private remote bridge runtime directory: ${result.error.message}`, { cause: result.error }); const value = result.stdout.trim(); if (result.status !== 0 || !path.posix.isAbsolute(value) || value.includes("\n")) throw new Error("Could not provision a run-private remote bridge runtime directory."); return value; }
export function removeRemoteRuntimeDir(machine: HerdrMachineReference, runtimeDir: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): void { const access = sshMachineAccess(machine, options), result = access.run(access.shellCommand("p=$1; case \"${p##*/}\" in pi-subagents-herdr-*) test -d \"$p\" && test ! -L \"$p\" && rm -rf -- \"$p\";; *) exit 64;; esac", [runtimeDir]), { timeout: 10_000, maxBuffer: 4096 }); if (result.status !== 0 || result.stdout) throw new Error(`Could not remove the exact owned remote runtime directory: ${String(result.stderr).slice(0, 512)}`); }

/** The single private owner for allocation shared by every pane-native backend projection. */
export class HerdrPlacedRunOwner<C extends PlacementSockets = HerdrForwardedConnection> {
	readonly machine: HerdrMachineReference; readonly runId: string; readonly runtimeDir: string; connection: C; readonly host: PlacementPaneHost; readonly access: PlacementMachineAccess;
	owned?: PlacementOwnedPane; terminalId?: string; agentName?: string; startedArgv?: string[]; identity?: HerdrRunIdentity; #unsubscribe = () => {}; #snapshot: HerdrRunSnapshot = { connection: "connected", state: "ready", revision: 0 }; #cleanupPromise?: Promise<void>; readonly #removeRuntime: () => void;
	private constructor(machine: HerdrMachineReference, runId: string, runtimeDir: string, connection: C, removeRuntime: () => void = () => removeRemoteRuntimeDir(machine, runtimeDir), host: PlacementPaneHost = herdrPaneHost) { this.machine = machine; this.runId = runId; this.runtimeDir = runtimeDir; this.connection = connection; this.#removeRuntime = removeRuntime; this.host = host; this.access = sshMachineAccess(machine); }
	static async create(machine: HerdrMachineReference, runId: string, beforePane?: (owner: HerdrPlacedRunOwner) => void | Promise<void>): Promise<HerdrPlacedRunOwner> { const runtimeDir = await createRemoteRuntimeDir(machine, runId); let connection: HerdrForwardedConnection | undefined; try { connection = await herdrPaneHost.connect(machine); const owner = new HerdrPlacedRunOwner(machine, runId, runtimeDir, connection); await beforePane?.(owner); return owner; } catch (error) { const cleanupErrors: unknown[] = []; try { await connection?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } try { removeRemoteRuntimeDir(machine, runtimeDir); } catch (cleanupError) { cleanupErrors.push(cleanupError); } if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Herdr owner creation failed and cleanup also failed.", { cause: error }); throw error; } }
	observeEvent(event: unknown): void { const data = this.host.paneEvent(event, this.#snapshot.state); if (data && (!this.terminalId || data.terminalId === this.terminalId || data.paneId === this.owned?.paneId)) this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, state: data.state }; }
	markConnectionUnknown(observed: C): boolean { if (this.connection !== observed) return false; this.#snapshot = { ...this.#snapshot, connection: "unknown", state: "unknown", revision: this.#snapshot.revision + 1 }; return true; }
	async subscribe(listener: (event: unknown) => void, disconnected: (error: Error) => void): Promise<void> { const observed = this.connection, paneId = this.owned?.paneId; let adopted = false, candidateLost: Error | undefined; if (!paneId) throw new Error("Herdr status subscription requires a provisioned pane."); const unsubscribe = await this.host.subscribe(observed, paneId, (event) => { this.observeEvent(event); listener(event); }, (error) => { if (!adopted) { candidateLost ??= error; return; } if (!this.markConnectionUnknown(observed)) return; disconnected(error); }); if (candidateLost) { unsubscribe(); throw candidateLost; } this.#unsubscribe = unsubscribe; adopted = true; }
	async provision(environment?: Record<string, string>): Promise<PlacementOwnedPane> { this.owned = await this.host.provision(this.connection, this.machine, this.runId, this.runtimeDir, environment); return this.owned; }
	async start(kind: PlacementAgentKind, name: string, args: string[], options: PlacementStartOptions = {}): Promise<{ terminalId: string; paneId: string; argv: string[] }> {
		if (!this.owned) throw new Error("Herdr placement owner has not provisioned its pane.");
		const { terminalId, paneId } = await this.host.start(this.connection, this.owned, kind, name, args, options), argv = [kind, ...args]; this.agentName = name; this.terminalId = terminalId; this.startedArgv = argv; return { terminalId, paneId, argv };
	}
	journal(identity: HerdrRunIdentity): void { this.identity = identity; this.#snapshot = { ...this.#snapshot, identity }; const journalDir = path.join(getAgentDir(), "pi-subagents", "herdr-run-journal"); fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(journalDir, `${this.runId}.json`), JSON.stringify({ version: 1, identity, state: "ready", updatedAt: Date.now() }), { mode: 0o600, flag: "wx" }); }
	get snapshot(): HerdrRunSnapshot { return this.#snapshot; }
	runRemote(command: string, options: { timeout?: number; maxBuffer?: number } = {}) { return this.access.run(command, options); }
	async replaceConnection(input: { connection: C; unsubscribe: () => void; paneId: string; state: HerdrRunSnapshot["state"] }): Promise<void> { const oldConnection = this.connection, oldUnsubscribe = this.#unsubscribe; this.connection = input.connection; this.#unsubscribe = input.unsubscribe; if (this.identity) this.identity = { ...this.identity, paneId: input.paneId }; this.#snapshot = { connection: "connected", state: input.state, identity: this.identity, revision: this.#snapshot.revision + 1 }; oldUnsubscribe(); await oldConnection.close(); }
	cleanup(closeStartedPane = true): Promise<void> { return this.#cleanupPromise ??= this.#performCleanup(closeStartedPane); }
	async #performCleanup(closeStartedPane: boolean): Promise<void> { let failure: unknown; try { if (closeStartedPane && this.owned) await this.host.closeOwnedPane(this.connection, this.owned, this.terminalId, this.agentName); } catch (error) { failure = error; } try { this.#unsubscribe(); await this.connection.close(); this.#removeRuntime(); } catch (error) { failure ??= error; } this.#snapshot = { ...this.#snapshot, connection: "closed", revision: this.#snapshot.revision + 1 }; if (failure) throw failure; }
}

export class BridgeChannel {
	readonly socket: net.Socket; readonly decoder = new HerdrPiFrameDecoder(); readonly listeners = new Set<(frame: HerdrPiFrame) => void>(); readonly waiters = new Map<string, { resolve(frame: HerdrPiFrame): void; reject(error: Error): void }>(); readonly runId: string; readonly frames: HerdrPiFrame[] = [];
	readonly failure: Promise<never>; #rejectFailure!: (error: Error) => void; #failed = false; #adopted = false;
	constructor(socketPath: string, runId: string) { this.runId = runId; this.failure = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; }); this.failure.catch(() => {}); this.socket = net.createConnection(socketPath); this.socket.on("data", (chunk: Buffer) => { try { for (const frame of this.decoder.push(chunk)) { if (frame.runId !== runId) throw new Error("Bridge run identity mismatch."); if (!this.#adopted) { this.frames.push(frame); if (this.frames.length > 1024) throw new Error("Bridge replay queue exceeded its bound."); } const key = typeof frame.requestId === "string" ? `${frame.type}:${frame.requestId}` : ""; const waiter = this.waiters.get(key); if (waiter) { this.waiters.delete(key); waiter.resolve(frame); } for (const listener of this.listeners) listener(frame); } } catch (error) { this.fail(error as Error); } }); this.socket.on("error", (error) => this.fail(error)); this.socket.on("close", () => { if (!this.#failed) this.fail(new Error("Remote Pi bridge connection was lost; task state is unknown.")); }); }
	fail(error: Error) { if (this.#failed) return; this.#failed = true; this.#rejectFailure(error); for (const waiter of this.waiters.values()) waiter.reject(error); this.waiters.clear(); }
	get failed() { return this.#failed; }
	adopt(listener: (frame: HerdrPiFrame) => void): HerdrPiFrame[] { this.#adopted = true; this.listeners.add(listener); return this.frames.splice(0); }
	wait(type: string, requestId: string): Promise<HerdrPiFrame> { return new Promise((resolve, reject) => this.waiters.set(`${type}:${requestId}`, { resolve, reject })); }
	configure(resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false }) { const requestId = `cfg_${randomBytes(6).toString("hex")}`; const waiting = this.wait("configured", requestId); this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "configure", requestId, resources })); return waiting; }
	supervisorDelivered(requestId: string) { this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "supervisor-delivered", requestId })); }
	prepare(requestId: string, operation: string, text?: string, supervisorId?: string) { const waiting = this.wait("prepared", requestId); this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "prepare", requestId, operation, ...(text !== undefined ? { text } : {}), ...(supervisorId ? { supervisorId } : {}) })); return waiting; }
	close() { this.socket.destroy(); }
}

function waitForReadyBridgeFrame(bridge: BridgeChannel, timeoutMs: number, timeoutMessage: string, configured = false): Promise<HerdrPiFrame> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
		const listener = (frame: HerdrPiFrame) => {
			if (frame.type !== "ready" || configured && frame.configured !== true) return;
			clearTimeout(timer);
			bridge.listeners.delete(listener);
			resolve(frame);
		};
		bridge.listeners.add(listener);
	});
}

export class HerdrPiSession implements ChildSession {
	readonly #listeners = new Set<(event: ChildSessionEvent) => void>(); #messages: AgentMessage[] = []; #sequence = 0; #disposed = false; #aborted = false; #initialGit?: HerdrRemoteGitStatus; #finalGit?: HerdrRemoteGitStatus;
	readonly #operations = new Map<string, { resolve(): void; reject(error: Error): void; accepted: boolean; settled: boolean }>();
	#snapshot: HerdrRunSnapshot; bridgeForward: { close(): Promise<void> }; bridge: BridgeChannel; readonly requestedTools: string[] | undefined; readonly model: string | undefined; #evidenceCursor = 0; #reconnecting?: Promise<void>; #reconnectFactory?: () => Promise<void>; #reconnectFailure?: Error;
	#replyTimer?: NodeJS.Timeout; readonly supervisorDir: string | undefined; readonly runtime: ChildRuntimeConfig; readonly owner: HerdrPlacedRunOwner<PlacementSockets>; readonly host: PlacementPaneHost;
	constructor(owner: HerdrPlacedRunOwner<PlacementSockets>, bridgeForward: { close(): Promise<void> }, bridge: BridgeChannel, requestedTools: string[] | undefined, model: string | undefined, runtime: ChildRuntimeConfig, initialGit?: HerdrRemoteGitStatus, host: PlacementPaneHost = herdrPaneHost) { this.owner = owner; this.host = host; this.bridgeForward = bridgeForward; this.bridge = bridge; this.requestedTools = requestedTools; this.model = model; this.runtime = runtime; this.supervisorDir = runtime.supervisorChannelDir; this.#snapshot = { connection: "connected", state: "ready", identity: owner.identity, revision: 0 }; this.#initialGit = initialGit; bridge.adopt((frame) => this.#frame(frame)); if (this.supervisorDir) { this.#replyTimer = setInterval(() => { const replies = path.join(this.supervisorDir!, "replies"); for (const name of fs.existsSync(replies) ? fs.readdirSync(replies) : []) { const file = path.join(replies, name); try { const value = JSON.parse(fs.readFileSync(file, "utf8")) as { message?: unknown; requestId?: unknown }; if (typeof value.message === "string" && typeof value.requestId === "string") void this.#operation("supervisor-reply", value.message, value.requestId).then(() => fs.rmSync(file, { force: true })); } catch {} } }, 50); this.#replyTimer.unref?.(); } }
	get identity(): HerdrRunIdentity { return this.owner.identity!; } set identity(value: HerdrRunIdentity) { this.owner.identity = value; }
	get connection(): PlacementSockets { return this.owner.connection; } set connection(value: PlacementSockets) { this.owner.connection = value; }
	armReconnect(factory: () => Promise<void>) { this.#reconnectFactory = factory; const observed = this.bridge; observed.failure.catch(() => { if (this.bridge === observed) void this.reconnect(); }); }
	get evidenceCursor() { return this.#evidenceCursor; }
	async reconnect() { if (this.#disposed || !this.#reconnectFactory || this.#reconnectFailure) return; this.#snapshot = { ...this.#snapshot, connection: "unknown", state: "unknown", revision: this.#snapshot.revision + 1 }; this.#reconnecting ??= this.#reconnectFactory().catch((error) => { const unknown = this.#reconnectFailure = new Error(`Remote Pi reconciliation failed; task state is unknown: ${error instanceof Error ? error.message : String(error)}`); for (const operation of this.#operations.values()) if (!operation.settled) { operation.settled = true; operation.reject(unknown); } }).finally(() => { this.#reconnecting = undefined; }); await this.#reconnecting; }
	async replaceTransport(input: { connection: PlacementSockets; bridgeForward: { close(): Promise<void> }; bridge: BridgeChannel; unsubscribe: () => void; paneId: string; cursor: number; state: HerdrRunSnapshot["state"] }) { if (this.#disposed) { input.unsubscribe(); input.bridge.close(); await input.bridgeForward.close(); await input.connection.close(); return; } const old = { bridgeForward: this.bridgeForward, bridge: this.bridge }; this.bridgeForward = input.bridgeForward; this.bridge = input.bridge; this.identity = { ...this.identity, paneId: input.paneId }; this.#reconnectFailure = undefined; for (const frame of input.bridge.adopt((frame) => this.#frame(frame))) if (typeof frame.cursor === "number" && frame.cursor > this.#evidenceCursor) this.#frame(frame); for (const operation of this.#operations.values()) if (!operation.accepted && !operation.settled) { operation.settled = true; operation.reject(new Error("Remote operation was not accepted before transport loss; task state is unknown.")); } this.#evidenceCursor = Math.max(this.#evidenceCursor, input.cursor); this.#snapshot = { connection: "connected", state: input.state, identity: this.identity, revision: this.#snapshot.revision + 1 }; const ownerReplacement = this.owner.replaceConnection({ connection: input.connection, unsubscribe: input.unsubscribe, paneId: input.paneId, state: input.state }); old.bridge.close(); await old.bridgeForward.close(); await ownerReplacement; if (this.#disposed) { await this.owner.cleanup(this.#aborted); return; } this.armReconnect(this.#reconnectFactory!); }
	observeHerdr(value: unknown) { const data = this.host.paneEvent(value, this.#snapshot.state); if (!data || (data.terminalId !== this.identity.terminalId && data.paneId !== this.identity.paneId)) return; this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, state: data.state }; }
	#frame(frame: HerdrPiFrame) { if (typeof frame.cursor === "number") { if (frame.cursor <= this.#evidenceCursor) return; this.#evidenceCursor = frame.cursor; } if (frame.nativeSessionId !== this.identity.nativeSessionId) { this.bridge.fail(new Error("Remote Pi native session identity changed.")); void this.connection.close(); return; } if (frame.type === "accepted" && typeof frame.requestId === "string") { const operation = this.#operations.get(frame.requestId); if (operation) operation.accepted = true; } if (frame.type === "supervisor-request" && this.supervisorDir && typeof frame.requestId === "string") this.#relaySupervisor(frame); if (frame.type === "event" && frame.event && typeof frame.event === "object") { const event = frame.event as ChildSessionEvent; const message = event.message as AgentMessage | undefined; if (event.type === "message_end" && message) this.#messages.push(message); for (const listener of this.#listeners) listener(event); } if (frame.type === "settled" && typeof frame.requestId === "string") { if (frame.finalAssistant && typeof frame.finalAssistant === "object") { const message = frame.finalAssistant as AgentMessage; if (!this.#messages.includes(message)) this.#messages.push(message); } if (frame.finalGit && typeof frame.finalGit === "object") this.#finalGit = frame.finalGit as HerdrRemoteGitStatus; const operation = this.#operations.get(frame.requestId); if (operation && !operation.settled) { operation.accepted = true; operation.settled = true; frame.idle === true && frame.pending === false ? operation.resolve() : operation.reject(new Error("Remote Pi did not settle with an empty native queue.")); } for (const listener of this.#listeners) listener({ type: "agent_settled" }); } }
	#relaySupervisor(frame: HerdrPiFrame) { if (!this.supervisorDir || typeof frame.requestId !== "string") return; const reason = frame.reason; if (reason !== "need_decision" && reason !== "interview_request" && reason !== "progress_update") return; const createdAt = Date.now(); const file = path.join(this.supervisorDir, "requests", `${path.basename(frame.requestId)}.json`); const request = { type: "subagent.supervisor.request", id: frame.requestId, createdAt, ...(reason !== "progress_update" ? { expiresAt: createdAt + 10 * 60_000 } : {}), reason, message: typeof frame.message === "string" ? frame.message : "", ...(frame.interview && typeof frame.interview === "object" ? { interview: frame.interview } : {}), expectsReply: reason !== "progress_update", runId: this.runtime.runId ?? this.identity.runId, agent: this.runtime.agent ?? "remote", childIndex: this.runtime.childIndex ?? 0, orchestratorSessionId: this.runtime.orchestratorSessionId }; try { fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600, flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown; reason?: unknown }; if (existing.id !== frame.requestId || existing.reason !== reason) throw new Error("Supervisor relay identity changed during replay."); } if (reason === "progress_update") this.bridge.supervisorDelivered(frame.requestId); }
	async #operation(operation: string, text?: string, supervisorId?: string): Promise<void> { const requestId = `${++this.#sequence}_${randomBytes(5).toString("hex")}`; let completion: Promise<void> = Promise.resolve(); if (operation === "prompt") completion = new Promise<void>((resolve, reject) => this.#operations.set(requestId, { resolve, reject, accepted: false, settled: false })); try { await Promise.race([this.bridge.prepare(requestId, operation, text, supervisorId), this.bridge.failure]); await this.host.prompt(this.connection, this.identity.agentName, `/pi-subagents-bridge ${requestId}`); await completion; } catch (error) { if (operation === "prompt" && this.bridge.failed) { await this.reconnect(); await completion; return; } const pending = this.#operations.get(requestId); if (pending) pending.settled = true; throw error; } finally { if (operation === "prompt") this.#operations.delete(requestId); } }
	subscribe(listener: (event: ChildSessionEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	prompt(text: string) { return this.#operation("prompt", text); } steer(text: string) { return this.#operation("steer", text); } followUp(text: string) { return this.#operation("follow-up", text); } async abort() { this.#aborted = true; await this.#operation("abort"); }
	async dispose() { if (this.#disposed) return; this.#disposed = true; if (this.#replyTimer) clearInterval(this.#replyTimer); this.bridge.close(); await this.bridgeForward.close(); await this.owner.cleanup(this.#aborted); this.#snapshot = { ...this.#snapshot, connection: "closed" }; }
	get messages() { return this.#messages; } get sessionFile() { return undefined; } get sessionId() { return this.identity.nativeSessionId; } get modelId() { return this.model; }
	get machineEvidence() { return { machineId: this.identity.machineId, ...(this.#initialGit ? { initial: this.#initialGit } : {}), ...(this.#finalGit ? { final: this.#finalGit } : {}) }; }
	get placementSnapshot() { return this.owner.snapshot; }
}

export async function reconnectHerdrPiSession(session: HerdrPiSession, launch: ChildSessionLaunch, dependencies: { host?: PlacementPaneHost; connect?: PlacementPaneHost["connect"]; discoverManifest?: typeof discoverBridgeManifest; createBridge?: (socketPath: string, runId: string) => BridgeChannel } = {}): Promise<void> {
	const host = dependencies.host ?? herdrPaneHost, connect = dependencies.connect ?? ((machine: HerdrMachineReference) => host.connect(machine)), discoverManifest = dependencies.discoverManifest ?? discoverBridgeManifest, createBridge = dependencies.createBridge ?? ((socketPath: string, runId: string) => new BridgeChannel(socketPath, runId));
	let validated: { connection: PlacementSockets; unsubscribe: () => void; bridgeForward: { socketPath: string; close(): Promise<void> }; bridge: BridgeChannel; candidate: { adopted: boolean; lost?: Error } } | undefined;
	const result = await boundedHerdrReconnect(session.identity, session.evidenceCursor, async () => {
		const connection = await connect(launch.machine!); let unsubscribe = () => {}; let bridgeForward: { socketPath: string; close(): Promise<void> } | undefined; let bridge: BridgeChannel | undefined; const generation: { adopted: boolean; lost?: Error } = { adopted: false };
		try {
			const panes = await host.panes(connection);
			const manifest = await discoverManifest(launch.machine!, session.identity.runId, session.identity.runtimeDir); bridgeForward = await connection.forwardRemoteSocket(manifest.socketPath, "bridge-reconnect"); bridge = createBridge(bridgeForward.socketPath, session.identity.runId);
			const ready = await waitForReadyBridgeFrame(bridge, 8_000, "Reconnected bridge handshake timed out.", true);
			const candidate = { ...panes, bridge: { runId: ready.runId, nativeSessionId: ready.nativeSessionId as string | undefined, packageVersion: ready.packageVersion as string | undefined, protocol: ready.protocol, evidenceCursor: ready.evidenceCursor as number | undefined, evidenceFloor: ready.evidenceFloor as number | undefined } };
			const check = reconcileHerdrReconnect(session.identity, candidate, session.evidenceCursor, host); if (!check.ok) throw new Error(check.reason);
			unsubscribe = await host.subscribe(connection, check.paneId, (event) => { session.owner.observeEvent(event); session.observeHerdr(event); }, (error) => { if (!generation.adopted) { generation.lost ??= error; return; } session.owner.markConnectionUnknown(connection); void session.reconnect(); });
			if (generation.lost) throw generation.lost; validated = { connection, unsubscribe, bridgeForward, bridge, candidate: generation }; return candidate;
		} catch (error) { unsubscribe(); bridge?.close(); await bridgeForward?.close(); await connection.close(); throw error; }
	}, { attempts: 3, deadlineMs: 15_000, disposed: () => (session.placementSnapshot as HerdrRunSnapshot).connection === "closed", host });
	if (!result.ok) throw new Error(`Pane-native reconnect remains unknown: ${result.reason}`);
	if (!validated) throw new Error("Pane-native reconnect produced no validated transport.");
	if (validated.candidate.lost) { validated.unsubscribe(); validated.bridge.close(); await validated.bridgeForward.close(); await validated.connection.close(); throw validated.candidate.lost; }
	validated.candidate.adopted = true;
	await session.replaceTransport({ ...validated, paneId: result.paneId, cursor: result.cursor, state: result.state });
}

export async function createHerdrPiSession(launch: ChildSessionLaunch): Promise<ChildSession> {
	if (!launch.machine) throw new Error("Pane-native Pi launch requires a saved machine.");
	const policy = serializeHerdrPiLaunch(launch); const runId = safeRunId(launch.runtime.runId); const owner = await HerdrPlacedRunOwner.create(launch.machine, runId); const runtimeDir = owner.runtimeDir, connection = owner.connection; let owned: { workspaceId: string; tabId: string; paneId: string } | undefined; let agentName: string | undefined; let observeHerdr: ((event: unknown) => void) | undefined;
	try {
		let reconnectSession: HerdrPiSession | undefined; owned = await owner.provision(); await owner.subscribe((event) => observeHerdr?.(event), () => void reconnectSession?.reconnect());
		agentName = `pi-${runId.slice(-20)}`; const { terminalId } = await owner.start("pi", agentName, policy.args);
		const manifest = await discoverBridgeManifest(launch.machine, runId, runtimeDir); if (manifest.protocol !== HERDR_PI_PROTOCOL || manifest.packageVersion !== packageJson.version) throw new Error(`Remote pi-subagents bridge version mismatch (remote ${manifest.packageVersion}, local ${packageJson.version}).`);
		const bridgeForward = await connection.forwardRemoteSocket(manifest.socketPath, "bridge"); const bridge = new BridgeChannel(bridgeForward.socketPath, runId);
		const ready = await waitForReadyBridgeFrame(bridge, 15_000, "Remote Pi bridge handshake timed out.");
		if (ready.packageVersion !== packageJson.version || ready.nativeSessionId !== manifest.nativeSessionId || ready.cwd !== launch.machine.cwd) throw new Error("Remote Pi bridge handshake identity mismatch.");
		const configured = await Promise.race([bridge.configure(policy.resources), bridge.failure]);
		if (configured.nativeSessionId !== manifest.nativeSessionId || configured.agent !== policy.resources.agent) throw new Error("Remote Pi resource resolution identity mismatch.");
		if (!Array.isArray(configured.tools) || (policy.resources.toolCeiling && (configured.tools as unknown[]).some((tool) => !policy.resources.toolCeiling!.includes(String(tool))))) throw new Error("Remote Pi active-tool ceiling acknowledgement mismatch.");
		if (launch.model && configured.model !== launch.model.split(":")[0]) throw new Error(`Remote Pi model '${launch.model}' did not resolve to the requested provider/model.`);
		const identity: HerdrRunIdentity = { runId, machineId: launch.machine.id, target: launch.machine.target, session: owner.host.sessionOf(connection), workspaceId: owned.workspaceId, tabId: owned.tabId, paneId: owned.paneId, terminalId, agentName, nativeSessionId: manifest.nativeSessionId, cwd: launch.machine.cwd, runtimeDir };
		owner.journal(identity);
		const session = new HerdrPiSession(owner, bridgeForward, bridge, (configured.tools as string[] | undefined), typeof ready.model === "string" ? ready.model : undefined, launch.runtime, ready.initialGit as HerdrRemoteGitStatus | undefined, owner.host); reconnectSession = session; observeHerdr = (event) => session.observeHerdr(event); session.armReconnect(() => reconnectHerdrPiSession(session, launch, { host: owner.host })); return session;
	} catch (error) { await owner.cleanup(); throw error; }
}

export function createPlacementAwareChildSessionFactory(local: ChildSessionFactory, createRemote: (launch: ChildSessionLaunch) => Promise<ChildSession> = createHerdrPiSession): ChildSessionFactory {
	const remote = new Set<ChildSession>(); return { async create(launch) { if (!launch.machine) return local.create(launch); serializeHerdrPiLaunch(launch); const child = await createRemote(launch); remote.add(child); return child; }, async dispose() { await Promise.allSettled([...remote].map((child) => child.dispose())); remote.clear(); await local.dispose(); } };
}
