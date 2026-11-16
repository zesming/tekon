import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
  type AgentAdapter,
  type AgentRunInput,
  type GateEngine,
} from '../../src/index.js';

// CD-33：返工三条失败路径不得产生孤儿 role_run（留在 running）或用二次异常
// 掩盖真实原因：
// 1. 返工 agent 失败 → 返工节点 interrupted、role_run interrupted、审计带真实错误；
// 2. 评审节点重跑失败 → 同上，且错误向上抛出而不是被吞掉后触发非法状态转换；
// 3. 返工后目标门禁抛错 → interrupted 保留真实门禁错误，不出现租约二次异常。
describe('CD-33 rework error paths e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rework-errors-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    return repoPath;
  }

  function workflowSpec() {
    return {
      id: 'rework-errors',
      name: 'Rework Errors',
      version: 1,
      retryPolicy: {
        maxAttempts: 2,
        maxRetries: 1,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'block' as const,
      },
      phases: [
        {
          id: 'implementation',
          name: 'Implementation',
          dependsOn: [],
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [
                {
                  type: 'build',
                  requiresHumanApproval: false,
                  maxRetries: 0,
                  retryPolicy: {
                    maxRetries: 0,
                    maxAttempts: 1,
                    backoffMs: 0,
                    strategy: 'fixed' as const,
                    onExhausted: 'block' as const,
                  },
                },
              ],
              dependsOn: [],
            },
          ],
        },
        {
          id: 'review',
          name: 'Review',
          dependsOn: ['implementation'],
          nodes: [
            {
              id: 'reviewer-node',
              role: 'reviewer',
              inputs: [
                { id: 'code', type: 'code-changes', fromNodeId: 'rd-node' },
              ],
              outputs: [{ id: 'review', type: 'code-review' }],
              gates: [
                {
                  type: 'independent-review',
                  requiresHumanApproval: false,
                  maxRetries: 1,
                  retryPolicy: {
                    maxRetries: 1,
                    maxAttempts: 2,
                    backoffMs: 0,
                    strategy: 'fixed' as const,
                    onExhausted: 'block' as const,
                  },
                },
              ],
              dependsOn: ['rd-node'],
            },
          ],
        },
      ],
    };
  }

  /**
   * Reviewer writes changes-requested on its first run; later runs are normal.
   * The rework agent runs with the TARGET node id (agentInputForLease overrides
   * runContext with targetNodeId), so rework failure injection keys off the
   * rework prompt marker rather than the node id.
   */
  function changesRequestedReviewerAdapter(fail: {
    reworkAgentOnce?: boolean;
    reviewerRerunOnce?: boolean;
  }): AgentAdapter {
    const mock = createMockAgentAdapter();
    const reviewerCalls = new Map<string, number>();
    const reworkFailures = new Set<string>();
    return {
      ...mock,
      async runAgent(input: AgentRunInput) {
        const nodeId = input.runContext.nodeId;
        if (
          fail.reworkAgentOnce &&
          input.prompt.includes('Review Feedback') &&
          !reworkFailures.has(nodeId)
        ) {
          reworkFailures.add(nodeId);
          throw new Error('REWORK-AGENT-MARKER: injected agent failure');
        }
        if (nodeId.endsWith('_reviewer-node')) {
          const count = (reviewerCalls.get(nodeId) ?? 0) + 1;
          reviewerCalls.set(nodeId, count);
          if (fail.reviewerRerunOnce && count === 2) {
            throw new Error(
              'REVIEW-RERUN-MARKER: injected review re-execute failure',
            );
          }
          if (count === 1) {
            const store = input.artifactStore!;
            return mock.runAgent({
              ...input,
              artifactStore: {
                ...store,
                async writeArtifact(artifact) {
                  if (artifact.type !== 'code-review') {
                    return store.writeArtifact(artifact);
                  }
                  const payload = JSON.parse(artifact.content) as Record<
                    string,
                    unknown
                  >;
                  payload.decision = 'changes-requested';
                  payload.findings = [
                    { severity: 'important', message: 'needs another pass' },
                  ];
                  return store.writeArtifact({
                    ...artifact,
                    content: JSON.stringify(payload),
                  });
                },
              },
            });
          }
        }
        if (nodeId.endsWith('rd-node')) {
          const result = await mock.runAgent(input);
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
          return result;
        }
        return mock.runAgent(input);
      },
    };
  }

  function changesRequestedOnceGateEngine(
    repositories: ReturnType<typeof createRepositories>,
    options: { throwOnTargetGate?: boolean } = {},
  ): GateEngine {
    const callsByNode = new Map<string, number>();
    return {
      async runGate(input) {
        const count = (callsByNode.get(input.nodeId) ?? 0) + 1;
        callsByNode.set(input.nodeId, count);
        // 返工后的目标门禁以目标节点 id 重跑（租约别名），按调用次数识别。
        if (
          options.throwOnTargetGate &&
          input.gate.type === 'build' &&
          count === 2
        ) {
          throw new Error('TARGET-GATE-MARKER: injected gate failure');
        }
        const shouldFail =
          input.gate.type === 'independent-review' && count === 1;
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${Date.now()}_${count}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: shouldFail ? 'failed' : 'passed',
          failureClassification: shouldFail ? 'changes-requested' : null,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
    };
  }

  async function buildEngine(input: {
    repoPath: string;
    repositories: ReturnType<typeof createRepositories>;
    audit: ReturnType<typeof createAuditLogger>;
    gateway: ReturnType<typeof createCommandGateway>;
    adapter: AgentAdapter;
    gateEngine: GateEngine;
  }) {
    return createWorkflowEngine({
      repoPath: input.repoPath,
      dataDir: '.tekon',
      repositories: input.repositories,
      audit: input.audit,
      agentProvider: 'mock',
      adapter: input.adapter,
      gateEngine: input.gateEngine,
      worktreeManager: createWorktreeManager({
        repositories: input.repositories,
        gateway: input.gateway,
      }),
    });
  }

  it('marks the rework role_run interrupted when the rework agent fails, then recovers on resume', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const adapter = changesRequestedReviewerAdapter({
      reworkAgentOnce: true,
    });
    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter,
      gateEngine: changesRequestedOnceGateEngine(repositories),
    });

    const first = await engine.startRun({
      demandText: 'CD-33 返工 agent 失败',
      mode: 'template',
      workflowSpec: workflowSpec(),
    });
    try {
      expect(first.workflow.status).toBe('interrupted');
      const reworkNode = (await repositories.listNodes(first.runId)).find(
        (node) => /_rework_\d+_/u.test(node.id),
      );
      expect(reworkNode).toBeDefined();
      expect(reworkNode!.status).toBe('interrupted');
      const roleRun = await repositories.getLatestRoleRunForNode(
        first.runId,
        reworkNode!.id,
      );
      expect(roleRun?.status).toBe('interrupted');
      expect(roleRun?.interruptedAt).toBeTruthy();
      const events = await repositories.listAuditEvents(first.runId);
      const failedEvent = events.find(
        (event) => event.type === 'gate.rework.failed',
      );
      expect(String(failedEvent?.payload?.error)).toContain(
        'REWORK-AGENT-MARKER',
      );

      const resumed = await engine.resumeRun(first.runId);
      expect(resumed.workflow.status).toBe('passed');
      const recoveredRoleRun = await repositories.getLatestRoleRunForNode(
        first.runId,
        reworkNode!.id,
      );
      expect(recoveredRoleRun?.status).toBe('passed');
    } finally {
      db.close();
    }
  }, 120_000);

  it('marks the review role_run interrupted and surfaces the real error when the review re-run fails', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const adapter = changesRequestedReviewerAdapter({
      reviewerRerunOnce: true,
    });
    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter,
      gateEngine: changesRequestedOnceGateEngine(repositories),
    });

    const first = await engine.startRun({
      demandText: 'CD-33 评审重跑失败',
      mode: 'template',
      workflowSpec: workflowSpec(),
    });
    try {
      expect(first.workflow.status).toBe('interrupted');
      const reviewNode = (await repositories.listNodes(first.runId)).find(
        (node) => node.id.endsWith('_reviewer-node'),
      );
      expect(reviewNode?.status).toBe('interrupted');
      const roleRun = await repositories.getLatestRoleRunForNode(
        first.runId,
        reviewNode!.id,
      );
      expect(roleRun?.status).toBe('interrupted');
      const events = await repositories.listAuditEvents(first.runId);
      const failedEvent = events.find(
        (event) => event.type === 'gate.rework.review.re-execute.failed',
      );
      expect(String(failedEvent?.payload?.error)).toContain(
        'REVIEW-RERUN-MARKER',
      );
      // 真实错误不得被二次异常掩盖。
      expect(
        events.some((event) =>
          String(event.payload?.error).includes('active execution lease'),
        ),
      ).toBe(false);
      expect(
        events.some((event) =>
          String(event.payload?.error).includes('illegal workflow transition'),
        ),
      ).toBe(false);

      const resumed = await engine.resumeRun(first.runId);
      expect(resumed.workflow.status).toBe('passed');
    } finally {
      db.close();
    }
  }, 120_000);

  it('keeps the real gate error when a target gate throws after rework', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const adapter = changesRequestedReviewerAdapter({});
    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter,
      gateEngine: changesRequestedOnceGateEngine(repositories, {
        throwOnTargetGate: true,
      }),
    });

    const first = await engine.startRun({
      demandText: 'CD-33 目标门禁抛错',
      mode: 'template',
      workflowSpec: workflowSpec(),
    });
    try {
      expect(first.workflow.status).toBe('interrupted');
      const events = await repositories.listAuditEvents(first.runId);
      const errorTexts = events
        .map((event) => String(event.payload?.error ?? ''))
        .join('\n');
      expect(errorTexts).toContain('TARGET-GATE-MARKER');
      expect(errorTexts).not.toContain('active execution lease');
      expect(errorTexts).not.toContain('illegal workflow transition');
    } finally {
      db.close();
    }
  }, 120_000);
});
