import * as fs from "node:fs";
import * as path from "node:path";
import type { ForegroundResumeChild, ForegroundResumeRun, SubagentState } from "../../shared/types.ts";
import { DIRS } from "../../shared/types.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { utf8Tail } from "../../shared/utf8.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { validateModelResponseAliases } from "../../shared/model-response-aliases.ts";
import { checkRecordedPidLiveness, type PidLiveness, type RecordedPid } from "../background/stale-run-reconciler.ts";
import { currentPidNamespaceScope } from "../background/pid-namespace.ts";
import { currentBootId } from "../background/boot-id.ts";

export const MAX_REMEMBERED_FOREGROUND_RUNS = 50;
export const FOREGROUND_OWNER_EXITED_STOP_ERROR = "Subagent stopped because the Pi process that ran it exited before the run finished.";
const HISTORY_VERSION = 1;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const MAX_RESUME_CONTRACT_BYTES = 64 * 1024;

interface ForegroundHistoryIndex {
	version: 1;
	runs: ForegroundResumeRun[];
}

function historyPath(resultsDir: string): string {
	return path.join(resultsDir, "foreground-history.json");
}

function boundedTail(value: string): string {
	return utf8Tail(value, MAX_INLINE_OUTPUT_BYTES).text;
}

function compactChild(child: ForegroundResumeChild): ForegroundResumeChild {
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	return {
		agent: child.agent,
		index: child.index,
		...(child.sessionName ? { sessionName: child.sessionName } : {}),
		...(child.context ? { context: child.context } : {}),
		...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
		...(child.model ? { model: child.model } : {}),
		...(child.thinking ? { thinking: child.thinking } : {}),
		status: child.status,
		...(child.activityState ? { activityState: child.activityState } : {}),
		...(child.lastActivityAt !== undefined ? { lastActivityAt: child.lastActivityAt } : {}),
		...(child.currentTool ? { currentTool: child.currentTool } : {}),
		...(child.currentToolStartedAt !== undefined ? { currentToolStartedAt: child.currentToolStartedAt } : {}),
		...(child.currentPath ? { currentPath: child.currentPath } : {}),
		...(child.turnCount !== undefined ? { turnCount: child.turnCount } : {}),
		...(child.tokens !== undefined ? { tokens: child.tokens } : {}),
		...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
		...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
		...(child.error ? { error: child.error } : {}),
		...(!outputPath && child.finalOutput ? { finalOutput: boundedTail(child.finalOutput) } : {}),
		...(child.outputState ? { outputState: child.outputState } : {}),
		...(child.outputPartial ? { outputPartial: true } : {}),
		...(child.outputMode ? { outputMode: child.outputMode } : {}),
		...(child.savedOutputPath ? { savedOutputPath: child.savedOutputPath } : {}),
		...(child.outputSaveError ? { outputSaveError: child.outputSaveError } : {}),
		...(child.artifactPaths ? { artifactPaths: child.artifactPaths } : {}),
		...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
		...(child.transcriptError ? { transcriptError: child.transcriptError } : {}),
		...(child.acceptance ? { acceptance: child.acceptance } : {}),
		...(child.resumeContract ? { resumeContract: child.resumeContract } : {}),
		...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
		...(child.extensionBindings ? { extensionBindings: child.extensionBindings } : {}),
		...(child.requiredExtensions ? { requiredExtensions: child.requiredExtensions } : {}),
		...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
		...(child.updatedAt !== undefined ? { updatedAt: child.updatedAt } : {}),
	};
}

function isRestorableForegroundStatus(status: unknown): status is ForegroundResumeChild["status"] {
	return status === "completed" || status === "failed" || status === "paused" || status === "stopped";
}

function hasRunningChild(run: Pick<ForegroundResumeRun, "children">): boolean {
	return run.children.some((child) => child.status === "running");
}

function isOwnerPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A `running` record is kept only for a single run whose owning Pi process can be probed later. */
function isAdmittedChildStatus(run: Partial<ForegroundResumeRun>, status: unknown): boolean {
	return isRestorableForegroundStatus(status) || (status === "running" && run.mode === "single" && isOwnerPid(run.ownerPid));
}

