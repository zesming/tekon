import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
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

// PD-18（合同 6）：人工驳回把备注带回返工链路。resume 一个被 reject 的
// human gate 时，按 gate 声明的 reworkTargetNodeId 对上游目标节点发起返工
// （备注注入返工提示词），返工后重跑评审节点并产生新的 pending 决策，而不
// 是盲目重跑被驳回节点本身。
describe('PD-18 human rejection rework e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-human-rework-'));
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

  function spec() {
    return {
      id: 'human-rework',
      name: 'Human Rework',
      version: 1,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
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
              gates: [],
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
              outputs: [{ id: 'review', type: 'review-report' }],
              gates: [
                {
                  type: 'human',
                  requiresHumanApproval: true,
                  reworkTargetNodeId: 'rd-node',
                },
              ],
              dependsOn: ['rd-node'],
            },
          ],
        },
      ],
    };
  }

  it('reworks the declared upstream target on resume and opens a fresh approval', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const prompts: string[] = [];
    const mock = createMockAgentAdapter();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        prompts.push(input.prompt);
        if (input.runContext.nodeId.endsWith('rd-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            `implemented ${prompts.length}\n`,
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      // 真实 gate engine：human gate 走 requestHumanGate 暂停流程。
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    // 1) 首跑在 human gate 暂停。
    const first = await engine.startRun({
      demandText: '人工驳回返工合同',
      mode: 'template',
      workflowSpec: spec(),
    });
    expect(first.workflow.status).toBe('paused');
    const initialDecisions = await repositories.listHumanDecisions(first.runId);
    expect(initialDecisions).toHaveLength(1);
    expect(initialDecisions[0]!.status).toBe('pending');

    // 2) 驳回（带备注）→ 节点 blocked。
    await createHumanGate({ repositories }).rejectHumanGate(
      initialDecisions[0]!.id,
      'contract-reviewer',
      'REJECT-NOTE-MARKER: 请覆盖空输入边界',
    );
    const blocked = await repositories.getWorkflowInstance(first.runId);
    expect(blocked?.status).toBe('blocked');

    // 3) resume 触发返工：目标 rd-node 重跑，评审节点重跑，human gate 再请求。
    const resumed = await engine.resumeRun(first.runId);
    expect(resumed.workflow.status).toBe('paused');

    // 返工节点指向声明的上游目标。
    const nodes = await repositories.listNodes(first.runId);
    const reworkNodes = nodes.filter((item) =>
      item.id.includes('rd-node_rework_'),
    );
    expect(reworkNodes).toHaveLength(1);

    // 驳回备注进入了返工提示词。
    expect(
      prompts.some((prompt) => prompt.includes('REJECT-NOTE-MARKER')),
    ).toBe(true);

    // 产生了新的 pending 决策（旧决策保持 rejected）。
    const decisions = await repositories.listHumanDecisions(first.runId);
    expect(decisions.filter((d) => d.status === 'pending')).toHaveLength(1);
    expect(decisions.filter((d) => d.status === 'rejected')).toHaveLength(1);

    // 返工有完整审计轨迹。
    const events = await repositories.listAuditEvents(first.runId);
    expect(events.some((e) => e.type === 'node.human-rework.started')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'gate.rework.completed')).toBe(true);

    db.close();
  }, 120_000);

  // MF1：人工返工必须发 gate.rework.attempt，否则动态返工节点无法通过下一
  // 次 resume 的计划完整性校验（nodes.unproven），run 被彻底卡死。
  it('passes plan integrity on the next resume after approving the fresh decision', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        if (input.runContext.nodeId.endsWith('rd-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const first = await engine.startRun({
      demandText: '人工返工后二次 resume 完整性',
      mode: 'template',
      workflowSpec: spec(),
    });
    const initial = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      initial.id,
      'contract-reviewer',
      '请覆盖空输入边界',
    );
    const reworked = await engine.resumeRun(first.runId);
    expect(reworked.workflow.status).toBe('paused');

    // 返工产生的 attempt 事件必须与 needs-revision 配对，授权动态节点。
    const eventsAfterRework = await repositories.listAuditEvents(first.runId);
    expect(
      eventsAfterRework.some((e) => e.type === 'gate.rework.attempt'),
    ).toBe(true);

    // 批准新决策后再次 resume：完整性校验必须通过并跑到 passed。
    const nextDecision = (
      await repositories.listHumanDecisions(first.runId)
    ).find((d) => d.status === 'pending')!;
    await createHumanGate({ repositories }).approveHumanGate(
      nextDecision.id,
      'contract-reviewer',
    );
    const approved = await engine.resumeRun(first.runId);
    expect(approved.workflow.status).toBe('passed');

    db.close();
  }, 120_000);

  it('reworks again on a second rejection and still resumes to passed', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        if (input.runContext.nodeId.endsWith('rd-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const first = await engine.startRun({
      demandText: '二次驳回二次返工',
      mode: 'template',
      workflowSpec: spec(),
    });
    let decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '第一轮驳回',
    );
    expect((await engine.resumeRun(first.runId)).workflow.status).toBe(
      'paused',
    );

    decision = (await repositories.listHumanDecisions(first.runId)).find(
      (d) => d.status === 'pending',
    )!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '第二轮驳回',
    );
    const secondRework = await engine.resumeRun(first.runId);
    expect(secondRework.workflow.status).toBe('paused');

    // 两次驳回各触发一次返工，两个动态返工节点都被完整性校验授权。
    const reworkNodes = (await repositories.listNodes(first.runId)).filter(
      (node) => node.id.includes('rd-node_rework_'),
    );
    expect(reworkNodes).toHaveLength(2);
    const attemptEvents = (
      await repositories.listAuditEvents(first.runId)
    ).filter((e) => e.type === 'gate.rework.attempt');
    expect(attemptEvents).toHaveLength(2);

    decision = (await repositories.listHumanDecisions(first.runId)).find(
      (d) => d.status === 'pending',
    )!;
    await createHumanGate({ repositories }).approveHumanGate(
      decision.id,
      'contract-reviewer',
    );
    const final = await engine.resumeRun(first.runId);
    expect(final.workflow.status).toBe('passed');

    db.close();
  }, 120_000);

  /**
   * MF2：人工返工失败注入。返工 agent 的 runContext 是目标节点 id，故按
   * 返工提示词标记（共享 buildReworkNodePrompt 的 Review Feedback）识别；
   * 评审重跑按 reviewer 节点第二次调用识别。
   */
  function failureAdapter(fail: {
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
          throw new Error('HUMAN-REWORK-AGENT-MARKER: injected failure');
        }
        if (nodeId.endsWith('_reviewer-node')) {
          const count = (reviewerCalls.get(nodeId) ?? 0) + 1;
          reviewerCalls.set(nodeId, count);
          if (fail.reviewerRerunOnce && count === 2) {
            throw new Error(
              'HUMAN-REVIEW-RERUN-MARKER: injected review failure',
            );
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

  async function buildEngine(
    repoPath: string,
    repositories: ReturnType<typeof createRepositories>,
    audit: ReturnType<typeof createAuditLogger>,
    gateway: ReturnType<typeof createCommandGateway>,
    adapter: AgentAdapter,
    gateEngine?: GateEngine,
  ) {
    return createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: gateEngine ?? createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
  }

  it('converges to interrupted when the human rework agent fails, then recovers on resume', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const engine = await buildEngine(
      repoPath,
      repositories,
      audit,
      gateway,
      failureAdapter({ reworkAgentOnce: true }),
    );

    const first = await engine.startRun({
      demandText: '人工返工 agent 失败收敛',
      mode: 'template',
      workflowSpec: spec(),
    });
    const decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '请覆盖空输入边界',
    );
    const failedRework = await engine.resumeRun(first.runId);
    try {
      // 工作流与评审节点都必须收敛为 interrupted，不能谎报 running。
      expect(failedRework.workflow.status).toBe('interrupted');
      const reviewNode = (await repositories.listNodes(first.runId)).find(
        (node) => node.id.endsWith('_reviewer-node'),
      )!;
      expect(reviewNode.status).toBe('interrupted');
      const reworkNode = (await repositories.listNodes(first.runId)).find(
        (node) => node.id.includes('rd-node_rework_'),
      )!;
      expect(reworkNode.status).toBe('interrupted');
      const roleRun = await repositories.getLatestRoleRunForNode(
        first.runId,
        reworkNode.id,
      );
      expect(roleRun?.status).toBe('interrupted');
      const events = await repositories.listAuditEvents(first.runId);
      expect(events.some((e) => e.type === 'gate.rework.failed')).toBe(true);
      expect(
        String(
          events.find((e) => e.type === 'gate.rework.failed')?.payload.error,
        ),
      ).toContain('HUMAN-REWORK-AGENT-MARKER');

      // 恢复后返工跑通，human gate 再次暂停等待审批。
      const recovered = await engine.resumeRun(first.runId);
      expect(recovered.workflow.status).toBe('paused');
      const pending = (
        await repositories.listHumanDecisions(first.runId)
      ).filter((d) => d.status === 'pending');
      expect(pending).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 120_000);

  it('reruns the blocked node without rework when the human gate declares no rework target (legacy template)', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        if (input.runContext.nodeId.endsWith('rd-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };
    const engine = await buildEngine(
      repoPath,
      repositories,
      audit,
      gateway,
      adapter,
    );

    // 旧模板：human gate 没有 reworkTargetNodeId 字段。
    const legacySpec = spec();
    delete (legacySpec.phases[1]!.nodes[0]!.gates[0] as Record<string, unknown>)
      .reworkTargetNodeId;

    const first = await engine.startRun({
      demandText: '旧模板人工驳回无返工',
      mode: 'template',
      workflowSpec: legacySpec,
    });
    const decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '旧模板驳回',
    );
    const resumed = await engine.resumeRun(first.runId);
    try {
      // 常规 blocked 恢复：重跑评审节点后 human gate 再次暂停，无动态返工节点。
      expect(resumed.workflow.status).toBe('paused');
      const nodes = await repositories.listNodes(first.runId);
      expect(nodes.some((node) => node.id.includes('_rework_'))).toBe(false);
      const events = await repositories.listAuditEvents(first.runId);
      expect(events.some((e) => e.type === 'gate.rework.attempt')).toBe(false);
      expect(
        (await repositories.listHumanDecisions(first.runId)).filter(
          (d) => d.status === 'pending',
        ),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 120_000);

  it('converges to interrupted when the review re-run after human rework fails, then recovers', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const engine = await buildEngine(
      repoPath,
      repositories,
      audit,
      gateway,
      failureAdapter({ reviewerRerunOnce: true }),
    );

    const first = await engine.startRun({
      demandText: '人工返工评审重跑失败收敛',
      mode: 'template',
      workflowSpec: spec(),
    });
    const decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '请覆盖空输入边界',
    );
    const failedRework = await engine.resumeRun(first.runId);
    try {
      expect(failedRework.workflow.status).toBe('interrupted');
      const reviewNode = (await repositories.listNodes(first.runId)).find(
        (node) => node.id.endsWith('_reviewer-node'),
      )!;
      expect(reviewNode.status).toBe('interrupted');
      const events = await repositories.listAuditEvents(first.runId);
      const errorText = events
        .map((e) => String(e.payload?.error ?? ''))
        .join('\n');
      expect(errorText).toContain('HUMAN-REVIEW-RERUN-MARKER');
      expect(errorText).not.toContain('illegal workflow transition');

      const recovered = await engine.resumeRun(first.runId);
      expect(recovered.workflow.status).toBe('paused');
    } finally {
      db.close();
    }
  }, 120_000);
});
