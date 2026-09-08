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
    options?: { required?: boolean },
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

  // Resolve the execution selected by the durable event order. A later source
  // rerun supersedes earlier repairs; otherwise only the last repair intent is
  // authoritative. Never fall back to a convenient older repair worktree.
  async function durableExecutionIdentity(runId: string, nodeId: string, leases?: WorktreeLease[]) {
    const source = await repositories.getNode(nodeId);
    const events = await repositories.listAuditEvents(runId);
    const lastSourceCreation = events.map(event =>
      event.type === 'worktree.lease.created' && event.payload.nodeId === nodeId).lastIndexOf(true);
    const lastRepairIntent = events.map(event =>
      event.type === 'gate.repair.intent' && event.payload.sourceNodeId === nodeId).lastIndexOf(true);
    if (source && source.runId !== runId) throw new Error(`execution lease source Run mismatch for node ${nodeId}`);
    const directLeases = (leases ?? await repositories.listWorktreeLeases(runId)).filter(lease =>
      lease.runId === runId && lease.nodeId === nodeId && !lease.releasedAt);
    if (source && directLeases.some(lease => lease.role !== source.role)) {
      throw new Error(`durable source lease role mismatch for node ${nodeId}`);
    }
    const directLeaseId = events[lastSourceCreation]?.payload.leaseId;
    if (directLeases.length > 1 || (directLeases.length === 1 &&
      directLeaseId && directLeases[0].id !== directLeaseId)) {
      throw new Error(`ambiguous durable source lease for node ${nodeId}`);
    }
    // Repair intent is written before the original lease is released. If
    // shutdown lands in that window, the original source lease still wins.
    if (directLeases.length === 1) {
      return { source, events, executionNodeId: nodeId, leaseId: directLeaseId };
    }
    let executionNodeId = nodeId;
    if (source && ['awaiting-gate', 'running', 'paused'].includes(source.status) &&
      lastRepairIntent > lastSourceCreation) {
      const intent = events[lastRepairIntent].payload;
      const result = (await repositories.listGateResults(runId))
        .find(result => result.id === intent.gateResultId);
      const repairId = result ? `repair_${result.id}` : '';
      const repair = repairId ? await repositories.getNode(repairId) : null;
      if (source.runId !== runId || !result || result.runId !== runId ||
        result.nodeId !== nodeId || ['passed', 'skipped'].includes(result.status) ||
        intent.repairNodeId !== repairId || intent.fixerRole !== source.role ||
        intent.gateType !== result.gateType || intent.gateKey !== result.gateKey) {
        throw new Error(`invalid durable repair lease identity for node ${nodeId}`);
      }
      if (!repair) {
        const wasCreated = events.some(event => event.type === 'gate.repair.created' &&
          event.payload.repairNodeId === repairId);
        if (wasCreated) throw new Error(`missing materialized repair lease identity for node ${nodeId}`);
        // An intent-only shutdown can resume the original Gate and later stop
        // after its lease was finalized. The unmaterialized intent must not
        // hide that source execution's promotion/release evidence.
      } else {
        if (repair.runId !== runId || repair.role !== source.role ||
          repair.status !== 'passed' || repair.dependencies.length !== 1 ||
          repair.dependencies[0] !== nodeId) {
          throw new Error(`invalid durable repair lease identity for node ${nodeId}`);
        }
        executionNodeId = repairId;
      }
    }
    const created = events.filter(event =>
      event.type === 'worktree.lease.created' && event.payload.nodeId === executionNodeId).at(-1);
    return { source, events, executionNodeId, leaseId: created?.payload.leaseId };
  }

  async function activeExecutionLease(
    runId: string,
    nodeId: string,
    options?: { required?: boolean },
  ): Promise<WorktreeLease | undefined> {
    const inMemory = executionLeases.get(nodeId);
    if (inMemory && inMemory.runId === runId && !inMemory.releasedAt) {
      // Durable source executions must pass the same identity checks on hot
      // retries as on cold recovery. Preserve standalone and repair aliases.
      if (!worktreeManager || inMemory.nodeId !== nodeId ||
        !await repositories.getNode(nodeId)) return inMemory;
    }
    const leases = await repositories.listWorktreeLeases(runId);
    if (!worktreeManager) {
      // Standalone engines can intentionally run in repoPath without durable
      // worktrees. Keep their existing lease lookup and Gate fallback contract.
      const legacyLease = leases.filter(lease => lease.nodeId === nodeId && !lease.releasedAt).at(-1);
      if (legacyLease) executionLeases.set(nodeId, legacyLease);
      return legacyLease;
    }
    const identity = await durableExecutionIdentity(runId, nodeId, leases);
    const candidates = leases.filter(lease =>
      lease.runId === runId && lease.nodeId === identity.executionNodeId &&
      (!identity.source || lease.role === identity.source.role) && !lease.releasedAt);
    if (candidates.length > 1 || (candidates.length === 1 &&
      identity.leaseId && candidates[0].id !== identity.leaseId)) {
      throw new Error(`ambiguous durable execution lease for node ${nodeId}`);
    }
    const activeLease = candidates[0];
    if (activeLease) {
      executionLeases.set(nodeId, activeLease);
    } else if (options?.required && worktreeManager) {
      throw new Error(`active execution lease required for Gate on node ${nodeId}`);
    }
    return activeLease;
  }

  async function finalizeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<void> {
    const lease = await activeExecutionLease(runId, nodeId);
    if (!worktreeManager) return;
    if (!lease) {
      const identity = await durableExecutionIdentity(runId, nodeId);
      if (identity.source?.status === 'awaiting-gate') {
        // Shutdown can land after promotion/release but before node.passed.
        // Only evidence for the latest execution allows that final no-op.
        const leases = await repositories.listWorktreeLeases(runId);
        const released = leases.filter(candidate =>
          candidate.nodeId === identity.executionNodeId && candidate.runId === runId &&
          candidate.role === identity.source!.role && candidate.releasedAt &&
          (!identity.leaseId || candidate.id === identity.leaseId));
        const completed = released.length === 1 && (() => {
          const promotedIndex = identity.events.map(event =>
            event.type === 'worktree.lease.promoted' && event.payload.nodeId === nodeId &&
            event.payload.leaseId === released[0].id).lastIndexOf(true);
          const releasedIndex = identity.events.map(event =>
            event.type === 'worktree.lease.released' && event.payload.nodeId === nodeId &&
            event.payload.leaseId === released[0].id).lastIndexOf(true);
          return promotedIndex >= 0 && releasedIndex > promotedIndex;
        })();
        if (!completed) throw new Error(`missing finalized execution lease evidence for node ${nodeId}`);
      }
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
