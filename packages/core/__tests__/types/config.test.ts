import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  agentAdapterConfigSchema,
  commandPolicySchema,
  constraintRulesSchema,
  tekonConfigSchema,
  dynamicWorkflowSpecSchema,
  permissionProfileSchema,
  workflowTemplateSchema,
} from '../../src/index.js';

describe('runtime config schemas', () => {
  it('accepts explicit provider, permission, workflow, and constraint configuration', () => {
    expect(
      tekonConfigSchema.parse({
        project: { name: 'tekon', repoPath: '/tmp/tekon' },
        storage: { dataDir: '.tekon' },
        defaultAgent: 'mock',
      }),
    ).toMatchObject({ defaultAgent: 'mock' });

    expect(
      tekonConfigSchema.parse({
        project: { name: 'tekon', repoPath: '/tmp/tekon' },
        storage: { dataDir: '.tekon' },
      }),
    ).toMatchObject({ defaultAgent: 'codex' });

    expect(
      agentAdapterConfigSchema.parse({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: ['/tmp/tekon'],
          network: 'disabled',
          tools: { allow: ['Read', 'Edit'], deny: ['Bash(rm *)'] },
        },
      }),
    ).toMatchObject({
      provider: 'claude-code',
      timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
      progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
      noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    });

    expect(
      tekonConfigSchema.parse({
        project: { name: 'tekon', repoPath: '/tmp/tekon' },
        storage: { dataDir: '.tekon' },
        defaultAgent: 'codex',
      }),
    ).toMatchObject({ defaultAgent: 'codex' });

    expect(
      agentAdapterConfigSchema.parse({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        profile: 'internal',
        promptMode: 'stdin',
        outputFormat: 'text',
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: ['/tmp/tekon'],
          network: 'restricted',
          tools: { allow: ['Read', 'Edit'], deny: ['Bash(rm *)'] },
        },
      }),
    ).toMatchObject({
      provider: 'codex',
      profile: 'internal',
      timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
      progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
      noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    });

    expect(
      workflowTemplateSchema.parse({
        id: 'standard-feature',
        name: 'Standard Feature',
        nodes: [{ id: 'pm_1', role: 'pm', gates: [{ type: 'schema' }] }],
      }),
    ).toMatchObject({ id: 'standard-feature' });

    expect(
      dynamicWorkflowSpecSchema.parse({
        goal: 'Implement a CLI status command',
        requiredRoles: ['pm', 'rd', 'qa'],
        gates: [{ type: 'test', command: { tool: 'pnpm', args: ['test'] } }],
      }),
    ).toMatchObject({ requiredRoles: ['pm', 'rd', 'qa'] });

    expect(
      constraintRulesSchema.parse({
        hard: [
          { id: 'review-required', description: 'review before delivery' },
        ],
        conditional: [],
        soft: [],
      }),
    ).toMatchObject({ hard: [{ id: 'review-required' }] });
  });

  it('rejects unsafe command policy and weak permission profiles', () => {
    expect(() =>
      commandPolicySchema.parse({
        allow: [{ tool: 'rm', args: ['-rf', '/'] }],
        deny: [],
        cwdScope: ['/tmp/tekon'],
        network: 'disabled',
      }),
    ).toThrow();

    expect(() =>
      permissionProfileSchema.parse({
        sandbox: 'none',
        approval: 'never',
        filesystemScope: ['/'],
        network: 'enabled',
        tools: { allow: ['*'], deny: [] },
      }),
    ).toThrow();

    expect(() =>
      agentAdapterConfigSchema.parse({
        provider: 'codex',
        command: 'codex',
        profile: 'internal;rm',
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: ['/tmp/tekon'],
          network: 'restricted',
          tools: { allow: ['Read'], deny: [] },
        },
      }),
    ).toThrow();
  });
});