function isRestorableResumeContract(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESUME_CONTRACT_BYTES) return false;
		validateModelResponseAliases((value as ForegroundResumeChild["resumeContract"])?.modelResponseAliases);
	} catch {
		return false;
	}
	const contract = value as NonNullable<ForegroundResumeChild["resumeContract"]>;
	if (Object.keys(contract).some((key) => !["modelResponseAliases", "outputSchema", "agentContract", "acceptance", "output", "outputMode"].includes(key))) return false;
	if (contract.outputSchema !== undefined && contract.outputSchema !== false && (!contract.outputSchema || typeof contract.outputSchema !== "object" || Array.isArray(contract.outputSchema))) return false;
	if (contract.agentContract !== undefined && (!contract.agentContract || typeof contract.agentContract !== "object" || Array.isArray(contract.agentContract) || contract.agentContract.version !== 1)) return false;
	if (validateAcceptanceInput(contract.acceptance).length > 0) return false;
	if (contract.output !== undefined && typeof contract.output !== "string" && typeof contract.output !== "boolean") return false;
	return contract.outputMode === undefined || contract.outputMode === "inline" || contract.outputMode === "file-only";
}

function compactRun(run: ForegroundResumeRun): ForegroundResumeRun | undefined {
	if (!run.sessionId) return undefined;
	if (run.children.length === 0 || !run.children.every((child) => isAdmittedChildStatus(run, child.status) && isRestorableResumeContract(child.resumeContract))) return undefined;
	const running = hasRunningChild(run);
	return {
		runId: run.runId,
		mode: run.mode,
		cwd: run.cwd,
		sessionId: run.sessionId,
		updatedAt: run.updatedAt,
		children: run.children.map(compactChild),
		...(running ? { ownerPid: run.ownerPid } : {}),
		...(running && run.ownerPidNamespaceScope ? { ownerPidNamespaceScope: run.ownerPidNamespaceScope } : {}),
		...(running && run.ownerBootId ? { ownerBootId: run.ownerBootId } : {}),
		...(run.parentWorkflowRunId ? { parentWorkflowRunId: run.parentWorkflowRunId } : {}),
	};
}

function readIndex(resultsDir: string): ForegroundHistoryIndex {
	const filePath = historyPath(resultsDir);
	if (!fs.existsSync(filePath)) return { version: HISTORY_VERSION, runs: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: HISTORY_VERSION, runs: [] };
		const record = parsed as Partial<ForegroundHistoryIndex>;
		if (record.version !== HISTORY_VERSION || !Array.isArray(record.runs)) return { version: HISTORY_VERSION, runs: [] };
		return { version: HISTORY_VERSION, runs: record.runs.filter(isRestorableRun) };
	} catch {
		return { version: HISTORY_VERSION, runs: [] };
	}
}

function isRestorableRun(value: unknown): value is ForegroundResumeRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const run = value as Partial<ForegroundResumeRun>;
	return typeof run.runId === "string" && Boolean(run.runId)
		&& (run.mode === "single" || run.mode === "parallel" || run.mode === "chain")
		&& typeof run.cwd === "string" && Boolean(run.cwd)
		&& typeof run.sessionId === "string" && Boolean(run.sessionId)
		&& typeof run.updatedAt === "number" && Number.isFinite(run.updatedAt)
		&& Array.isArray(run.children)
		&& run.children.length > 0
		&& (run.ownerPidNamespaceScope === undefined || typeof run.ownerPidNamespaceScope === "string")
		&& (run.ownerBootId === undefined || typeof run.ownerBootId === "string")
		&& (run.parentWorkflowRunId === undefined || typeof run.parentWorkflowRunId === "string")
		&& run.children.every((child) => Boolean(child && typeof child === "object" && !Array.isArray(child)
			&& typeof (child as Partial<ForegroundResumeChild>).agent === "string"
			&& typeof (child as Partial<ForegroundResumeChild>).index === "number"
			&& isRestorableResumeContract((child as Partial<ForegroundResumeChild>).resumeContract)
			&& isAdmittedChildStatus(run, (child as Partial<ForegroundResumeChild>).status)));
}

