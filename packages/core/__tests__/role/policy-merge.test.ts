import { resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateCommandPolicy } from '../../src/runtime/command-gateway.js';
import type { CommandPolicy } from '../../src/types/config.js';
import {
  mergeCwdScope,
  mergeRoleAndGatePolicy,
} from '../../src/role/policy-merge.js';

function policy(overrides: Partial<CommandPolicy>): CommandPolicy {
  return {
    allow: [],
    deny: [],
    requiresHumanApproval: [],
    cwdScope: ['/repo'],
    network: 'disabled',
    ...overrides,
  };
}

const gitStatus = { tool: 'git', args: ['status'] };
const gitPush = { tool: 'git', args: ['push'] };
const pnpmPublish = { tool: 'pnpm', args: ['publish'] };
const makeCheck = { tool: 'make', args: ['check'] };

describe('mergeRoleAndGatePolicy (10a-2 candidate A)', () => {
  it('unions deny so a role deny cannot be overridden by gate authorization', () => {
    const role = policy({ deny: [pnpmPublish], allow: [{ tool: 'pnpm' }] });
    const gate = policy({ allow: [pnpmPublish, gitStatus] });

    const merged = mergeRoleAndGatePolicy(role, gate, '/repo');

    expect(merged.deny).toContainEqual(pnpmPublish);
    expect(merged.allow).toContainEqual(pnpmPublish);
    // deny 与 allow 可同时存在；裁决层固定顺序先查 deny，故仍 fail-closed。
  });

  it('unions requiresHumanApproval from both sides', () => {
    const role = policy({ requiresHumanApproval: [gitPush] });
    const gate = policy({ requiresHumanApproval: [makeCheck] });

    const merged = mergeRoleAndGatePolicy(role, gate, '/repo');

    expect(merged.requiresHumanApproval).toEqual(
      expect.arrayContaining([gitPush, makeCheck]),
    );
  });

  it('unions allow so PD-04 hand-written gate commands keep running under the role', () => {
    // rd 角色只枚举 pnpm，但门禁经 repo-profile 绑定了 make check。
    const role = policy({ allow: [{ tool: 'pnpm', args: [] }] });
    const gate = policy({ allow: [gitStatus, makeCheck] });

    const merged = mergeRoleAndGatePolicy(role, gate, '/repo');

    expect(merged.allow).toEqual(
      expect.arrayContaining([
        { tool: 'pnpm', args: [] },
        makeCheck,
        gitStatus,
      ]),
    );
  });

  it('picks the strictest network across the full 3x3 matrix (never relaxes)', () => {
    const levels = ['disabled', 'restricted', 'enabled'] as const;
    const rank = { disabled: 0, restricted: 1, enabled: 2 } as const;
    for (const roleNetwork of levels) {
      for (const gateNetwork of levels) {
        const merged = mergeRoleAndGatePolicy(
          policy({ network: roleNetwork }),
          policy({ network: gateNetwork }),
          '/repo',
        );
        const expected =
          rank[roleNetwork] <= rank[gateNetwork] ? roleNetwork : gateNetwork;
        expect(merged.network).toBe(expected);
      }
    }
  });

  it('explicitly covers the reverse case: role enabled cannot relax a disabled baseline', () => {
    const merged = mergeRoleAndGatePolicy(
      policy({ network: 'enabled' }),
      policy({ network: 'disabled' }),
      '/repo',
    );
    expect(merged.network).toBe('disabled');
  });
});

