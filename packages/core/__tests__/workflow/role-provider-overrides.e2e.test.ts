import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { passthroughGateEngine } from '../helpers/passthrough-gate-engine.js';

import {
  createAuditLogger,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openTekonDatabase,
  type AgentRunInput,
  type AgentRunResult,
} from '../../src/index.js';

// PD-10：角色 agent.yaml 的 model/effort 经引擎逐节点注入 adapter 输入，
// driver 与 run provider 不符时在节点启动前显式失败。
describe('PD-10 role provider overrides through the engine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeRole(rolesDir: string, agentYaml: string) {
    const dir = join(rolesDir, 'rd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.yaml'), agentYaml, 'utf8');
    writeFileSync(join(dir, 'system.md'), 'RD system\n', 'utf8');
  }

  function spec() {
    return {
      id: 'role-override-e2e',
      name: 'Role Override',
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
          name: 'Dev',
          dependsOn: [],
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [],
              outputs: [],
              gates: [],
              dependsOn: [],
            },
          ],
        },
      ],
    };
  }

  it('delivers role model/effort to the adapter input for a real provider', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-role-ov-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-role-ov-roles-'));
    tempDirs.push(repoPath, rolesDir);
    writeRole(
      rolesDir,
      [
        'role: rd',
        'name: RD',
        'driver: claude-code',
        'model: claude-opts-5-5',
        '',
      ].join('\n'),
    );

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const captured: AgentRunInput[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      // 真实 provider 名驱动覆盖解析；adapter 用测试替身捕获入参。
      agentProvider: 'claude-code',
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          captured.push(input);
          return {
            provider: 'claude-code',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: passthroughGateEngine(repositories),
    });

    const result = await engine.startRun({
      demandText: '角色覆盖端到端',
      mode: 'template',
      workflowSpec: spec(),
    });

    expect(result.workflow.status).toBe('passed');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.providerOverrides).toEqual({
      model: 'claude-opts-5-5',
    });

    // 生效覆盖落审计链，可追溯。
    const events = await repositories.listAuditEvents(result.runId);
    const overrideEvent = events.find(
      (event) => event.type === 'role.provider-overrides',
    );
    expect(overrideEvent?.payload).toMatchObject({
      role: 'rd',
      driver: 'claude-code',
      model: 'claude-opts-5-5',
    });
    expect(String(overrideEvent?.payload.nodeId)).toContain('rd-node');
    db.close();
  });

  it('fails the node explicitly when the role driver mismatches the run provider', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-role-driver-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-role-driver-roles-'));
    tempDirs.push(repoPath, rolesDir);
    writeRole(
      rolesDir,
      ['role: rd', 'name: RD', 'driver: codex', 'model: gpt-x', ''].join('\n'),
    );

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      agentProvider: 'claude-code',
      adapter: {
        async runAgent(): Promise<AgentRunResult> {
          throw new Error('adapter must not be invoked on driver mismatch');
        },
      },
      gateEngine: passthroughGateEngine(repositories),
    });

    const result = await engine.startRun({
      demandText: 'driver 不匹配',
      mode: 'template',
      workflowSpec: spec(),
    });

    // 节点在 agent 调用前被拦截，运行收敛为 interrupted（可恢复错误，
    // 不是终态 failed），错误信息携带可操作的 ROLE_DRIVER_MISMATCH。
    expect(['interrupted', 'failed']).toContain(result.workflow.status);
    const events = await repositories.listAuditEvents(result.runId);
    const interrupted = events.find(
      (event) => event.type === 'node.interrupted',
    );
    expect(String(interrupted?.payload.error ?? '')).toContain(
      'ROLE_DRIVER_MISMATCH',
    );
    db.close();
  });
});
