import { describe, expect, it } from 'vitest';

import { assertAgentProviderCapabilities } from '../../src/index.js';

describe('agent adapter contract', () => {
  it('returns structured network evidence for the mock provider', () => {
    const mapping = assertAgentProviderCapabilities({ provider: 'mock' });

    expect(mapping.network).toEqual({
      mode: 'disabled',
      enforcement: 'declared',
      allowHosts: [],
      evidence: ['mock provider does not spawn a child process'],
    });
  });

  it('returns declared network evidence for real providers with bounded profiles', () => {
    const mapping = assertAgentProviderCapabilities({
      provider: 'claude-code',
      command: 'claude',
      promptMode: 'stdin',
      outputFormat: 'json',
      permissionProfile: {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'restricted',
        tools: { allow: ['Read', 'Edit'], deny: ['Bash(rm *)'] },
      },
    } as never);

    expect(mapping.network).toEqual({
      mode: 'restricted',
      enforcement: 'declared',
      allowHosts: [],
      evidence: ['provider permission profile declares network control'],
    });
  });

  it('rejects real providers without explicit sandbox, approval, filesystem, and tool mappings', () => {
    expect(() =>
      assertAgentProviderCapabilities({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
      } as never),
    ).toThrow(/permission profile/u);
  });

  it.each([
    {
      name: 'enabled network access',
      permissionProfile: { network: 'enabled' },
    },
    {
      name: 'danger full access sandbox',
      permissionProfile: { sandbox: 'danger-full-access' },
    },
    {
      name: 'never approval policy',
      permissionProfile: { approval: 'never' },
    },
    {
      name: 'root filesystem scope',
      permissionProfile: { filesystemScope: ['/'] },
    },
    {
      name: 'bare wildcard allow without deny rules',
      permissionProfile: { tools: { allow: ['*'], deny: [] } },
    },
  ])('rejects real providers with $name', ({ permissionProfile }) => {
    expect(() =>
      assertAgentProviderCapabilities(realProviderConfig(permissionProfile)),
    ).toThrow(/cannot prove safe provider controls/u);
  });
});

function realProviderConfig(
  permissionProfileOverrides: Record<string, unknown>,
): never {
  return {
    provider: 'claude-code',
    command: 'claude',
    promptMode: 'stdin',
    outputFormat: 'json',
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-request',
      filesystemScope: ['/tmp/repo'],
      network: 'disabled',
      tools: { allow: ['Read', 'Edit'], deny: ['Bash(rm *)'] },
      ...permissionProfileOverrides,
    },
  } as never;
}
