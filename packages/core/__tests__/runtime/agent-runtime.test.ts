import { describe, expect, it } from 'vitest';

import {
  applyProviderRuntimeOverrides,
  createAgentAdapterFromSnapshot,
  createAgentRuntime,
  defaultProviderConfig,
  summarizeAgentConfig,
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  type AgentAdapterConfig,
  type CommandGateway,
  type RunProviderConfig,
} from '../../src/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

const stubGateway: CommandGateway = {
  async run() {
    return {
      status: 'executed' as const,
      exitCode: 0,
      durationMs: 0,
      stdout: '',
      stderr: '',
      outputFiles: [],
      commands: [],
    };
  },
};

function makeSnapshot(
  overrides: Partial<RunProviderConfig> & { provider: RunProviderConfig['provider'] },
): RunProviderConfig {
  return {
    runId: 'test-run-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    configSummary: {},
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('createAgentRuntime', () => {
  it('creates a mock adapter', () => {
    const result = createAgentRuntime({
      agent: 'mock',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
    });
    expect(result.provider).toBe('mock');
    expect(result.configSummary).toEqual({ provider: 'mock' });
    expect(result.adapter).toBeDefined();
    expect(typeof result.adapter.runAgent).toBe('function');
  });

  it('creates a claude-code adapter with default approval', () => {
    const result = createAgentRuntime({
      agent: 'claude-code',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
    });
    expect(result.provider).toBe('claude-code');
    expect(result.configSummary.provider).toBe('claude-code');
    expect(
      (result.configSummary.permissionProfile as { approval: string }).approval,
    ).toBe('on-failure');
  });

  it('creates a codex adapter with default approval', () => {
    const result = createAgentRuntime({
      agent: 'codex',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
    });
    expect(result.provider).toBe('codex');
    expect(result.configSummary.provider).toBe('codex');
    expect(
      (result.configSummary.permissionProfile as { approval: string }).approval,
    ).toBe('on-failure');
  });

  it('applies approvalDefault: on-request for web-style usage', () => {
    const result = createAgentRuntime({
      agent: 'claude-code',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
      approvalDefault: 'on-request',
    });
    expect(
      (result.configSummary.permissionProfile as { approval: string }).approval,
    ).toBe('on-request');
  });

  it('rejects approval: never at adapter capability check', () => {
    // 'never' is in the Zod schema but rejected by adapter capability assertion
    expect(() =>
      createAgentRuntime({
        agent: 'claude-code',
        repoPath: '/tmp/repo',
        gateway: stubGateway,
        approvalDefault: 'never' as 'on-failure',
      }),
    ).toThrow(/cannot prove safe provider controls/);
  });

  it('applies approvalDefault: on-request for codex', () => {
    const result = createAgentRuntime({
      agent: 'codex',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
      approvalDefault: 'on-request',
    });
    expect(
      (result.configSummary.permissionProfile as { approval: string }).approval,
    ).toBe('on-request');
  });

  it('applies runtime overrides', () => {
    const result = createAgentRuntime({
      agent: 'claude-code',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
      runtime: { timeoutMs: 42_000 },
    });
    expect(result.configSummary.timeoutMs).toBe(42_000);
    // Non-overridden values remain at defaults
    expect(result.configSummary.progressHeartbeatMs).toBe(
      DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    );
  });

  it('throws for unsupported agent types', () => {
    expect(() =>
      createAgentRuntime({
        agent: 'unknown-agent',
        repoPath: '/tmp/repo',
        gateway: stubGateway,
      }),
    ).toThrow(/Unsupported agent/);
  });
});

describe('defaultProviderConfig', () => {
  it('returns claude-code config with on-failure approval by default', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    expect(config.provider).toBe('claude-code');
    expect(config.command).toBe('claude');
    expect(config.args).toEqual(['-p']);
    expect(config.promptMode).toBe('stdin');
    expect(config.outputFormat).toBe('json');
    expect(config.timeoutMs).toBe(DEFAULT_REAL_PROVIDER_TIMEOUT_MS);
    expect(config.progressHeartbeatMs).toBe(DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS);
    expect(config.noProgressTimeoutMs).toBe(DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS);
    expect(config.permissionProfile.approval).toBe('on-failure');
    expect(config.permissionProfile.filesystemScope).toEqual(['/tmp/repo']);
  });

  it('returns codex config with on-failure approval by default', () => {
    const config = defaultProviderConfig('codex', '/tmp/repo');
    expect(config.provider).toBe('codex');
    expect(config.command).toBe('codex');
    expect(config.profile).toBe('internal');
    expect(config.outputFormat).toBe('text');
    expect(config.permissionProfile.approval).toBe('on-failure');
  });

  it('respects custom approvalDefault', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo', {
      approvalDefault: 'on-request',
    });
    expect(config.permissionProfile.approval).toBe('on-request');
  });

  it('includes the repoPath in filesystemScope', () => {
    const config = defaultProviderConfig('codex', '/my/project');
    expect(config.permissionProfile.filesystemScope).toEqual(['/my/project']);
  });

  it('throws for mock agent (mock has no config)', () => {
    expect(() =>
      defaultProviderConfig('mock', '/tmp/repo'),
    ).toThrow(/only supports claude-code and codex/);
  });
});

