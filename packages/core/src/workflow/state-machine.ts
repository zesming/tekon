import { z } from 'zod';

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
