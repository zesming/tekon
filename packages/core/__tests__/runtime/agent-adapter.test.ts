import { describe, expect, it } from 'vitest';

import { assertAgentProviderCapabilities } from '../../src/index.js';

describe('agent adapter contract', () => {
  it('rejects real providers without explicit sandbox, approval, filesystem, and tool mappings', () => {
    expect(() =>
      assertAgentProviderCapabilities({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
      } as never),
    ).toThrow(/permission profile/u);

    expect(() =>
      assertAgentProviderCapabilities({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
        permissionProfile: {
          sandbox: 'danger-full-access',
          approval: 'never',
          filesystemScope: ['/tmp/repo'],
          network: 'enabled',
          tools: { allow: ['*'], deny: [] },
        },
      } as never),
    ).toThrow(/cannot prove safe provider controls/u);
  });
});
