import { z } from 'zod';

import type { TekonRepositories } from '../db/repositories.js';
import type { WorkflowInstance, WorkflowStatus } from '../types/domain.js';
import { WorkflowTerminalError } from './errors.js';

export const WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'awaiting-gate',
  'passed',
  'needs-revision',
  'blocked',
  'paused',
  'interrupted',
  'skipped',
  'failed',
] as const;

export const workflowNodeStatusSchema = z.enum(WORKFLOW_NODE_STATUSES);
export type WorkflowNodeStatus = z.infer<typeof workflowNodeStatusSchema>;

export const LEGAL_WORKFLOW_NODE_TRANSITIONS: Record<
  WorkflowNodeStatus,
  readonly WorkflowNodeStatus[]
> = {
  pending: ['running', 'skipped', 'blocked', 'failed'],
  running: [
    'awaiting-gate',
    'passed',
    'needs-revision',
    'blocked',
    'paused',
    'interrupted',
    'failed',
  ],
  'awaiting-gate': [
    'passed',
    'needs-revision',
    'blocked',
    'paused',
    'interrupted',
    'failed',
  ],
  'needs-revision': ['running', 'blocked', 'paused', 'interrupted', 'failed'],
  blocked: ['running', 'failed'],
  paused: ['running', 'interrupted', 'failed'],
  interrupted: ['running', 'failed'],
  passed: ['needs-revision'],
  skipped: [],
  failed: [],
};

export interface WorkflowNodeTransitionEntry {
  from: WorkflowNodeStatus;
  to: WorkflowNodeStatus;
  at: string;
  reason?: string;
}

export interface WorkflowNodeSnapshot {
  status: WorkflowNodeStatus;
  revision?: number;
  updatedAt?: string;
  history?: readonly WorkflowNodeTransitionEntry[];
}

export interface WorkflowNodeTransitionOptions {
  at?: string;
  reason?: string;
}

export function canTransitionWorkflowNode(
  from: WorkflowNodeStatus,
  to: WorkflowNodeStatus,
): boolean {
  workflowNodeStatusSchema.parse(from);
  workflowNodeStatusSchema.parse(to);

  return LEGAL_WORKFLOW_NODE_TRANSITIONS[from].includes(to);
}

export const canWorkflowTransition = canTransitionWorkflowNode;

export function assertWorkflowNodeTransition(
  from: WorkflowNodeStatus,
  to: WorkflowNodeStatus,
): void {
  if (!canTransitionWorkflowNode(from, to)) {
    throw new Error(`illegal workflow transition: ${from} -> ${to}`);
  }
}

export const assertWorkflowTransition = assertWorkflowNodeTransition;

export function transitionWorkflowNode<T extends WorkflowNodeSnapshot>(
  current: T,
  to: WorkflowNodeStatus,
  options: WorkflowNodeTransitionOptions = {},
): T & {
  status: WorkflowNodeStatus;
  revision: number;
  updatedAt: string;
  history: WorkflowNodeTransitionEntry[];
} {
  assertWorkflowNodeTransition(current.status, to);

  const at = options.at ?? new Date().toISOString();
  const revision =
    to === 'needs-revision'
      ? (current.revision ?? 0) + 1
      : (current.revision ?? 0);
  const entry: WorkflowNodeTransitionEntry = {
    from: current.status,
    to,
    at,
    ...(options.reason ? { reason: options.reason } : {}),
  };

  return {
    ...current,
    status: to,
    revision,
    updatedAt: at,
    history: [...(current.history ?? []), entry],
  };
}

// ---------------------------------------------------------------------------
// Workflow instance (run-level) state machine
// ---------------------------------------------------------------------------

export const LEGAL_WORKFLOW_TRANSITIONS: Record<
  WorkflowStatus,
  readonly WorkflowStatus[]
> = {
  pending: ['running', 'cancelled'],
  running: [
    'paused',
    'blocked',
    'passed',
    'failed',
    'interrupted',
    'cancelled',
  ],
  paused: ['running', 'blocked', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  interrupted: ['running', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'passed',
  'failed',
  'cancelled',
]);

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function canTransitionWorkflowInstance(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return LEGAL_WORKFLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertWorkflowInstanceTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): void {
  if (!canTransitionWorkflowInstance(from, to)) {
    throw new Error(
      `illegal workflow instance transition: ${from} -> ${to}`,
    );
  }
}

/**
 * M2: idempotent terminal writer — the single entry point for writing a
 * workflow run to a terminal status (passed/failed/cancelled).
 *
 * Behavior:
 * 1. Re-read the instance; not found → throw.
 * 2. Already in the target status → `{written: false}` (no db write, no
 *    audit, no validator).
 * 3. Already in a *different* terminal status → WorkflowTerminalError
 *    (never a generic assert error, so callers can converge cancel-vs-
 *    complete races cleanly).
 * 4. MUST-FIX1: `paused -> passed` returns `{written: false}` — a
 *    concurrent pause won the race; the run stays paused for resume.
 * 5. Otherwise assert the transition, then CAS-write with the re-read
 *    `from` status (Gap A). `changes=0` means another writer won the
 *    race: re-read and re-judge from step 1, up to 3 attempts.
 */
export async function writeWorkflowTerminal(
  repositories: TekonRepositories,
  runId: string,
  to: 'passed' | 'failed' | 'cancelled',
  currentNodeId?: string | null,
): Promise<{ written: boolean; workflow: WorkflowInstance }> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await repositories.getWorkflowInstance(runId);
    if (!current) {
      throw new Error(`workflow instance not found: ${runId}`);
    }
    const from = current.status;

    if (from === to) {
      return { written: false, workflow: current };
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(from)) {
      throw new WorkflowTerminalError(runId, from);
    }
    // MUST-FIX1: concurrent pause won; leave the run paused for resume.
    if (from === 'paused' && to === 'passed') {
      return { written: false, workflow: current };
    }

    assertWorkflowInstanceTransition(from, to);

    const result = await repositories.casWorkflowInstanceStatus(
      runId,
      from,
      to,
      currentNodeId ?? null,
    );
    if (result.changed && result.workflow) {
      return { written: true, workflow: result.workflow };
    }
    // CAS lost the race (changes=0): re-read and re-judge.
  }

  // All attempts conflicted: another writer terminated (or paused) the run.
  const latest = await repositories.getWorkflowInstance(runId);
  if (latest) {
    if (latest.status === to) {
      return { written: false, workflow: latest };
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(latest.status)) {
      throw new WorkflowTerminalError(runId, latest.status);
    }
    if (latest.status === 'paused' && to === 'passed') {
      return { written: false, workflow: latest };
    }
    throw new WorkflowTerminalError(runId, latest.status);
  }
  throw new Error(`workflow instance not found: ${runId}`);
}
