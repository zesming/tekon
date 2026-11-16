import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import {
  assertDeliveryWorkspaceSupported,
  assertDeliveryBranchAvailable,
  createAuditLogger,
  createCommandGateway,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';
import { isRecoverableFinalizeInterrupt } from '../../src/workflow/node-executor.js';
import type { AuditEvent } from '../../src/types/domain.js';

// CD-09 8b-3：finalize 可恢复中断的 resume 语义（不重跑 agent）与 delivery
// 工作区边界。
describe('CD-09 8b-3 recoverable finalize and delivery workspace boundary', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('isRecoverableFinalizeInterrupt', () => {
    const event = (type: string, nodeId: string): AuditEvent =>
      ({ type, payload: { nodeId } }) as AuditEvent;

    it('is true when the last node event is a finalize failure', () => {
      const events = [
        event('node.started', 'n1'),
        event('worktree.lease.finalize.failed', 'n1'),
      ];
      expect(isRecoverableFinalizeInterrupt(events, 'n1')).toBe(true);
    });

    it('is false when the node later transitioned past the failure', () => {
      const events = [
        event('worktree.lease.finalize.failed', 'n1'),
        event('node.passed', 'n1'),
      ];
      expect(isRecoverableFinalizeInterrupt(events, 'n1')).toBe(false);
    });

    it('is false when another node has the failure but this node never failed finalize', () => {
      const events = [
        event('node.started', 'n1'),
        event('worktree.lease.finalize.failed', 'n2'),
      ];
      expect(isRecoverableFinalizeInterrupt(events, 'n1')).toBe(false);
    });

    it('is false for an empty history', () => {
      expect(isRecoverableFinalizeInterrupt([], 'n1')).toBe(false);
    });
  });

  describe('assertDeliveryWorkspaceSupported', () => {
    it('rejects runs containing in-place nodes with a stable error code', () => {
      expect(() =>
        assertDeliveryWorkspaceSupported([
          { id: 'run_a_writer', workspace: 'in-place' },
          { id: 'run_a_review', workspace: 'none' },
        ]),
      ).toThrow(/DELIVERY_WORKSPACE_UNSUPPORTED/);
    });

    it('accepts worktree-only and none nodes', () => {
      expect(() =>
        assertDeliveryWorkspaceSupported([
          { id: 'run_b_rd', workspace: 'worktree' },
          { id: 'run_b_qa', workspace: 'none' },
        ]),
      ).not.toThrow();
    });
  });

  describe('assertDeliveryBranchAvailable', () => {
    it('rejects a run whose leases are all synthetic (no git delivery branch)', () => {
      expect(() =>
        assertDeliveryBranchAvailable([
          { worktreePath: '/repo', repoPath: '/repo' },
        ]),
      ).toThrow(/DELIVERY_WORKSPACE_UNSUPPORTED/);
    });

    it('accepts a run that produced at least one real worktree lease', () => {
      expect(() =>
        assertDeliveryBranchAvailable([
          { worktreePath: '/repo', repoPath: '/repo' },
          {
            worktreePath: '/repo/.tekon/worktrees/run_x/lease_1',
            repoPath: '/repo',
          },
        ]),
      ).not.toThrow();
    });
  });

  it('resumes a none/non-git finalize failure without rerunning the agent after the user rolls back', async () => {
    // 非 git 目录：不 init，none 节点走合成租约 + 文件快照。
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-recover-nongit-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const forbiddenPath = join(repoPath, 'forbidden.txt');
    let agentRuns = 0;

    const buildEngine = (throwOnAgent: boolean) =>
      createWorkflowEngine({
        repoPath,
        dataDir: '.tekon',
        repositories,
        audit,
        agentProvider: 'mock',
        adapter: {
          async runAgent(input) {
            agentRuns += 1;
            if (throwOnAgent) {
              throw new Error('resume must not rerun the agent');
            }
            writeFileSync(forbiddenPath, 'agent wrote source\n', 'utf8');
            return createMockAgentAdapter().runAgent(input);
          },
        },
        worktreeManager: createWorktreeManager({ repositories, gateway }),
      });

    const first = await buildEngine(false).startRun({
      demandText: 'none 节点违规改源码后可恢复',
      mode: 'template',
      workflowSpec: {
        id: 'none-recover',
        name: 'None Recover',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'p1',
            name: 'P1',
            dependsOn: [],
            nodes: [
              {
                id: 'goal-node',
                role: 'goal',
                workspace: 'none',
                inputs: [],
                outputs: [],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(first.workflow.status).toBe('interrupted');
    expect(agentRuns).toBe(1);
    expect(existsSync(forbiddenPath)).toBe(true);
    const activeAfterFailure = (
      await repositories.listWorktreeLeases(first.runId)
    ).filter((lease) => !lease.releasedAt);
    expect(activeAfterFailure).toHaveLength(1);
    const events = await repositories.listAuditEvents(first.runId);
    expect(
      events.some((e) => e.type === 'worktree.lease.finalize.failed'),
    ).toBe(true);

    // 用户回滚违规改动后 resume：agent 不应再被调用。
    rmSync(forbiddenPath, { force: true });
    const resumed = await buildEngine(true).resumeRun(first.runId);

    expect(resumed.workflow.status).toBe('passed');
    expect(agentRuns).toBe(1);
    const activeAfterResume = (
      await repositories.listWorktreeLeases(first.runId)
    ).filter((lease) => !lease.releasedAt);
    expect(activeAfterResume).toHaveLength(0);
    expect(
      (await repositories.listAuditEvents(first.runId)).some(
        (e) => e.type === 'node.resumed-finalize',
      ),
    ).toBe(true);

    db.close();
  });

  it('cold resume after the lease was released but before node.passed reuses the lease and passes (MF-1)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cold-release-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    let agentRuns = 0;

    const buildEngine = (throwOnAgent: boolean) =>
      createWorkflowEngine({
        repoPath,
        dataDir: '.tekon',
        repositories,
        audit,
        agentProvider: 'mock',
        adapter: {
          async runAgent(input) {
            agentRuns += 1;
            if (throwOnAgent) throw new Error('resume must not rerun the agent');
            writeFileSync(join(repoPath, 'notes.md'), 'done\n', 'utf8');
            return createMockAgentAdapter().runAgent(input);
          },
        },
        worktreeManager: createWorktreeManager({ repositories, gateway }),
      });

    const first = await buildEngine(false).startRun({
      demandText: 'in-place 节点关停窗口恢复',
      mode: 'template',
      workflowSpec: {
        id: 'cold-release',
        name: 'Cold Release',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'p1',
            name: 'P1',
            dependsOn: [],
            nodes: [
              {
                id: 'writer',
                role: 'goal',
                workspace: 'in-place',
                inputs: [],
                outputs: [],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });
    expect(first.workflow.status).toBe('passed');
    const nodeId = (await repositories.listNodes(first.runId))[0].id;

    // 重放“租约已释放、node.passed 未写”的关停窗口：把节点拨回
    // awaiting-gate，租约保持 released，然后用全新引擎冷启动 resume。
    await repositories.transitionNode(nodeId, 'awaiting-gate');
    // 直接（非 guarded）把实例拨回 interrupted，模拟关停时未落终态。
    await repositories.updateWorkflowInstanceStatus(
      first.runId,
      'interrupted',
      nodeId,
    );

    const resumed = await buildEngine(true).resumeRun(first.runId);

    expect(resumed.workflow.status).toBe('passed');
    expect(agentRuns).toBe(1);
    // 没有产生第二条租约记录（确定性 id 被幂等复用）。
    const leases = await repositories.listWorktreeLeases(first.runId);
    expect(leases).toHaveLength(1);
    expect(leases[0].releasedAt).toBeTruthy();

    db.close();
  });
});
