import type { WorkflowStatus } from '../types/domain.js';

/**
 * Thrown when an operation targets a workflow run that is already in a
 * terminal status (passed/failed/cancelled). Carries a stable `code` so
 * CLI/web callers can map it to clean user-facing errors.
 */
export class WorkflowTerminalError extends Error {
  readonly code = 'WORKFLOW_TERMINAL' as const;

  constructor(
    readonly runId: string,
    readonly status: WorkflowStatus,
  ) {
    super(`cannot operate on run in terminal status: ${status}`);
    this.name = 'WorkflowTerminalError';
  }
}

export function isWorkflowTerminalError(
  error: unknown,
): error is WorkflowTerminalError {
  return error instanceof WorkflowTerminalError;
}
