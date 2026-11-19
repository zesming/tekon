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
} from '../../src/index.js';

// 10a-2 S3：角色 tools.yaml 的 deny 经真实 gateEngine→commandGateway 端到端
// 拒绝门禁命令（不只是纯函数级）。角色归属在节点级由 gate-runner 编译，
// rework 时合成 node 携带 targetNode.role，故同一机制覆盖返工目标节点。
describe('10a-2 role deny enforced at the real command gateway', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an inline gate command denied by the node role through gateway.run', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-role-repo-'));
    tempDirs.push(repoPath);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'tekon@example.com');
    git('config', 'user.name', 'Tekon Test');
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    git('add', '.');
    git('commit', '-m', 'init');

    // rd 角色显式拒绝 pnpm publish（非网络/非固定规则命令，归因唯一）。
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-gate-role-roles-'));
    tempDirs.push(rolesDir);
    const rdDir = join(rolesDir, 'rd');
    mkdirSync(rdDir, { recursive: true });
    writeFileSync(join(rdDir, 'agent.yaml'), 'role: rd\nname: RD\n', 'utf8');
    writeFileSync(join(rdDir, 'system.md'), 'RD\n', 'utf8');
    writeFileSync(
      join(rdDir, 'tools.yaml'),
      [
        'network: enabled',
        'allow:',
        '  - tool: pnpm',
        '    args: []',
        'deny:',
        '  - tool: pnpm',
        '    args: [publish]',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const manager = createWorktreeManager({
      repositories,
      gateway: createCommandGateway({ repositories }),
    });
    const adapter = createMockAgentAdapter();

    // 不传 gateEngine：使用引擎默认的真实 createGateEngine + commandGateway。
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter,
      agentProvider: 'mock',
      builtInRolesDir: rolesDir,
      worktreeManager: manager,
    });

    const result = await engine.startRun({
      demandText: '角色 deny 网关端到端',
      mode: 'template',
      workflowSpec: {
        id: 'gate-role-deny',
        name: 'Gate Role Deny',
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
            id: 'impl',
            name: 'Impl',
            dependsOn: [],
            nodes: [
              {
                id: 'rd-node',
                role: 'rd',
                inputs: [],
                outputs: [{ id: 'code', type: 'code-changes' as const }],
                dependsOn: [],
                gates: [
                  {
                    type: 'build' as const,
                    requiresHumanApproval: false,
                    maxRetries: 0,
                    retryPolicy: {
                      maxRetries: 0,
                      maxAttempts: 1,
                      backoffMs: 0,
                      strategy: 'fixed' as const,
                      onExhausted: 'block' as const,
                    },
                    // 内联命令；角色 deny pnpm publish，网关须拒绝。
                    command: { tool: 'pnpm', args: ['publish'] },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    // 工作流未通过；门禁结果记录为 rejected 而非命令被执行。
    expect(result.workflow.status).not.toBe('passed');
    const gateResults = await repositories.listGateResults(result.runId);
    const buildGate = gateResults.find((g) => g.gateType === 'build');
    expect(buildGate).toBeDefined();
    expect(buildGate?.status).toBe('failed');
    expect(buildGate?.failureClassification).toBe('rejected');
    db.close();
  });
});