describe('mergeCwdScope semantic containment', () => {
  const repo = resolve('/repo');
  const worktree = resolve('/repo/.tekon/worktrees/run1/w1');

  it('P5 typical: role main-repo scope x gate worktree scope resolves to the narrowest worktree scope', () => {
    const merged = mergeCwdScope([repo], [worktree], worktree);
    expect(merged).toEqual([worktree]);
  });

  it('P3 typical: identical repo scopes resolve to that single scope', () => {
    const merged = mergeCwdScope([repo], [repo], repo);
    expect(merged).toEqual([repo]);
  });

  it('fails closed when no scope can contain the execution cwd', () => {
    expect(() =>
      mergeCwdScope([repo], [resolve('/repo/sub')], resolve('/elsewhere/x')),
    ).toThrow(/cwd|scope|工作目录|范围/u);
  });

  it('never lets a prefix-sibling scope contain a cwd outside it (separator boundary)', () => {
    const evil = resolve('/repo-evil');
    // /repo-evil 不得 containment 住 /repo/x。
    expect(() => mergeCwdScope([evil], [evil], resolve('/repo/x'))).toThrow();
  });

  it('always returns a non-empty single-element scope array', () => {
    const merged = mergeRoleAndGatePolicy(
      policy({ cwdScope: [repo] }),
      policy({ cwdScope: [worktree] }),
      worktree,
    );
    expect(merged.cwdScope).toHaveLength(1);
    expect(merged.cwdScope[0]?.length).toBeGreaterThan(0);
    expect(sep).toBeTruthy();
  });
});

describe('10a-2 attribution: role constraints actually enforce at the gateway', () => {
  const cwd = resolve('/repo');

  it('rejects a gate-authorized command only after the role deny is merged (not before)', () => {
    // pnpm publish 不在 isKnownNetworkCommand 清单，也不触固定拒绝规则——
    // 唯一能拒绝它的是角色 deny。用于证明强制力来自角色合并。
    const command = pnpmPublish;
    const gate = policy({
      network: 'enabled',
      allow: [command, gitStatus],
      cwdScope: [cwd],
    });
    const role = policy({
      network: 'enabled',
      deny: [command],
      cwdScope: [cwd],
    });

    // 仅门禁策略：命令在 allow 内、无固定规则命中，放行。
    expect(evaluateCommandPolicy(command, gate, cwd)).toBeNull();
    // 合并角色后：deny 生效，fail-closed 拒绝。
    const merged = mergeRoleAndGatePolicy(role, gate, cwd);
    expect(evaluateCommandPolicy(command, merged, cwd)).toMatch(/deny/u);
  });

  it('role network disabled rejects a network command even when the gate policy would enable it', () => {
    const curl = { tool: 'curl', args: ['https://example.invalid'] };
    const gate = policy({
      network: 'enabled',
      allow: [curl],
      cwdScope: [cwd],
    });
    const role = policy({ network: 'disabled', cwdScope: [cwd] });

    expect(evaluateCommandPolicy(curl, gate, cwd)).toBeNull();
    const merged = mergeRoleAndGatePolicy(role, gate, cwd);
    expect(evaluateCommandPolicy(curl, merged, cwd)).toMatch(/network/u);
  });

  it('keeps a PD-04 hand-written non-enum command runnable under a role that does not list it', () => {
    // qa 角色 allow 仅 pnpm/npm，但门禁绑定 make test；候选 A 并集须放行。
    const makeTest = { tool: 'make', args: ['test'] };
    const gate = policy({ allow: [makeTest], cwdScope: [cwd] });
    const qaRole = policy({
      allow: [
        { tool: 'pnpm', args: [] },
        { tool: 'npm', args: [] },
      ],
      cwdScope: [cwd],
    });
    const merged = mergeRoleAndGatePolicy(qaRole, gate, cwd);
    expect(evaluateCommandPolicy(makeTest, merged, cwd)).toBeNull();
  });

  it('still applies fixed dangerous-remove rules first regardless of role allow', () => {
    const dangerous = { tool: 'rm', args: ['-rf', '/tmp/x'] };
    const gate = policy({ allow: [dangerous], cwdScope: [cwd] });
    const role = policy({
      allow: [dangerous],
      cwdScope: [cwd],
    });
    const merged = mergeRoleAndGatePolicy(role, gate, cwd);
    expect(evaluateCommandPolicy(dangerous, merged, cwd)).toMatch(/remove/u);
  });
});
