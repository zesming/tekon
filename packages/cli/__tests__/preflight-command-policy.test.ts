import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultCommandPolicy,
  loadRepoProfile,
  type WorkflowTemplate,
} from '@tekon/core';

import { gateCommandStatus } from '../src/commands/workflow.js';
import { nodeRoleCommandPolicy } from '../src/lib/utils.js';

// 10a-2：gateCommandStatus 现要求节点角色策略。这些 PD-04 parity 用例关注
// 预检与 Gateway 同判，传入与门禁基线同源的中性角色策略以隔离角色变量；
// 角色强制另有专门用例覆盖。
type GateInput = Parameters<typeof gateCommandStatus>[2];

function preflightStatus(
  repoPath: string,
  profile: ReturnType<typeof loadRepoProfile>,
  gate: GateInput,
) {
  return gateCommandStatus(
    repoPath,
    profile,
    gate,
    defaultCommandPolicy(repoPath),
  );
}

// PD-04 M2 回归：commandRef 解析出的非基线工具（python3/make）在 preflight
// 必须与运行期 Gateway 同判——视为用户已授权，status=resolved，不得 rejected。
describe('PD-04 preflight/runtime command policy parity', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(profile: Record<string, unknown>): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-preflight-parity-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify({ version: 1, commands: profile }),
      'utf8',
    );
    return repoPath;
  }
  function gate(
    overrides: Partial<
      WorkflowTemplate['phases'][number]['nodes'][number]['gates'][number]
    > = {},
  ) {
    return {
      type: 'build' as const,
      commandRef: 'build',
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'block' as const,
      },
      ...overrides,
    };
  }

  it('resolves a commandRef pointing at a non-baseline python3 tool without rejection', () => {
    const repoPath = repoWithProfile({
      build: { tool: 'python3', args: ['build.py'] },
    });
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(repoPath, profile, gate());
    expect(result.status).toBe('resolved');
    expect(result.rejection).toBeNull();
    expect(result.commandText).toBe('python3 build.py');
  });

  it('resolves a commandRef pointing at make without rejection', () => {
    const repoPath = repoWithProfile({
      build: { tool: 'make', args: ['test'] },
    });
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(repoPath, profile, gate());
    expect(result.status).toBe('resolved');
    expect(result.rejection).toBeNull();
  });

  it('still rejects a dangerous command resolved from a commandRef', () => {
    const repoPath = repoWithProfile({
      build: { tool: 'rm', args: ['-rf', '/tmp/x'] },
    });
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(repoPath, profile, gate());
    expect(result.status).toBe('rejected');
    expect(result.rejection).toMatch(/recursive forced remove/u);
  });

  it('reports missing when the commandRef has no profile entry', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-preflight-missing-'));
    tempDirs.push(repoPath);
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(repoPath, profile, gate());
    expect(result.status).toBe('missing');
  });

  // SF-1：语义门禁运行期不执行外部命令，携带的 commandRef 是惰性引用——
  // 缺失不得报 missing（与受理期 assertNoMissingRepoCommands 同规则），
  // doctor 也不得把它计入阻断问题。
  it('does not flag a missing commandRef on a semantic human gate as missing', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-preflight-semantic-'));
    tempDirs.push(repoPath);
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(
      repoPath,
      profile,
      gate({ type: 'human', requiresHumanApproval: true }),
    );
    expect(result.status).toBe('not-command-gate');
    expect(result.rejection).toBeNull();
    expect(result.commandText).toBe('');
  });

  it('never adjudicates a command resolved for a semantic gate because the runtime never runs it', () => {
    const repoPath = repoWithProfile({
      build: { tool: 'rm', args: ['-rf', '/tmp/x'] },
    });
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(
      repoPath,
      profile,
      gate({ type: 'independent-review' }),
    );
    expect(result.status).toBe('not-command-gate');
    expect(result.rejection).toBeNull();
  });

  it('treats an inline command on a schema gate as inert rather than resolved', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-preflight-inline-'));
    tempDirs.push(repoPath);
    const profile = loadRepoProfile(repoPath);

    const result = preflightStatus(
      repoPath,
      profile,
      gate({
        type: 'schema',
        commandRef: undefined,
        command: { tool: 'npm', args: ['run', 'validate'] },
      }),
    );
    expect(result.status).toBe('not-command-gate');
    expect(result.rejection).toBeNull();
  });

  it('10a-2: surfaces role-driven human approval as a distinct preflight status', () => {
    const repoPath = repoWithProfile({});
    // 项目 rd 角色要求 make check 人工审批。
    const roleDir = join(repoPath, '.tekon', 'roles', 'rd');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'agent.yaml'), 'role: rd\nname: RD\n', 'utf8');
    writeFileSync(join(roleDir, 'system.md'), 'RD\n', 'utf8');
    writeFileSync(
      join(roleDir, 'tools.yaml'),
      [
        'requiresHumanApproval:',
        '  - tool: make',
        '    args: [check]',
        '',
      ].join('\n'),
      'utf8',
    );

    const profile = loadRepoProfile(repoPath);
    const approvedGate = gate({
      commandRef: undefined,
      command: { tool: 'make', args: ['check'] },
    });

    // 中性策略：命令放行、无审批要求。
    expect(preflightStatus(repoPath, profile, approvedGate).status).toBe(
      'resolved',
    );

    // rd 角色策略：同一命令因角色要求审批而产出独立状态。
    const rdDecision = gateCommandStatus(
      repoPath,
      profile,
      approvedGate,
      nodeRoleCommandPolicy(repoPath, 'rd'),
    );
    expect(rdDecision.status).toBe('resolved-approval-required');
    expect(rdDecision.rejection).toBeNull();
  });
});
