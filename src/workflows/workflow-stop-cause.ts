// Leaf module with no imports: the stale-run reconciler and workflow reuse both use it, so neither imports the other for it.

/** The extension runtime that owned the workflow was replaced (/reload, resume, project switch). */
export const WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED = "runtime-replaced";
/** Stale-run reconciliation found the Pi process that ran the workflow dead (crash, kill, reboot). */
export const WORKFLOW_STOP_CAUSE_OWNER_EXITED = "owner-exited";
export type WorkflowStopCause = typeof WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED | typeof WORKFLOW_STOP_CAUSE_OWNER_EXITED;

export function isReusableWorkflowStopCause(cause: unknown): cause is WorkflowStopCause {
	return cause === WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED || cause === WORKFLOW_STOP_CAUSE_OWNER_EXITED;
}

export function workflowRelaunchReuseHint(runId: string): string {
	return `Relaunching the same workflow script with the same args from this session reuses finished children and re-attaches to running ones; from another session, add options: { reuseFrom: "${runId}" }.`;
}
