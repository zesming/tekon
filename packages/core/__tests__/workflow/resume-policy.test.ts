import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkflowGateConfig } from '../../src/workflow/template.js';
import {
  FAIL_FAST_CLASSIFICATIONS,
  evaluateDeterministicBlock,
} from '../../src/workflow/resume-policy.js';

// PD-31：确定性失败白名单。只有 missing-command / rejected / unsupported-gate
// 且“当前条件仍成立”时才 fail-fast；条件已消失或分类不在白名单内一律返回
// null，交给常规 agent 重跑路径。
describe('PD-31 evaluateDeterministicBlock', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(yaml: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-fastfail-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(join(repoPath, '.tekon', 'repo-profile.yaml'), yaml);
    return repoPath;
  }

  function gate(
    overrides: Partial<WorkflowGateConfig> = {},
  ): WorkflowGateConfig {
    return {
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
      ...overrides,
    };
  }

  it('whitelists exactly the three deterministic classifications', () => {
    expect([...FAIL_FAST_CLASSIFICATIONS].sort()).toEqual([
      'missing-command',
      'rejected',
      'unsupported-gate',
    ]);
  });

  it('returns null for classifications outside the whitelist', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    for (const classification of [
      'exit-code',
      'invalid-artifact',
      'human-rejected',
      'changes-requested',
      'timeout',
      null,
      undefined,
    ]) {
      expect(
        evaluateDeterministicBlock({
          profileRepoPath: repoPath,
          policyCwd: repoPath,
          gate: gate(),
          classification: classification as string | null | undefined,
        }),
      ).toBeNull();
    }
  });

  it('fail-fasts missing-command while the gate still has no executable command', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate(),
      classification: 'missing-command',
    });
    expect(decision?.classification).toBe('missing-command');
    expect(decision?.reason).toContain('missing-command');
    expect(decision?.hint.length).toBeGreaterThan(0);
  });

  it('clears missing-command once a commandRef resolves from the current repo profile', () => {
    const repoPath = repoWithProfile(
      'commands:\n  build:\n    tool: git\n    args: ["--version"]\n',
    );
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ commandRef: 'build' }),
      classification: 'missing-command',
    });
    expect(decision).toBeNull();
  });

  it('keeps fail-fast when commandRef remains unresolved in the profile', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ commandRef: 'build' }),
      classification: 'missing-command',
    });
    expect(decision?.classification).toBe('missing-command');
  });

  it('points a materialized frozen gate (no commandRef) at --rebind instead of a dead profile hint', () => {
    const repoPath = repoWithProfile(
      'commands:\n  build:\n    tool: git\n    args: ["--version"]\n',
    );
    // v3 受理后门禁已物化、commandRef 被删除；即使 profile 现在补全了命令，
    // 冻结绑定也不会重读，提示必须指向 --rebind 而不是“补全 profile”。
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate(),
      classification: 'missing-command',
    });
    expect(decision?.classification).toBe('missing-command');
    expect(decision?.hint).toContain('--rebind');
  });

  it('does not fail-fast an explicitly not-applicable command gate', () => {
    const repoPath = repoWithProfile(
      'commands:\n  build:\n    notApplicable: true\n    reason: no build step\n',
    );
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ commandRef: 'build' }),
      classification: 'missing-command',
    });
    expect(decision).toBeNull();
  });

  it('fail-fasts rejected while the current policy still denies the command', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({
        command: { tool: 'rm', args: ['-rf', '/tmp/danger'] },
      }),
      classification: 'rejected',
    });
    // rm -rf 命中固定拒绝规则；重跑 agent 不会改变裁决。
    expect(decision?.classification).toBe('rejected');
    expect(decision?.reason).toContain('rejected');
  });

  it('clears rejected when the current policy now allows the command', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ command: { tool: 'git', args: ['--version'] } }),
      classification: 'rejected',
    });
    // gate 自身命令进入授权，且不触固定拒绝规则。
    expect(decision).toBeNull();
  });

  it('fail-fasts unsupported-gate for an unknown gate type', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ type: 'made-up-gate' as WorkflowGateConfig['type'] }),
      classification: 'unsupported-gate',
    });
    expect(decision?.classification).toBe('unsupported-gate');
    expect(decision?.reason).toContain('made-up-gate');
  });

  it('clears unsupported-gate when the gate type is actually supported', () => {
    const repoPath = repoWithProfile('commands: {}\n');
    const decision = evaluateDeterministicBlock({
      profileRepoPath: repoPath,
      policyCwd: repoPath,
      gate: gate({ type: 'schema', artifactType: 'prd' }),
      classification: 'unsupported-gate',
    });
    expect(decision).toBeNull();
  });
});