function sortAndBound(runs: ForegroundResumeRun[], limit: number): ForegroundResumeRun[] {
	return [...runs].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

export function persistForegroundRunHistory(state: SubagentState, options: { resultsDir?: string; limit?: number } = {}): void {
	const resultsDir = options.resultsDir ?? DIRS.results;
	const limit = options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS;
	const existing = readIndex(resultsDir);
	const merged = new Map(existing.runs.map((run) => [run.runId, run]));
	for (const run of state.foregroundRuns?.values() ?? []) {
		const compact = compactRun(run);
		if (compact) merged.set(compact.runId, compact);
	}
	const runs = sortAndBound([...merged.values()], limit);
	writePrivateAtomicJson(historyPath(resultsDir), { version: HISTORY_VERSION, runs });
}

/**
 * Saves a foreground run that is starting, so it can be resumed if this Pi process dies before
 * the run ends. The record goes to the history file only; the final save replaces it by run id.
 */
export function persistRunningForegroundRun(run: ForegroundResumeRun, options: { resultsDir?: string; limit?: number } = {}): void {
	const compact = compactRun(run);
	if (!compact || !hasRunningChild(compact)) return;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const merged = new Map(readIndex(resultsDir).runs.map((existing) => [existing.runId, existing]));
	merged.set(compact.runId, compact);
	writePrivateAtomicJson(historyPath(resultsDir), { version: HISTORY_VERSION, runs: sortAndBound([...merged.values()], options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS) });
}

/** Drops this process's `running` record for a launch that threw, so it never loads as interrupted. */
export function discardRunningForegroundRun(runId: string, options: { resultsDir?: string } = {}): void {
	const resultsDir = options.resultsDir ?? DIRS.results;
	const index = readIndex(resultsDir);
	const runs = index.runs.filter((run) => !(run.runId === runId && hasRunningChild(run) && run.ownerPid === process.pid));
	if (runs.length === index.runs.length) return;
	writePrivateAtomicJson(historyPath(resultsDir), { version: HISTORY_VERSION, runs });
}

function currentOwnerLiveness(owner: RecordedPid): PidLiveness {
	return checkRecordedPidLiveness(owner, { observedScope: currentPidNamespaceScope(), observedBootId: currentBootId() });
}

/** A run whose owning Pi process is gone loads as stopped and resumable; one whose owner may be alive is not loaded. */
function restoreInterruptedRun(run: ForegroundResumeRun, liveness: (owner: RecordedPid) => PidLiveness): ForegroundResumeRun | undefined {
	if (!isOwnerPid(run.ownerPid) || liveness({ pid: run.ownerPid, pidNamespaceScope: run.ownerPidNamespaceScope, bootId: run.ownerBootId }) !== "dead") return undefined;
	const { ownerPid: _ownerPid, ownerPidNamespaceScope: _ownerPidNamespaceScope, ownerBootId: _ownerBootId, ...rest } = run;
	return {
		...rest,
		children: run.children.map((child) => {
			if (child.status !== "running") return child;
			const { activityState: _activityState, currentTool: _currentTool, currentToolStartedAt: _currentToolStartedAt, currentPath: _currentPath, sessionFile, ...stopped } = child;
			return {
				...stopped,
				status: "stopped" as const,
				exitCode: 1,
				error: FOREGROUND_OWNER_EXITED_STOP_ERROR,
				finalOutput: FOREGROUND_OWNER_EXITED_STOP_ERROR,
				...(sessionFile && fs.existsSync(sessionFile) ? { sessionFile } : {}),
			};
		}),
	};
}

/** State text for a remembered child; a child cut off by a Pi exit names the resume target. */
export function foregroundChildStateLabel(run: Pick<ForegroundResumeRun, "runId">, child: Pick<ForegroundResumeChild, "status" | "error" | "sessionFile">): string {
	if (child.status !== "stopped" || child.error !== FOREGROUND_OWNER_EXITED_STOP_ERROR) return child.status;
	// Without a transcript there is nothing to resume from.
	return child.sessionFile ? `interrupted when Pi exited · resume ${run.runId}` : "interrupted when Pi exited";
}

export function restoreForegroundRunHistory(state: SubagentState, options: { resultsDir?: string; sessionId?: string | null; limit?: number; ownerLiveness?: (owner: RecordedPid) => PidLiveness } = {}): number {
	const sessionId = options.sessionId ?? state.currentSessionId;
	if (!sessionId) return 0;
	const index = readIndex(options.resultsDir ?? DIRS.results);
	const runs = sortAndBound(index.runs.filter((run) => run.sessionId === sessionId), options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS);
	state.foregroundRuns ??= new Map();
	let restored = 0;
	for (const run of runs) {
		if (state.foregroundRuns.has(run.runId)) continue;
		const loaded = hasRunningChild(run) ? restoreInterruptedRun(run, options.ownerLiveness ?? currentOwnerLiveness) : run;
		if (!loaded) continue;
		state.foregroundRuns.set(run.runId, loaded);
		restored += 1;
	}
	return restored;
}
