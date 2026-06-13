import { describe, expect, it } from 'vitest';

import {
  compileRoleToolPolicy,
  formatCommand,
} from '../../src/role/tool-policy.js';

describe('role tool policy', () => {
  it('compiles tools.yaml declarations into command policy and provider permissions consistently', () => {
    const compiled = compileRoleToolPolicy({
      repoPath: '/repo',
      role: 'pmo',
      tools: {
        network: 'restricted',
        allow: [
          { tool: 'git', args: ['status'] },
          { tool: 'gh', args: ['pr', 'create'] },
        ],
        deny: [{ tool: 'git', args: ['push', '--force'] }],
        requiresHumanApproval: [{ tool: 'git', args: ['push'] }],
      },
    });

    expect(compiled.commandPolicy).toEqual({
      allow: [
        { tool: 'git', args: ['status'] },
        { tool: 'gh', args: ['pr', 'create'] },
      ],
      deny: [{ tool: 'git', args: ['push', '--force'] }],
      requiresHumanApproval: [{ tool: 'git', args: ['push'] }],
      cwdScope: ['/repo'],
      network: 'restricted',
    });
    expect(compiled.providerPermission.tools.allow).toEqual([
      'git status',
      'gh pr create',
    ]);
    expect(compiled.providerPermission.tools.deny).toEqual([
      'git push --force',
    ]);
    expect(compiled.promptSummary).toContain('git status');
    expect(compiled.promptSummary).toContain('requires human approval');
  });

  it('falls back to safe defaults when tools config is empty or undefined', () => {
    const compiled = compileRoleToolPolicy({
      repoPath: '/repo',
      role: 'developer',
    });

    expect(compiled.commandPolicy).toEqual({
      allow: [],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: ['/repo'],
      network: 'disabled',
    });
    expect(compiled.providerPermission.tools.allow).toEqual([]);
    expect(compiled.providerPermission.tools.deny).toEqual([]);
    expect(compiled.providerPermission.network).toBe('disabled');
    expect(compiled.providerPermission.approval).toBe('on-failure');
    expect(compiled.promptSummary).toContain('network: disabled');
    expect(compiled.promptSummary).toContain('allow: none');
    expect(compiled.promptSummary).toContain('deny: none');
    expect(compiled.promptSummary).toContain('requires human approval: none');
  });

  it('resolves network policy across all three enum values', () => {
    for (const network of ['disabled', 'restricted', 'enabled'] as const) {
      const compiled = compileRoleToolPolicy({
        repoPath: '/repo',
        role: 'developer',
        tools: { network },
      });

      expect(compiled.commandPolicy.network).toBe(network);
      expect(compiled.providerPermission.network).toBe(network);
      expect(compiled.promptSummary).toContain(`network: ${network}`);
    }
  });

  it('grants on-failure approval for non-PMO roles with no requiresHumanApproval', () => {
    const compiled = compileRoleToolPolicy({
      repoPath: '/repo',
      role: 'developer',
      tools: {
        allow: [{ tool: 'npm', args: ['test'] }],
      },
    });

    expect(compiled.providerPermission.approval).toBe('on-failure');
    expect(compiled.promptSummary).toContain('requires human approval: none');
  });

  it('preserves separate allow and deny entries in both command policy and provider permission', () => {
    const compiled = compileRoleToolPolicy({
      repoPath: '/other',
      role: 'reviewer',
      tools: {
        allow: [
          { tool: 'git', args: ['log'] },
          { tool: 'git', args: ['diff'] },
        ],
        deny: [
          { tool: 'git', args: ['push'] },
          { tool: 'git', args: ['reset', '--hard'] },
        ],
      },
    });

    expect(compiled.commandPolicy.allow).toEqual([
      { tool: 'git', args: ['log'] },
      { tool: 'git', args: ['diff'] },
    ]);
    expect(compiled.commandPolicy.deny).toEqual([
      { tool: 'git', args: ['push'] },
      { tool: 'git', args: ['reset', '--hard'] },
    ]);
    expect(compiled.providerPermission.tools.allow).toEqual([
      'git log',
      'git diff',
    ]);
    expect(compiled.providerPermission.tools.deny).toEqual([
      'git push',
      'git reset --hard',
    ]);
    expect(compiled.providerPermission.approval).toBe('on-failure');
    expect(compiled.promptSummary).toContain('allow: git log, git diff');
    expect(compiled.promptSummary).toContain('deny: git push, git reset --hard');
  });

  it('formatCommand joins tool and args, trimming excess whitespace', () => {
    expect(formatCommand({ tool: 'git', args: ['status'] })).toBe('git status');
    expect(formatCommand({ tool: 'git' })).toBe('git');
    expect(formatCommand({ tool: 'git', args: [] })).toBe('git');
    expect(
      formatCommand({ tool: 'gh', args: ['pr', 'create', '--title', 'fix'] }),
    ).toBe('gh pr create --title fix');
  });
});
