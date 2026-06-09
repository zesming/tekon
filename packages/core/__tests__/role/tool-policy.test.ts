import { describe, expect, it } from 'vitest';

import { compileRoleToolPolicy } from '../../src/role/tool-policy.js';

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
});
