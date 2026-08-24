import { createClaudeCodeAdapter } from './claude-code-adapter.js';
import { createCodexAdapter } from './codex-adapter.js';
import { createMockAgentAdapter } from './mock-agent-adapter.js';
import { agentAdapterConfigSchema } from '../types/config.js';
import type {
  AgentRuntimeConfig,
  AgentRuntimeResult,
  AgentSnapshotInput,
} from './agent-runtime.js';
import {
  applyProviderRuntimeOverrides,
  defaultProviderConfig,
  summarizeAgentConfig,
} from './agent-runtime.js';

// ---------------------------------------------------------------------------
// Provider registry (phase 2 S1). Mirrors the gate registry pattern
// (gate/registry.ts): each provider is a self-contained definition that owns
// its create()/restore() logic and declares a snapshot schema version. The
// public factories (createAgentRuntime / createAgentAdapterFromSnapshot) now
// delegate here, replacing the two duplicated if/else chains. The capability
// guard assertAgentProviderCapabilities still runs inside each adapter factory
// (codex-adapter.ts / claude-code-adapter.ts) — the registry does NOT bypass it.
// ---------------------------------------------------------------------------

/**
 * Raised when a persisted provider snapshot's schemaVersion is higher than the
 * current definition supports — the run cannot be safely replayed on this
 * build (phase 2 S2). Mapped to CLI exit 1 / web 400 on the sync resume path;
 * on the background job path it surfaces as a failed job.
 */
export class ProviderSnapshotVersionError extends Error {
  constructor(
    readonly provider: string,
    readonly snapshotVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Run provider snapshot for '${provider}' is version ${snapshotVersion}, ` +
        `but this build supports up to version ${supportedVersion}; ` +
        `it cannot be safely replayed.`,
    );
    this.name = 'ProviderSnapshotVersionError';
  }
}

export interface ProviderDefinition {
  /** Provider name (matches RunProviderConfig.provider). */
  name: 'mock' | 'claude-code' | 'codex';
  /**
   * Current snapshot schema version. Bump when `summarizeAgentConfig`'s shape
   * changes in a way older code cannot parse. Persisted snapshots default to 1
   * (S2): missing → treated as v1; higher than this → ProviderSnapshotVersionError.
   */
  snapshotVersion: number;
  /** Build a fresh adapter from a high-level config (CLI/Web start path). */
  create(config: AgentRuntimeConfig): AgentRuntimeResult;
  /** Reconstruct an adapter from a persisted snapshot (CLI/Web resume path). */
  restore(input: AgentSnapshotInput): AgentRuntimeResult;
}

export interface ProviderRegistry {
  get(name: string): ProviderDefinition | undefined;
  list(): ProviderDefinition[];
  has(name: string): boolean;
}

const mockDefinition: ProviderDefinition = {
  name: 'mock',
  snapshotVersion: 1,
  create() {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  },
  restore(input) {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: input.snapshot.configSummary,
    };
  },
};

const claudeCodeDefinition: ProviderDefinition = {
  name: 'claude-code',
  snapshotVersion: 1,
  create(config) {
    const providerConfig = applyProviderRuntimeOverrides(
      defaultProviderConfig('claude-code', config.repoPath, {
        approvalDefault: config.approvalDefault,
      }),
      config.runtime,
    );
    return {
      adapter: createClaudeCodeAdapter(providerConfig, config.gateway),
      provider: 'claude-code',
      // S2: stamp the snapshot schema version into the persisted summary so a
      // future build can detect an incompatible (higher) version on restore.
      configSummary: {
        ...summarizeAgentConfig(providerConfig),
        schemaVersion: claudeCodeDefinition.snapshotVersion,
      },
    };
  },
  restore(input) {
    assertSnapshotVersion(input.snapshot, this.snapshotVersion);
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new Error(
        `Run ${input.snapshot.runId} has a non-replayable claude-code provider snapshot; it may be corrupted or from an incompatible version.`,
      );
    }
    const config = applyProviderRuntimeOverrides(parsed.data, input.runtime);
    return {
      adapter: createClaudeCodeAdapter(config, input.gateway),
      provider: 'claude-code',
      configSummary: {
        ...summarizeAgentConfig(config),
        schemaVersion: claudeCodeDefinition.snapshotVersion,
      },
    };
  },
};

const codexDefinition: ProviderDefinition = {
  name: 'codex',
  snapshotVersion: 1,
  create(config) {
    const providerConfig = applyProviderRuntimeOverrides(
      defaultProviderConfig('codex', config.repoPath, {
        approvalDefault: config.approvalDefault,
      }),
      config.runtime,
    );
    return {
      adapter: createCodexAdapter(providerConfig, config.gateway),
      provider: 'codex',
      // S2: stamp the snapshot schema version (see claude-code create()).
      configSummary: {
        ...summarizeAgentConfig(providerConfig),
        schemaVersion: codexDefinition.snapshotVersion,
      },
    };
  },
  restore(input) {
    assertSnapshotVersion(input.snapshot, this.snapshotVersion);
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new Error(
        `Run ${input.snapshot.runId} has a non-replayable codex provider snapshot; it may be corrupted or from an incompatible version.`,
      );
    }
    const config = applyProviderRuntimeOverrides(parsed.data, input.runtime);
    return {
      adapter: createCodexAdapter(config, input.gateway),
      provider: 'codex',
      configSummary: {
        ...summarizeAgentConfig(config),
        schemaVersion: codexDefinition.snapshotVersion,
      },
    };
  },
};

/**
 * S2: reject a snapshot whose schemaVersion exceeds what this build supports.
 * A missing schemaVersion (older snapshots) is treated as version 1 — backward
 * compatible. Never silently downgrades.
 */
function assertSnapshotVersion(
  snapshot: AgentSnapshotInput['snapshot'],
  supportedVersion: number,
): void {
  const raw = (snapshot.configSummary as { schemaVersion?: unknown })
    .schemaVersion;
  const version = typeof raw === 'number' ? raw : 1;
  if (version > supportedVersion) {
    throw new ProviderSnapshotVersionError(
      snapshot.provider,
      version,
      supportedVersion,
    );
  }
}

const BUILT_IN: ProviderDefinition[] = [
  mockDefinition,
  claudeCodeDefinition,
  codexDefinition,
];

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const byName = new Map<string, ProviderDefinition>();
  for (const def of BUILT_IN) {
    byName.set(def.name, def);
  }
  return {
    get(name) {
      return byName.get(name);
    },
    list() {
      return [...BUILT_IN];
    },
    has(name) {
      return byName.has(name);
    },
  };
}
