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

// 10a-2：角色 tools.yaml 的 deny/requiresHumanApproval 经引擎逐节点合并进
// 适配器 AgentRunInput.commandPolicy（现有必填载体），而非只停留在 prompt 文本。
describe('10a-2 role tools.yaml enforcement through the engine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeRole(rolesDir: string, role: string, toolsYaml: string): void {
    const dir = join(rolesDir, role);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent.yaml'),
      ['role: ' + role, `name: ${role.toUpperCase()}`, ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(dir, 'system.md'), `${role} system\n`, 'utf8');
    writeFileSync(join(dir, 'tools.yaml'), toolsYaml, 'utf8');
  }

  function twoNodeSpec() {
    return {
      id: 'tool-policy-e2e',
      name: 'Tool Policy',
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
            {
              id: 'pm-node',
              role: 'pm',
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

  it('merges role deny/approval into the adapter commandPolicy without collapsing an empty role allow', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-tp-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-tp-roles-'));
    tempDirs.push(repoPath, rolesDir);

    writeRole(
      rolesDir,
      'rd',
      [
        'network: restricted',
        'allow:',
        '  - tool: git',
        '    args: []',
        'deny:',
        '  - tool: pnpm',
        '    args: [publish]',
        'requiresHumanApproval:',
        '  - tool: git',
        '    args: [push]',
        '',
      ].join('\n'),
    );
    // pm 角色空 allow：并集基线后不得塌缩为空允许集。
    writeRole(rolesDir, 'pm', 'network: disabled\n');

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
      agentProvider: 'mock',
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          captured.push(input);
          return {
            provider: 'mock',
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
      demandText: '角色工具策略端到端',
      mode: 'template',
      workflowSpec: twoNodeSpec(),
    });

    expect(result.workflow.status).toBe('passed');
    expect(captured).toHaveLength(2);
    const byNode = Object.fromEntries(
      captured.map((input) => [input.roleConfig.role, input]),
    );

    const rdPolicy = byNode['rd']!.commandPolicy;
    // 角色 deny 进入适配器策略（基线 deny 为空，这是新增硬约束）。
    expect(rdPolicy.deny).toContainEqual({
      tool: 'pnpm',
      args: ['publish'],
    });
    // 角色审批要求进入策略。
    expect(rdPolicy.requiresHumanApproval).toContainEqual({
      tool: 'git',
      args: ['push'],
    });
    // 基线 allow 仍在（角色有限 allow 与基线并集，不丢工具）。
    expect(rdPolicy.allow.map((c) => c.tool)).toEqual(
      expect.arrayContaining(['git', 'pnpm', 'npm', 'claude', 'codex', 'dsh']),
    );

    // pm 空 allow ∪ 基线 = 基线，allow 非空（不塌缩）。
    const pmPolicy = byNode['pm']!.commandPolicy;
    expect(pmPolicy.allow.length).toBeGreaterThan(0);
    expect(pmPolicy.allow.map((c) => c.tool)).toContain('git');

    // M1：角色工具策略生效落审计（每个节点一条），可追溯 source 与约束规模。
    // nodeId 带 runId 前缀（run_<id>_<node>），用后缀匹配节点。
    const events = await repositories.listAuditEvents(result.runId);
    const policyEvents = events.filter(
      (event) => event.type === 'role.tool-policy.applied',
    );
    expect(policyEvents).toHaveLength(2);
    const rdEvent = policyEvents.find((event) =>
      String(event.payload.nodeId).endsWith('rd-node'),
    );
    expect(rdEvent?.payload).toMatchObject({
      role: 'rd',
      network: 'restricted',
      denyCount: 1,
      approvalCount: 1,
    });
    expect(typeof rdEvent?.payload.source).toBe('string');
    db.close();
  });

  it('keeps each node policy independent (no cross-node mutation of shared state)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-tp-imm-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-tp-imm-roles-'));
    tempDirs.push(repoPath, rolesDir);

    writeRole(
      rolesDir,
      'rd',
      'network: disabled\ndeny:\n  - tool: pnpm\n    args: [publish]\n',
    );
    writeRole(rolesDir, 'pm', 'network: disabled\n');

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
      agentProvider: 'mock',
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          captured.push(input);
          return {
            provider: 'mock',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: passthroughGateEngine(repositories),
    });

    await engine.startRun({
      demandText: '不可变守卫',
      mode: 'template',
      workflowSpec: twoNodeSpec(),
    });

    const byNode = Object.fromEntries(
      captured.map((input) => [input.roleConfig.role, input]),
    );
    const rdPolicy = byNode['rd']!.commandPolicy;
    const pmPolicy = byNode['pm']!.commandPolicy;

    // 两个节点拿到独立对象，rd 的 deny 不泄漏到 pm（无共享 mutate）。
    expect(rdPolicy).not.toBe(pmPolicy);
    expect(rdPolicy.deny).toContainEqual({
      tool: 'pnpm',
      args: ['publish'],
    });
    expect(pmPolicy.deny).toEqual([]);
    db.close();
  });

  it('fails closed when the role tools.yaml is malformed instead of falling back to a baseline', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-tp-fc-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-tp-fc-roles-'));
    tempDirs.push(repoPath, rolesDir);

    const dir = join(rolesDir, 'rd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.yaml'), 'role: rd\nname: RD\n', 'utf8');
    writeFileSync(join(dir, 'system.md'), 'RD\n', 'utf8');
    // network 取值非法，toolsConfigSchema.parse 必抛。
    writeFileSync(join(dir, 'tools.yaml'), 'network: bogus-mode\n', 'utf8');

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    let adapterCalls = 0;

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      agentProvider: 'mock',
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          adapterCalls += 1;
          return {
            provider: 'mock',
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
      demandText: '损坏角色策略 fail-closed',
      mode: 'template',
      workflowSpec: {
        id: 'tool-policy-fc',
        name: 'FC',
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
      },
    });

    // 节点失败、工作流未通过；适配器从未被调用（没有静默回落基线继续跑）。
    expect(result.workflow.status).not.toBe('passed');
    expect(adapterCalls).toBe(0);
    db.close();
  });
});
