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
  type AgentRunInput,
  type AgentRunResult,
  type GateEngine,
} from '../../src/index.js';
import { validateAndBuildExecutionPlan } from '../../src/workflow/execution-plan.js';

// 审查 Should-fix 1 回归：声明了 prompt 的节点被 changes-requested 返工时，
// 节点指令必须在同进程返工提示词、落库 rework 行、resume 重建计划三条路径
// 上保持一致，评审反馈在节点指令之上叠加。
describe('rework node prompt consistency e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('carries the template node prompt through in-process rework, persistence and resume rebuild', async () => {
    const repoPath = createGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const prompts: Array<{ nodeId: string; prompt: string }> = [];
    const nodeInstruction = '节点指令：只处理空输入边界，保持公共 API 不变。';
    const mock = createMockAgentAdapter();

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter: {
        async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
          prompts.push({ nodeId: input.runContext.nodeId, prompt: input.prompt });
          if (input.runContext.nodeId.endsWith('rd-node')) {
            writeFileSync(
              join(input.runContext.repoPath, 'feature.txt'),
              'implemented\n',
              'utf8',
            );
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createChangesRequestedOnceGateEngine(repositories),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const result = await engine.startRun({
      demandText: '返工节点 prompt 一致性',
      mode: 'template',
      workflowSpec: {
        id: 'rework-prompt',
        name: 'Rework Prompt',
        version: 1,
        retryPolicy: {
          maxAttempts: 2,
          maxRetries: 1,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'implementation',
            name: 'Implementation',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'rd-node',
                role: 'rd',
                prompt: nodeInstruction,
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
                      strategy: 'fixed',
                      onExhausted: 'block',
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
            parallel: false,
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
                      strategy: 'fixed',
                      onExhausted: 'block',
                    },
                  },
                ],
                dependsOn: ['rd-node'],
              },
            ],
          },
        ],
      },
    });

    try {
      expect(result.workflow.status).toBe('passed');

      const nodes = await repositories.listNodes(result.runId);
      const reworkNodes = nodes.filter((node) =>
        /_rework_\d+_[0-9a-z]{8}$/u.test(node.id),
      );
      expect(reworkNodes).toHaveLength(1);

      // 路径 1：落库 rework 行携带节点指令。
      expect(reworkNodes[0]!.prompt).toBe(nodeInstruction);
      // 原节点行同样保留。
      const target = nodes.find((node) => node.id.endsWith('rd-node'));
      expect(target!.prompt).toBe(nodeInstruction);

      // 路径 2：同进程返工 agent 提示词同时含节点指令与评审反馈段落。
      // 返工调用的 runContext.nodeId 按合同复用目标节点 ID，故按反馈段落识别。
      const reworkPrompt = prompts.find((entry) =>
        entry.prompt.includes('Review Feedback'),
      )?.prompt;
      expect(reworkPrompt).toBeDefined();
      expect(reworkPrompt!).toContain(nodeInstruction);
      expect(reworkPrompt!).toContain('Review Feedback');

      // 路径 3：resume 重建（审计授权 + 快照派生）的 rework 节点携带指令。
      const rebuilt = await validateAndBuildExecutionPlan(
        result.runId,
        repositories,
        audit,
      );
      const rebuiltRework = rebuilt.phases
        .flatMap((phase) => phase.nodes)
        .find((node) => /_rework_\d+_[0-9a-z]{8}$/u.test(node.id));
      expect(rebuiltRework?.prompt).toBe(nodeInstruction);
    } finally {
      db.close();
    }
  }, 120_000);
});

function createChangesRequestedOnceGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  const reviewCallsByNode = new Map<string, number>();
  return {
    async runGate(input) {
      let shouldFailChangesRequested = false;
      if (input.gate.type === 'independent-review') {
        const count = (reviewCallsByNode.get(input.nodeId) ?? 0) + 1;
        reviewCallsByNode.set(input.nodeId, count);
        shouldFailChangesRequested = count === 1;
      }
      return repositories.recordGateResult({
        id: `gate_${input.gate.type}_${input.nodeId}_${Date.now()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        gateKey: input.gate.gateKey,
        status: shouldFailChangesRequested ? 'failed' : 'passed',
        failureClassification: shouldFailChangesRequested
          ? 'changes-requested'
          : null,
        durationMs: 0,
        retries: 0,
        createdAt: new Date().toISOString(),
      });
    },
  };
}

function createGitRepo(tempDirs: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rework-prompt-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