describe('applyProviderRuntimeOverrides', () => {
  const baseConfig = defaultProviderConfig('claude-code', '/tmp/repo');

  it('preserves base values when no overrides provided', () => {
    const result = applyProviderRuntimeOverrides(baseConfig);
    expect(result.timeoutMs).toBe(baseConfig.timeoutMs);
    expect(result.progressHeartbeatMs).toBe(baseConfig.progressHeartbeatMs);
    expect(result.noProgressTimeoutMs).toBe(baseConfig.noProgressTimeoutMs);
  });

  it('preserves base values when empty overrides provided', () => {
    const result = applyProviderRuntimeOverrides(baseConfig, {});
    expect(result.timeoutMs).toBe(baseConfig.timeoutMs);
  });

  it('overrides timeoutMs', () => {
    const result = applyProviderRuntimeOverrides(baseConfig, {
      timeoutMs: 99_000,
    });
    expect(result.timeoutMs).toBe(99_000);
    expect(result.progressHeartbeatMs).toBe(baseConfig.progressHeartbeatMs);
  });

  it('overrides all three fields simultaneously', () => {
    const result = applyProviderRuntimeOverrides(baseConfig, {
      timeoutMs: 10_000,
      progressHeartbeatMs: 5_000,
      noProgressTimeoutMs: 3_000,
    });
    expect(result.timeoutMs).toBe(10_000);
    expect(result.progressHeartbeatMs).toBe(5_000);
    expect(result.noProgressTimeoutMs).toBe(3_000);
  });

  it('does not mutate the base config', () => {
    const original = { ...baseConfig };
    applyProviderRuntimeOverrides(baseConfig, { timeoutMs: 1 });
    expect(baseConfig.timeoutMs).toBe(original.timeoutMs);
  });
});

describe('summarizeAgentConfig', () => {
  it('serializes a claude-code config to a plain record', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    const summary = summarizeAgentConfig(config);

    expect(summary.provider).toBe('claude-code');
    expect(summary.command).toBe('claude');
    expect(summary.args).toEqual(['-p']);
    expect(summary.promptMode).toBe('stdin');
    expect(summary.outputFormat).toBe('json');
    expect(summary.timeoutMs).toBe(DEFAULT_REAL_PROVIDER_TIMEOUT_MS);
    expect(summary.progressHeartbeatMs).toBe(DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS);
    expect(summary.noProgressTimeoutMs).toBe(DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS);

    const profile = summary.permissionProfile as Record<string, unknown>;
    expect(profile.sandbox).toBe('workspace-write');
    expect(profile.approval).toBe('on-failure');
    expect(profile.filesystemScope).toEqual(['/tmp/repo']);
    expect(profile.network).toBe('restricted');
    expect(profile.tools).toEqual({
      allow: ['git', 'npm', 'pnpm'],
      deny: ['rm', 'sudo', 'git push --force'],
    });
  });

  it('serializes a codex config with profile field', () => {
    const config = defaultProviderConfig('codex', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    expect(summary.provider).toBe('codex');
    expect(summary.profile).toBe('internal');
  });

  it('includes undefined optional fields as undefined', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    // claude-code has no profile
    expect(summary.profile).toBeUndefined();
  });
});

