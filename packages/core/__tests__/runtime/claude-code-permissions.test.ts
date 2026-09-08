import { describe, expect, it } from 'vitest';

import {
  defaultCommandPolicy,
  defaultProviderConfig,
} from '../../src/index.js';
import { compileClaudePermissions } from '../../src/runtime/claude-code-permissions.js';

describe('Claude Code permission compiler', () => {
  it('compiles the real default provider and command policy into bounded grants', () => {
    const repoPath = '/tmp/repo';
    const config = defaultProviderConfig('claude-code', repoPath, {
      approvalDefault: 'on-request',
    });
    const policy = defaultCommandPolicy(repoPath);

    const permissions = compileClaudePermissions(
      config.permissionProfile,
      policy,
    );

    const expectedAllow = [
      'Bash(npm test)',
      'Bash(npm run test)',
      'Bash(npm run build)',
      'Bash(npm run lint)',
      'Bash(npm run typecheck)',
      'Bash(pnpm test)',
      'Bash(pnpm run test)',
      'Bash(pnpm build)',
      'Bash(pnpm run build)',
      'Bash(pnpm lint)',
      'Bash(pnpm run lint)',
      'Bash(pnpm typecheck)',
      'Bash(pnpm run typecheck)',
      'Bash(git status)',
      'Bash(git diff)',
      'Bash(git log)',
    ];
    expect(permissions.allow).toHaveLength(expectedAllow.length);
    expect(new Set(permissions.allow)).toEqual(new Set(expectedAllow));
    expect(permissions.deny).toContain('Bash(rm *)');
  });

  it('does not add npm or Bash grants when either capability source is empty', () => {
    const repoPath = '/tmp/repo';
    const config = defaultProviderConfig('claude-code', repoPath);
    const policy = defaultCommandPolicy(repoPath);

    const emptyProfile = {
      ...config.permissionProfile,
      tools: { allow: [], deny: config.permissionProfile.tools.deny },
    };
    const noProfileNpm = compileClaudePermissions(emptyProfile, policy);
    expect(noProfileNpm.allow).not.toContain('Bash(npm test)');
    expect(noProfileNpm.allow).not.toContain('Bash(git status)');
    expect(noProfileNpm.allow).toEqual([]);

    const noPolicyNpm = compileClaudePermissions(config.permissionProfile, {
      ...policy,
      allow: [],
    });
    expect(noPolicyNpm.allow).not.toContain('Bash(npm test)');
    expect(noPolicyNpm.allow).not.toContain('Bash(git status)');
    expect(noPolicyNpm.allow).toEqual([]);
  });

  it('uses native Bash patterns only as candidate caps and never grants them directly', () => {
    const permissions = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['Bash(git *)'],
          deny: [],
        },
      },
      {
        ...defaultCommandPolicy('/tmp/repo'),
        allow: [{ tool: 'git', args: [] }],
      },
    );

    expect(permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(git status)',
        'Bash(git diff)',
        'Bash(git log)',
      ]),
    );
    expect(permissions.allow).not.toContain('Bash(git *)');
  });

  it('does not treat structured Bash or native Bash(Bash *) as a command alias', () => {
    const structuredBash = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['git', 'npm', 'pnpm'],
          deny: [],
        },
      },
      {
        ...defaultCommandPolicy('/tmp/repo'),
        allow: [{ tool: 'Bash', args: [] }],
      },
    );
    expect(structuredBash.allow).toEqual([]);

    const nativeBash = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: { allow: ['Bash(Bash *)'], deny: [] },
      },
      defaultCommandPolicy('/tmp/repo'),
    );
    expect(nativeBash.allow).toEqual([]);
  });

  it('preserves scoped native deny rules without converting them to Bash', () => {
    const permissions = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['npm'],
          deny: ['Read(./.env)', 'WebFetch(domain:example.com)'],
        },
      },
      defaultCommandPolicy('/tmp/repo'),
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Read(./.env)',
        'WebFetch(domain:example.com)',
      ]),
    );
  });

  it('preserves native Agent and MCP deny rules verbatim', () => {
    const permissions = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['npm'],
          deny: ['Agent', 'mcp__server__*'],
        },
      },
      defaultCommandPolicy('/tmp/repo'),
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining(['Agent', 'mcp__server__*']),
    );
  });

  it('keeps exact deny and human approval rules separate from grants', () => {
    const permissions = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['npm', 'git'],
          deny: [],
        },
      },
      {
        ...defaultCommandPolicy('/tmp/repo'),
        allow: [
          { tool: 'npm', args: [] },
          { tool: 'git', args: [] },
        ],
        deny: [
          { tool: 'npm', args: ['run', 'build'], match: 'exact' },
        ],
        requiresHumanApproval: [
          { tool: 'git', args: ['status'], match: 'exact' },
        ],
      },
    );

    expect(permissions.deny).toContain('Bash(npm run build)');
    expect(permissions.deny).not.toContain('Bash(npm run build *)');
    expect(permissions.ask).toContain('Bash(git status)');
    expect(permissions.allow).not.toContain('Bash(npm run build)');
    expect(permissions.allow).not.toContain('Bash(git status)');
  });

  it('preserves prefix deny and approval semantics without widening or narrowing them', () => {
    const permissions = compileClaudePermissions(
      {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'disabled',
        tools: {
          allow: ['npm', 'git'],
          deny: [],
        },
      },
      {
        ...defaultCommandPolicy('/tmp/repo'),
        allow: [
          { tool: 'npm', args: [] },
          { tool: 'git', args: [] },
        ],
        deny: [{ tool: 'npm', args: ['run'] }],
        requiresHumanApproval: [{ tool: 'git', args: [] }],
      },
    );

    expect(permissions.deny).toContain('Bash(npm run *)');
    expect(permissions.ask).toContain('Bash(git *)');
    expect(permissions.allow).toContain('Bash(npm test)');
    expect(permissions.allow).not.toContain('Bash(npm run build)');
    expect(permissions.allow).not.toContain('Bash(git status)');
  });

  it('refuses rules that cannot be serialized as a single safe Claude argv token', () => {
    expect(() =>
      compileClaudePermissions(
        {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: ['/tmp/repo'],
          network: 'disabled',
          tools: { allow: ['npm'], deny: [] },
        },
        {
          ...defaultCommandPolicy('/tmp/repo'),
          deny: [
            {
              tool: 'npm',
              args: ['run', 'build && echo compromised'],
              match: 'exact',
            },
          ],
        },
      ),
    ).toThrow(/safe|shell|serial/u);
  });
});
