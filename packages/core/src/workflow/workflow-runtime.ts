import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ArtifactType, GateConfig, Node, Role } from '../types/domain.js';
import type { CommandPolicy, WorktreeLease } from '../types/config.js';
import type {
  WorkflowArtifactInputRef,
  WorkflowArtifactOutputRef,
  WorkflowGateConfig,
} from './template.js';

/**
 * An executable node is the runtime representation of a workflow template node,
 * with all IDs scoped to a specific run and all gate keys resolved.
 */
export interface ExecutableNode {
  id: string;
  role: Role;
  phaseId?: string;
  inputs: WorkflowArtifactInputRef[];
  outputs: WorkflowArtifactOutputRef[];
  gates: WorkflowGateConfig[];
  dependsOn: string[];
}

/**
 * An execution plan organizes executable nodes into ordered phases.
 */
export interface ExecutionPlan {
  phases: Array<{
    id: string;
    name: string;
    nodes: ExecutableNode[];
  }>;
}

/**
 * Signature for the checked-transition helper kept in engine.ts.
 * Sub-modules receive this as a dependency to avoid circular imports.
 */
export type CheckedTransitionFn = (
  runId: string,
  nodeId: string,
  to:
    | 'running'
    | 'awaiting-gate'
    | 'passed'
    | 'needs-revision'
    | 'paused'
    | 'failed'
    | 'blocked'
    | 'interrupted'
    | 'skipped',
  auditType: string,
  auditPayload?: Record<string, unknown>,
) => Promise<void>;

/**
 * Signature for runGateWithRepair, passed to rework to break circular deps.
 */
export type RunGateWithRepairFn = (
  runId: string,
  node: ExecutableNode,
  gate: WorkflowGateConfig,
  gateOpts?: { forceRerun?: boolean },
) => Promise<boolean>;

/**
 * Common dependencies shared across most workflow sub-modules.
 */
export interface WorkflowCommonDeps {
  repoPath: string;
  dataDir: string;
  repositories: import('../db/repositories.js').TekonRepositories;
  audit: import('../audit/logger.js').AuditLogger;
}

/**
 * Artifact store interface (subset used by workflow modules).
 */
export interface ArtifactStoreLike {
  readArtifactForPrompt(artifact: {
    id: string;
    path: string;
    type: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Shared utility functions (no closure state)
// ---------------------------------------------------------------------------

export function scopedId(runId: string, id: string): string {
  return `${runId}_${id}`;
}

export function gatesWithStableKeys<
  T extends GateConfig | WorkflowGateConfig,
>(
  gates: T[],
  nodeId = 'workflow node',
): Array<T & { gateKey: string }> {
  const keyed = gates.map((gate, index) => ({
    ...gate,
    gateKey: gate.gateKey ?? stableGateKey(gate, index),
  }));
  const seen = new Set<string>();
  for (const gate of keyed) {
    if (seen.has(gate.gateKey)) {
      throw new Error(
        `duplicate gateKey "${gate.gateKey}" in node "${nodeId}"`,
      );
    }
    seen.add(gate.gateKey);
  }
  return keyed;
}

export function stableGateKey(
  gate: Pick<
    GateConfig | WorkflowGateConfig,
    'type' | 'artifactType' | 'commandRef' | 'skipReason'
  >,
  index: number,
): string {
  return [
    String(index).padStart(2, '0'),
    gate.type,
    gate.artifactType ? `artifact=${gate.artifactType}` : '',
    gate.commandRef ? `commandRef=${gate.commandRef}` : '',
    gate.skipReason ? 'skipped' : '',
  ]
    .filter(Boolean)
    .join(':');
}

export function makeSyntheticLease(
  repoPath: string,
  runId: string,
  node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
): WorktreeLease {
  const now = new Date().toISOString();
  return {
    id: `lease_${node.id}`,
    runId,
    nodeId: node.id,
    role: node.role,
    repoPath,
    worktreePath: repoPath,
    branchName: `tekon/${runId}/${node.id}`,
    createdAt: now,
  };
}

export function defaultCommandPolicy(repoPath: string): CommandPolicy {
  return {
    allow: [
      { tool: 'git', args: [] },
      { tool: 'pnpm', args: [] },
      { tool: 'npm', args: [] },
      { tool: 'claude', args: [] },
      { tool: 'codex', args: [] },
    ],
    deny: [],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'disabled',
  };
}

export function defaultBuiltInRolesDir(): string {
  const fromModule = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'roles',
  );
  if (existsSync(fromModule)) {
    return fromModule;
  }
  return resolve(process.cwd(), 'roles');
}

/**
 * Heuristic for finding the review target when no explicit targetNodeId is
 * available: pick the last (most recent) upstream node whose status is
 * 'passed'. Returns null when no such node exists or when the review node
 * itself is not found in the list.
 */
export function resolveReviewTargetNodeByHeuristic(
  nodes: ReadonlyArray<{ id: string; status: string }>,
  reviewNodeId: string,
): string | null {
  const reviewNode = nodes.find((n) => n.id === reviewNodeId);
  if (!reviewNode) return null;

  const upstreamNodes = nodes.filter(
    (n) => n.id !== reviewNodeId && n.status === 'passed',
  );
  if (upstreamNodes.length > 0) {
    return upstreamNodes[upstreamNodes.length - 1].id;
  }
  return null;
}

/**
 * Returns true when a gate failure should trigger the changes-requested
 * rework flow: only independent-review gates with a changes-requested
 * classification qualify.
 */
export function isChangesRequested(
  failureClassification: string | null | undefined,
  gateType: string,
): boolean {
  return (
    failureClassification === 'changes-requested' &&
    gateType === 'independent-review'
  );
}

/**
 * Resolves the maximum number of rework attempts for a changes-requested
 * cycle. Falls back to 5 when gate.maxRetries is zero or negative.
 */
export function resolveMaxReworkAttempts(maxRetries: number): number {
  return maxRetries > 0 ? maxRetries : 5;
}
