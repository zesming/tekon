import { describe, expect, it } from 'vitest';

import {
  createBuiltInProviderRegistry,
  createAgentRuntime,
  createAgentAdapterFromSnapshot,
  ProviderSnapshotVersionError,
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
  overrides: Partial<RunProviderConfig> & {
    provider: RunProviderConfig['provider'];
  },
): RunProviderConfig {
  return {
    runId: 'test-run-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    configSummary: {},
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('provider registry (S1)', () => {
  it('registers the three built-in providers', () => {
    const registry = createBuiltInProviderRegistry();
    expect(registry.has('mock')).toBe(true);
    expect(registry.has('claude-code')).toBe(true);
    expect(registry.has('codex')).toBe(true);
    expect(registry.list().map((d) => d.name).sort()).toEqual([
      'claude-code',
      'codex',
      'mock',
    ]);
  });

  it('returns undefined / false for unknown providers', () => {
    const registry = createBuiltInProviderRegistry();
    expect(registry.get('gpt-9')).toBeUndefined();
    expect(registry.has('gpt-9')).toBe(false);
  });

  it('each definition exposes a positive snapshotVersion (S2)', () => {
    const registry = createBuiltInProviderRegistry();
    for (const def of registry.list()) {
      expect(def.snapshotVersion).toBeGreaterThanOrEqual(1);
    }
  });

  // R4 / evaluate-S1: the capability guard lives inside the adapter factories
  // (codex-adapter / claude-code-adapter), which each definition MUST route
  // through. A dangerous persisted profile must therefore be rejected on
  // restore() for real providers — proving registry-ization did not bypass
  // assertAgentProviderCapabilities.
  it('restore() rejects a dangerous approval:never profile for real providers', () => {
    const registry = createBuiltInProviderRegistry();
    for (const provider of ['claude-code', 'codex'] as const) {
      const def = registry.get(provider)!;
      const dangerous = makeSnapshot({
        provider,
        configSummary: {
          provider,
          command: provider === 'codex' ? 'codex' : 'claude',
          args: [],
          promptMode: 'stdin',
          outputFormat: provider === 'codex' ? 'text' : 'json',
          timeoutMs: 1000,
          progressHeartbeatMs: 1000,
          noProgressTimeoutMs: 1000,
          permissionProfile: {
            sandbox: 'danger-full-access',
            approval: 'never',
            filesystemScope: ['/tmp/repo'],
            network: 'all',
            tools: { allow: [], deny: [] },
          },
        },
      });
      expect(() => def.restore({ snapshot: dangerous, gateway: stubGateway })).toThrow();
    }
  });
});

// The public factories must delegate to the registry with IDENTICAL behavior
// (regression lock: CLI + Web construction paths unchanged).
describe('factory ↔ registry equivalence (S1 regression)', () => {
  it('createAgentRuntime(mock) matches registry.get(mock).create', () => {
    const viaFactory = createAgentRuntime({
      agent: 'mock',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
    });
    const viaRegistry = createBuiltInProviderRegistry()
      .get('mock')!
      .create({ agent: 'mock', repoPath: '/tmp/repo', gateway: stubGateway });
    expect(viaFactory.provider).toBe(viaRegistry.provider);
    expect(viaFactory.configSummary).toEqual(viaRegistry.configSummary);
  });

  it('createAgentAdapterFromSnapshot(mock) still round-trips', () => {
    const result = createAgentAdapterFromSnapshot({
      snapshot: makeSnapshot({ provider: 'mock', configSummary: { provider: 'mock' } }),
      gateway: stubGateway,
    });
    expect(result.provider).toBe('mock');
  });

  it('createAgentRuntime throws for unsupported agent types (unchanged)', () => {
    expect(() =>
      createAgentRuntime({
        agent: 'gpt-9',
        repoPath: '/tmp/repo',
        gateway: stubGateway,
      }),
    ).toThrow(/Unsupported agent/);
  });
});

describe('provider snapshot version contract (S2)', () => {
  it('create() stamps schemaVersion into the persisted summary', () => {
    const result = createAgentRuntime({
      agent: 'claude-code',
      repoPath: '/tmp/repo',
      gateway: stubGateway,
    });
    expect(result.configSummary.schemaVersion).toBe(1);
  });

  it('restore() accepts a snapshot missing schemaVersion (treated as v1)', () => {
    // Older snapshots persisted before S2 have no schemaVersion key.
    const legacy = makeSnapshot({
      provider: 'claude-code',
      configSummary: {
        provider: 'claude-code',
        command: 'claude',
        args: ['-p'],
        promptMode: 'stdin',
        outputFormat: 'json',
        timeoutMs: 1000,
        progressHeartbeatMs: 1000,
        noProgressTimeoutMs: 1000,
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-failure',
          filesystemScope: ['/tmp/repo'],
          network: 'restricted',
          tools: { allow: ['git'], deny: ['rm'] },
        },
        // NB: no schemaVersion
      },
    });
    const result = createAgentAdapterFromSnapshot({
      snapshot: legacy,
      gateway: stubGateway,
    });
    expect(result.provider).toBe('claude-code');
    expect(result.configSummary.schemaVersion).toBe(1);
  });

  it('restore() rejects a snapshot with a higher schemaVersion', () => {
    const future = makeSnapshot({
      provider: 'codex',
      configSummary: {
        provider: 'codex',
        command: 'codex',
        args: [],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 1000,
        progressHeartbeatMs: 1000,
        noProgressTimeoutMs: 1000,
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-failure',
          filesystemScope: ['/tmp/repo'],
          network: 'restricted',
          tools: { allow: ['git'], deny: ['rm'] },
        },
        schemaVersion: 999,
      },
    });
    expect(() =>
      createAgentAdapterFromSnapshot({ snapshot: future, gateway: stubGateway }),
    ).toThrow(ProviderSnapshotVersionError);
  });
});
