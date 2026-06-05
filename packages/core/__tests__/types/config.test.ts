import { describe, expect, it } from 'vitest';

import {
  agentAdapterConfigSchema,
  commandPolicySchema,
  constraintRulesSchema,
  donkeyConfigSchema,
  dynamicWorkflowSpecSchema,
  permissionProfileSchema,
  workflowTemplateSchema,
} from '../../src/index.js';

describe('runtime config schemas', () => {
  it('accepts explicit provider, permission, workflow, and constraint configuration', () => {
    expect(
      donkeyConfigSchema.parse({
        project: { name: 'donkey', repoPath: '/tmp/donkey' },
        storage: { dataDir: '.donkey' },
        defaultAgent: 'mock',
      }),
    ).toMatchObject({ defaultAgent: 'mock' });

    expect(
      agentAdapterConfigSchema.parse({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: ['/tmp/donkey'],
          network: 'disabled',
          tools: { allow: ['Read', 'Edit'], deny: ['Bash(rm *)'] },
        },
      }),
    ).toMatchObject({ provider: 'claude-code' });

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
        cwdScope: ['/tmp/donkey'],
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
  });
});