describe('createAgentAdapterFromSnapshot', () => {
  it('restores a mock adapter from snapshot', () => {
    const snapshot = makeSnapshot({
      provider: 'mock',
      configSummary: { provider: 'mock' },
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot,
      gateway: stubGateway,
    });
    expect(result.provider).toBe('mock');
    expect(result.adapter).toBeDefined();
  });

  it('restores a claude-code adapter from a valid snapshot', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    const snapshot = makeSnapshot({
      provider: 'claude-code',
      configSummary: summary,
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot,
      gateway: stubGateway,
    });
    expect(result.provider).toBe('claude-code');
    expect(result.adapter).toBeDefined();
    expect(result.configSummary.provider).toBe('claude-code');
  });

  it('restores a codex adapter from a valid snapshot', () => {
    const config = defaultProviderConfig('codex', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    const snapshot = makeSnapshot({
      provider: 'codex',
      configSummary: summary,
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot,
      gateway: stubGateway,
    });
    expect(result.provider).toBe('codex');
    expect(result.adapter).toBeDefined();
  });

  it('applies runtime overrides when restoring from snapshot', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    const snapshot = makeSnapshot({
      provider: 'claude-code',
      configSummary: summary,
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot,
      gateway: stubGateway,
      runtime: { timeoutMs: 12_345 },
    });
    expect(result.configSummary.timeoutMs).toBe(12_345);
  });

  it('applies runtime overrides when restoring a codex snapshot', () => {
    const config = defaultProviderConfig('codex', '/tmp/repo');
    const summary = summarizeAgentConfig(config);
    const snapshot = makeSnapshot({
      provider: 'codex',
      configSummary: summary,
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot,
      gateway: stubGateway,
      runtime: {
        timeoutMs: 55_000,
        progressHeartbeatMs: 10_000,
      },
    });
    expect(result.configSummary.timeoutMs).toBe(55_000);
    expect(result.configSummary.progressHeartbeatMs).toBe(10_000);
    // Non-overridden value preserved from snapshot
    expect(result.configSummary.noProgressTimeoutMs).toBe(
      DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    );
  });

  it('throws for a corrupted claude-code snapshot', () => {
    const snapshot = makeSnapshot({
      provider: 'claude-code',
      configSummary: { provider: 'codex' },
    });
    expect(() =>
      createAgentAdapterFromSnapshot({
        snapshot,
        gateway: stubGateway,
      }),
    ).toThrow(/non-replayable claude-code/);
  });

  it('throws for a corrupted codex snapshot', () => {
    const snapshot = makeSnapshot({
      provider: 'codex',
      configSummary: { provider: 'claude-code' },
    });
    expect(() =>
      createAgentAdapterFromSnapshot({
        snapshot,
        gateway: stubGateway,
      }),
    ).toThrow(/non-replayable codex/);
  });

  it('throws for custom provider snapshots', () => {
    const snapshot = makeSnapshot({
      provider: 'custom',
      configSummary: { provider: 'custom' },
    });
    expect(() =>
      createAgentAdapterFromSnapshot({
        snapshot,
        gateway: stubGateway,
      }),
    ).toThrow(/Custom agent provider/);
  });

  it('throws for empty config summary', () => {
    const snapshot = makeSnapshot({
      provider: 'claude-code',
      configSummary: {},
    });
    expect(() =>
      createAgentAdapterFromSnapshot({
        snapshot,
        gateway: stubGateway,
      }),
    ).toThrow(/non-replayable/);
  });
});
