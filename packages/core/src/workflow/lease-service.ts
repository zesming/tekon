import type { Node } from '../types/domain.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  type ExecutableNode,
  makeSyntheticLease,
} from './workflow-runtime.js';

export interface LeaseServiceDeps {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  worktreeManager?: WorktreeManager;
  baseRef?: string;
  allowDirtyBase?: boolean;
  executionLeases: Map<string, WorktreeLease>;
}

export interface LeaseService {
  createExecutionLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
  ): Promise<WorktreeLease>;
  activeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<WorktreeLease | undefined>;
  finalizeExecutionLease(runId: string, nodeId: string): Promise<void>;
}

export function createLeaseService(deps: LeaseServiceDeps): LeaseService {
  const {
    repoPath,
    repositories,
    audit,
    worktreeManager,
    baseRef,
    allowDirtyBase,
    executionLeases,
  } = deps;

  async function createExecutionLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
  ): Promise<WorktreeLease> {
    if (!worktreeManager) {
      const lease = makeSyntheticLease(repoPath, runId, node);
      executionLeases.set(node.id, lease);
      return lease;
    }

    const runBranch = await worktreeManager.ensureRunBranch({
      repoPath,
      runId,
      baseRef: baseRef ?? 'HEAD',
    });
    const lease = await worktreeManager.createLease({
      repoPath,
      runId,
      nodeId: node.id,
      role: node.role,
      baseRef: runBranch,
      allowDirtyBase,
    });
    await audit.append({
      runId,
      type: 'worktree.lease.created',
      payload: {
        nodeId: node.id,
        leaseId: lease.id,
        worktreePath: lease.worktreePath,
        branchName: lease.branchName,
      },
    });
    executionLeases.set(node.id, lease);
    return lease;
  }

  async function activeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<WorktreeLease | undefined> {
    const inMemory = executionLeases.get(nodeId);
    if (inMemory && !inMemory.releasedAt) {
      return inMemory;
    }
    const leases = await repositories.listWorktreeLeases(runId);
    const activeLease = leases
      .filter((lease) => lease.nodeId === nodeId && !lease.releasedAt)
      .at(-1);
    if (activeLease) {
      executionLeases.set(nodeId, activeLease);
    }
    return activeLease;
  }

  async function finalizeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<void> {
    const lease = await activeExecutionLease(runId, nodeId);
    if (!lease || !worktreeManager) {
      return;
    }
    const node = await repositories.getNode(nodeId);
    if (!nodeAllowsSourceChanges(node)) {
      const sourceInspection =
        await worktreeManager.inspectLeaseSourceChanges(lease.id);
      if (
        sourceInspection.changedPaths.length > 0 ||
        sourceInspection.headChanged
      ) {
        const changedPaths =
          sourceInspection.changedPaths.length > 0
            ? sourceInspection.changedPaths.join(', ')
            : `lease HEAD moved from ${sourceInspection.baseHead ?? 'unknown'} to ${sourceInspection.currentHead}`;
        throw new Error(
          `node ${nodeId} is not allowed to modify repository source files: ${changedPaths}`,
        );
      }
    }

    const committed = await worktreeManager.commitLeaseChanges(lease.id, {
      message: `Tekon ${runId} ${nodeId}`,
    });
    const branchName = await worktreeManager.promoteLeaseToRunBranch({
      leaseId: lease.id,
    });
    await audit.append({
      runId,
      type: 'worktree.lease.promoted',
      payload: {
        nodeId,
        leaseId: lease.id,
        branchName,
        committed,
      },
    });
    await worktreeManager.releaseLease(lease.id);
    deleteLeaseAliases(lease.id);
    await audit.append({
      runId,
      type: 'worktree.lease.released',
      payload: {
        nodeId,
        leaseId: lease.id,
      },
    });
  }

  function deleteLeaseAliases(leaseId: string): void {
    for (const [key, lease] of executionLeases.entries()) {
      if (lease.id === leaseId) {
        executionLeases.delete(key);
      }
    }
  }

  return {
    createExecutionLease,
    activeExecutionLease,
    finalizeExecutionLease,
  };
}

export function nodeAllowsSourceChanges(
  node: Pick<Node, 'outputs'> | null,
): boolean {
  return Boolean(
    node?.outputs.some((output) => output.type === 'code-changes'),
  );
}
