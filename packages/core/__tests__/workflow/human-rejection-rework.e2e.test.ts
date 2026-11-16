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
});
