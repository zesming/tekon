import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// PD-17 第 2 步（改指令）：角色 system.md/agent.yaml 不进冻结计划，节点执行
// 时由 loadRole 从磁盘读。blocked 后修改角色指令，普通 resume（不 rebind）
// 重跑节点的提示词就应携带新指令。
describe('PD-17 role instruction hot reload on resume', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-role-hotreload-'));
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

  function writeRole(rolesDir: string, systemPrompt: string): void {
    const rdDir = join(rolesDir, 'rd');
    mkdirSync(rdDir, { recursive: true });
    writeFileSync(
      join(rdDir, 'agent.yaml'),
      ['role: rd', 'name: Test RD', 'description: Test role'].join('\n'),
    );
    writeFileSync(join(rdDir, 'system.md'), systemPrompt);
    writeFileSync(
      join(rdDir, 'tools.yaml'),
      ['network: disabled', 'allow: []', 'deny: []'].join('\n'),
    );
  }

  function failOnceGateEngine(
    repositories: ReturnType<typeof createRepositories>,
  ): GateEngine {
    const calls = new Map<string, number>();
    return {
      async runGate(input) {
        const count = (calls.get(input.nodeId) ?? 0) + 1;
        calls.set(input.nodeId, count);
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${count}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: count === 1 ? 'failed' : 'passed',
          failureClassification: count === 1 ? 'exit-code' : null,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
    };
  }

  it('picks up edited role instructions on a plain resume without rebinding', async () => {
    const repoPath = createRepo();
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-role-hotreload-roles-'));
    tempDirs.push(rolesDir);
    const systemPath = join(rolesDir, 'rd', 'system.md');
    writeRole(rolesDir, 'ORIGINAL-ROLE-INSTRUCTION');

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
        return mock.runAgent(input);
      },
    };

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter,
      agentProvider: 'mock',
      builtInRolesDir: rolesDir,
      gateEngine: failOnceGateEngine(repositories),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const spec = {
      id: 'role-hot-reload',
      name: 'Role Hot Reload',
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
          id: 'dev',
          name: 'Development',
          dependsOn: [],
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [],
              outputs: [],
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

    const first = await engine.startRun({
      demandText: '角色指令热更',
      mode: 'template',
      workflowSpec: spec,
    });
    try {
      expect(first.workflow.status).toBe('blocked');
      expect(prompts[0]).toContain('ORIGINAL-ROLE-INSTRUCTION');

      // 修改角色指令（不做任何 rebind）。
      writeRole(rolesDir, 'UPDATED-ROLE-INSTRUCTION');
      const resumed = await engine.resumeRun(first.runId);
      expect(resumed.workflow.status).toBe('passed');

      // 第二次 agent 调用的提示词已携带磁盘上的新指令。
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('UPDATED-ROLE-INSTRUCTION');
      expect(prompts[1]).not.toContain('ORIGINAL-ROLE-INSTRUCTION');

      // 没有产生任何 rebind 事件，证明角色指令不在冻结绑定面。
      const events = await repositories.listAuditEvents(first.runId);
      expect(events.some((e) => e.type === 'run.rebound')).toBe(false);
    } finally {
      db.close();
    }
  }, 120_000);
});
