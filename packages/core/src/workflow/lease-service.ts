import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { NodeWorkspace } from '../types/domain.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import { isGitRepository } from '../runtime/worktree-manager.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import {
  captureSourceSnapshot,
  diffSourceSnapshot,
  type SourceSnapshot,
} from '../runtime/source-snapshot.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  type ExecutableNode,
  makeSyntheticLease,
} from './workflow-runtime.js';

/**
 * CD-09：workspace:none 节点在 finalize 发现源修改时抛出。保持可恢复语义：
 * 不释放租约、不进入终态，用户回滚改动或从 worktreePath 取回改动后 resume，
 * node-executor 直接重试 finalize 而不重跑 agent。
 */
export class RecoverableLeaseError extends Error {
  readonly code = 'RECOVERABLE_LEASE_FAILURE' as const;

  constructor(
    message: string,
    readonly details: {
      changedPaths: string[];
      worktreePath?: string;
      snapshotPath?: string;
      recoveryHint: string;
    },
  ) {
    super(message);
    this.name = 'RecoverableLeaseError';
  }
}

export interface LeaseServiceDeps {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  worktreeManager?: WorktreeManager;
  /** CD-09：用于探测目录是否为 git 工作树，决定 none 节点的隔离方式。 */
  gateway?: CommandGateway;
  /** 相对 repoPath 的数据目录，源快照存于其 runs/<runId>/source-snapshots。 */
  dataDir?: string;
  baseRef?: string;
  allowDirtyBase?: boolean;
  executionLeases: Map<string, WorktreeLease>;
}

export interface LeaseService {
  createExecutionLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId' | 'workspace'>,
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
    gateway,
    dataDir = '.tekon',
    baseRef,
    allowDirtyBase,
    executionLeases,
  } = deps;

  function snapshotPathFor(runId: string, nodeId: string): string {
    return join(
      repoPath,
      dataDir,
      'runs',
      runId,
      'source-snapshots',
      `${nodeId}.json`,
    );
  }

  /**
   * CD-09：in-place 与非 git 目录的 none 节点使用合成租约（worktreePath 直指
   * repoPath）。与 standalone 引擎的内存合成租约不同，这里持久化到
   * worktree_leases 并写审计，使跨进程 resume 能恢复同一身份；none 节点额外
   * 落一份源快照作为 finalize 的比对基线。
   */
  async function createPersistedSyntheticLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId' | 'workspace'>,
    options: { captureSnapshot: boolean },
  ): Promise<WorktreeLease> {
    const lease = makeSyntheticLease(repoPath, runId, node);
    await repositories.recordWorktreeLease(lease);
    let snapshotPath: string | undefined;
    if (options.captureSnapshot) {
      snapshotPath = snapshotPathFor(runId, node.id);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      const snapshot = captureSourceSnapshot(repoPath);
      writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
    }
    executionLeases.set(node.id, lease);
    await audit.append({
      runId,
      type: 'worktree.lease.created',
      payload: {
        nodeId: node.id,
        leaseId: lease.id,
        worktreePath: lease.worktreePath,
        branchName: lease.branchName,
        workspace: node.workspace,
        ...(snapshotPath ? { snapshotPath } : {}),
      },
    });
    return lease;
  }

  async function createExecutionLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId' | 'workspace'>,
  ): Promise<WorktreeLease> {
    if (!worktreeManager) {
      // Standalone/测试引擎：维持原有内存合成租约合同，不持久化、不审计。
      const lease = makeSyntheticLease(repoPath, runId, node);
      executionLeases.set(node.id, lease);
      return lease;
    }

    // CD-09：in-place 显式要求在主工作区执行，任何环境都不建 worktree。
    if (node.workspace === 'in-place') {
      return createPersistedSyntheticLease(runId, node, {
        captureSnapshot: false,
      });
    }

    // none 节点在非 git 目录无法隔离，回落合成租约 + 文件快照，finalize 时
    // 用快照判定源修改；git 目录仍走真实 worktree 保留物理隔离。
    if (node.workspace === 'none') {
      const gitRepo = gateway ? await isGitRepository(gateway, repoPath) : false;
      if (!gitRepo) {
        return createPersistedSyntheticLease(runId, node, {
          captureSnapshot: true,
        });
      }
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
        workspace: node.workspace,
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
    const workspace: NodeWorkspace = node?.workspace ?? 'worktree';

    // CD-09：合成租约（in-place 或非 git 的 none）没有 worktree 可提升，
    // 只做 none 节点的快照比对，然后在 DB 释放租约。
    if (lease.worktreePath === lease.repoPath) {
      if (workspace === 'none') {
        const snapshotPath = snapshotPathFor(runId, nodeId);
        const baseline = JSON.parse(
          readFileSync(snapshotPath, 'utf8'),
        ) as SourceSnapshot;
        const diff = diffSourceSnapshot(lease.repoPath, baseline);
        if (diff.changedPaths.length > 0) {
          throw new RecoverableLeaseError(
            `node ${nodeId} is not allowed to modify repository source files: ${diff.changedPaths.join(', ')}`,
            {
              changedPaths: diff.changedPaths,
              snapshotPath,
              recoveryHint:
                '回滚上述文件后重新 resume 即可继续；该节点禁止修改源码，产物请通过节点 outputs 交付。',
            },
          );
        }
      }
      const releasedAt = new Date().toISOString();
      await repositories.releaseWorktreeLease(lease.id, releasedAt);
      deleteLeaseAliases(lease.id);
      await audit.append({
        runId,
        type: 'worktree.lease.released',
        payload: { nodeId, leaseId: lease.id, workspace },
      });
      return;
    }

    if (workspace === 'none') {
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
        throw new RecoverableLeaseError(
          `node ${nodeId} is not allowed to modify repository source files: ${changedPaths}`,
          {
            changedPaths: sourceInspection.changedPaths,
            worktreePath: lease.worktreePath,
            recoveryHint:
              `改动仍保留在工作树 ${lease.worktreePath}，可从该目录取回后回滚，再重新 resume。`,
          },
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
