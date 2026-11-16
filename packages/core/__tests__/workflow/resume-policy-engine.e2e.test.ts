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

// PD-31：
// 1) 确定性失败（missing-command 等白名单分类且条件仍成立）resume 不重跑
//    agent，节点保持 blocked，审计记录跳过原因；
// 2) 非白名单分类（exit-code）resume 重跑 agent，且提示词注入失败原因；
// 3) --gates-only 显式只重跑门禁，agent 调用次数不增加。
describe('PD-31 blocked resume policy e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-resume-policy-'));
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
      id: 'resume-policy',
      name: 'Resume Policy',
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
              // 无 command/commandRef：受理期不拦截，运行期落 missing-command。
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
      ],
    };
  }

  function countingAdapter(): {
    adapter: AgentAdapter;
    agentCalls: number;
    prompts: string[];
  } {
    const mock = createMockAgentAdapter();
    const agentCalls = { value: 0 };
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        agentCalls.value += 1;
        prompts.push(input.prompt);
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
    return {
      adapter,
      get agentCalls() {
        return agentCalls.value;
      },
      prompts,
    };
  }

  function gateEngine(
    repositories: ReturnType<typeof createRepositories>,
    mode: 'always-missing' | 'fail-once-exit-code',
  ): GateEngine {
    const callsByNode = new Map<string, number>();
    return {
      async runGate(input) {
        const count = (callsByNode.get(input.nodeId) ?? 0) + 1;
        callsByNode.set(input.nodeId, count);
        let status = 'failed';
        let classification: string | null = null;
        if (mode === 'always-missing') {
          classification = 'missing-command';
        } else if (count === 1) {
          classification = 'exit-code';
        } else {
          status = 'passed';
        }
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${Date.now()}_${count}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: status as 'failed' | 'passed',
          failureClassification: classification,
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

  it('fail-fasts missing-command resumes without rerunning the agent and keeps the node blocked', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const counted = countingAdapter();

    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: counted.adapter,
      gateEngine: gateEngine(repositories, 'always-missing'),
    });

    const first = await engine.startRun({
      demandText: 'PD-31 missing-command fail-fast',
      mode: 'template',
      workflowSpec: spec(),
    });
    try {
      expect(first.workflow.status).toBe('blocked');
      expect(counted.agentCalls).toBe(1);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const resumed = await engine.resumeRun(first.runId);
        expect(resumed.workflow.status).toBe('blocked');
      }
      // 两次 resume 都没有新建 role_run / 调用 agent。
      expect(counted.agentCalls).toBe(1);

      const events = await repositories.listAuditEvents(first.runId);
      const skips = events.filter(
        (event) => event.type === 'node.resume-skipped-deterministic',
      );
      expect(skips).toHaveLength(2);
      expect(String(skips[0]!.payload.classification)).toBe('missing-command');
      expect(String(skips[0]!.payload.hint).length).toBeGreaterThan(0);

      const node = (await repositories.listNodes(first.runId))[0]!;
      expect(node.status).toBe('blocked');
    } finally {
      db.close();
    }
  }, 120_000);

  it('reruns the agent for a non-whitelist classification and injects the failure reason into the prompt', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const counted = countingAdapter();

    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: counted.adapter,
      gateEngine: gateEngine(repositories, 'fail-once-exit-code'),
    });

    const first = await engine.startRun({
      demandText: 'PD-31 failure reason injection',
      mode: 'template',
      workflowSpec: spec(),
    });
    try {
      expect(first.workflow.status).toBe('blocked');
      expect(counted.agentCalls).toBe(1);

      const resumed = await engine.resumeRun(first.runId);
      expect(resumed.workflow.status).toBe('passed');
      expect(counted.agentCalls).toBe(2);
      const resumePrompt = counted.prompts[1]!;
      expect(resumePrompt).toContain('Prior gate failure');
      expect(resumePrompt).toContain('exit-code');
    } finally {
      db.close();
    }
  }, 120_000);

  it('gates-only resume reruns gates without calling the agent', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const counted = countingAdapter();

    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: counted.adapter,
      gateEngine: gateEngine(repositories, 'fail-once-exit-code'),
    });

    const first = await engine.startRun({
      demandText: 'PD-31 gates-only resume',
      mode: 'template',
      workflowSpec: spec(),
    });
    try {
      expect(first.workflow.status).toBe('blocked');
      expect(counted.agentCalls).toBe(1);

      const resumed = await engine.resumeRun(first.runId, {
        gatesOnly: true,
      });
      expect(resumed.workflow.status).toBe('passed');
      // 门禁重跑放行，agent 没有被再次调用。
      expect(counted.agentCalls).toBe(1);
      const events = await repositories.listAuditEvents(first.runId);
      expect(
        events.some((event) => event.type === 'node.resumed-gates-only'),
      ).toBe(true);
    } finally {
      db.close();
    }
  }, 120_000);

  it('rejects gates-only resume when the node has no completed agent run', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const counted = countingAdapter();

    const engine = await buildEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: counted.adapter,
      gateEngine: gateEngine(repositories, 'always-missing'),
    });

    const first = await engine.startRun({
      demandText: 'PD-31 gates-only guard',
      mode: 'template',
      workflowSpec: spec(),
    });
    try {
      expect(first.workflow.status).toBe('blocked');
      const node = (await repositories.listNodes(first.runId))[0]!;
      // 模拟 agent 未完成：把最新 role_run 标记为 interrupted，使
      // hasCompletedAgentRun 为 false（节点仍保持 blocked）。
      const roleRun = await repositories.getLatestRoleRunForNode(
        first.runId,
        node.id,
      );
      expect(roleRun).toBeDefined();
      await repositories.markRoleRunInterrupted({
        roleRunId: roleRun!.id,
        interruptedAt: new Date().toISOString(),
      });

      await expect(
        engine.resumeRun(first.runId, { gatesOnly: true }),
      ).rejects.toThrow(/GATES_ONLY_NO_AGENT_RUN/u);
      // 被拒绝时不产生任何 agent 调用，节点维持 blocked。
      expect(counted.agentCalls).toBe(1);
      const refreshed = await repositories.getNode(node.id);
      expect(refreshed?.status).toBe('blocked');
    } finally {
      db.close();
    }
  }, 120_000);
});
