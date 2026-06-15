import {
  createClaudeCodeAdapter,
} from './claude-code-adapter.js';
import {
  createCodexAdapter,
} from './codex-adapter.js';
import {
  createMockAgentAdapter,
} from './mock-agent-adapter.js';
import {
  agentAdapterConfigSchema,
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  type AgentAdapterConfig,
} from '../types/config.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { RunProviderConfig } from '../types/domain.js';

// ── Types ──────────────────────────────────────────────────────────────

export type ProviderRuntimeOverrides = Partial<
  Pick<
    AgentAdapterConfig,
    'timeoutMs' | 'progressHeartbeatMs' | 'noProgressTimeoutMs'
  >
>;

export type ApprovalDefault = 'on-failure' | 'on-request';

export type SupportedAgent = 'mock' | 'claude-code' | 'codex';

export interface AgentRuntimeConfig {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
  approvalDefault?: ApprovalDefault;
}

export interface AgentRuntimeResult {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
}

export interface AgentSnapshotInput {
  snapshot: RunProviderConfig;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create an agent adapter from a high-level agent name and configuration.
 * This is the single factory shared by CLI and Web runtimes.
 */
export function createAgentRuntime(
  config: AgentRuntimeConfig,
): AgentRuntimeResult {
  if (config.agent === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  }

  if (config.agent === 'claude-code') {
    const providerConfig = applyProviderRuntimeOverrides(
      defaultProviderConfig('claude-code', config.repoPath, {
        approvalDefault: config.approvalDefault,
      }),
      config.runtime,
    );
    return {
      adapter: createClaudeCodeAdapter(providerConfig, config.gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(providerConfig),
    };
  }

  if (config.agent === 'codex') {
    const providerConfig = applyProviderRuntimeOverrides(
      defaultProviderConfig('codex', config.repoPath, {
        approvalDefault: config.approvalDefault,
      }),
      config.runtime,
    );
    return {
      adapter: createCodexAdapter(providerConfig, config.gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(providerConfig),
    };
  }

  throw new Error(
    `Unsupported agent: ${config.agent}. Supported agents: mock, claude-code, codex`,
  );
}

/**
 * Restore an agent adapter from a persisted RunProviderConfig snapshot.
 * Used by both CLI resume and Web resume to safely reconstruct adapters.
 */
export function createAgentAdapterFromSnapshot(
  input: AgentSnapshotInput,
): AgentRuntimeResult {
  const { snapshot, gateway } = input;

  if (snapshot.provider === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: snapshot.configSummary,
    };
  }

  if (snapshot.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(
      snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new Error(
        `Run ${snapshot.runId} has a non-replayable claude-code provider snapshot; it may be corrupted or from an incompatible version.`,
      );
    }
    const config = applyProviderRuntimeOverrides(
      parsed.data,
      input.runtime,
    );
    return {
      adapter: createClaudeCodeAdapter(config, gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(config),
    };
  }

  if (snapshot.provider === 'codex') {
    const parsed = agentAdapterConfigSchema.safeParse(
      snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new Error(
        `Run ${snapshot.runId} has a non-replayable codex provider snapshot; it may be corrupted or from an incompatible version.`,
      );
    }
    const config = applyProviderRuntimeOverrides(
      parsed.data,
      input.runtime,
    );
    return {
      adapter: createCodexAdapter(config, gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new Error(
    'Custom agent provider snapshots cannot be safely replayed; only mock, claude-code, and codex are supported.',
  );
}

/**
 * Build a default AgentAdapterConfig for a given agent type.
 * The `approvalDefault` option controls the permission profile's approval
 * policy — CLI uses 'on-failure', Web uses 'on-request'.
 */
export function defaultProviderConfig(
  agent: SupportedAgent,
  repoPath: string,
  opts?: { approvalDefault?: ApprovalDefault },
): AgentAdapterConfig {
  const approval = opts?.approvalDefault ?? 'on-failure';

  if (agent === 'claude-code') {
    return {
      provider: 'claude-code',
      command: 'claude',
      args: ['-p'],
      promptMode: 'stdin',
      outputFormat: 'json',
      timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
      progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
      noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
      permissionProfile: {
        sandbox: 'workspace-write',
        approval,
        filesystemScope: [repoPath],
        network: 'restricted',
        tools: {
          allow: ['git', 'npm', 'pnpm'],
          deny: ['rm', 'sudo', 'git push --force'],
        },
      },
    };
  }

  if (agent === 'codex') {
    return {
      provider: 'codex',
      command: 'codex',
      args: [],
      profile: 'internal',
      promptMode: 'stdin',
      outputFormat: 'text',
      timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
      progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
      noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
      permissionProfile: {
        sandbox: 'workspace-write',
        approval,
        filesystemScope: [repoPath],
        network: 'restricted',
        tools: {
          allow: ['git', 'npm', 'pnpm'],
          deny: ['rm', 'sudo', 'git push --force'],
        },
      },
    };
  }

  throw new Error(
    `defaultProviderConfig only supports claude-code and codex, got: ${agent}`,
  );
}

/**
 * Merge runtime override values onto a base provider config.
 * Undefined overrides are ignored; base values are preserved.
 */
export function applyProviderRuntimeOverrides(
  config: AgentAdapterConfig,
  runtime?: ProviderRuntimeOverrides,
): AgentAdapterConfig {
  return {
    ...config,
    timeoutMs: runtime?.timeoutMs ?? config.timeoutMs,
    noProgressTimeoutMs:
      runtime?.noProgressTimeoutMs ?? config.noProgressTimeoutMs,
    progressHeartbeatMs:
      runtime?.progressHeartbeatMs ?? config.progressHeartbeatMs,
  };
}

/**
 * Serialize an AgentAdapterConfig into a plain record suitable for
 * persistence as a RunProviderConfig.configSummary.
 */
export function summarizeAgentConfig(
  config: AgentAdapterConfig,
): Record<string, unknown> {
  return {
    provider: config.provider,
    command: config.command,
    args: config.args,
    profile: config.profile,
    promptMode: config.promptMode,
    outputFormat: config.outputFormat,
    timeoutMs: config.timeoutMs,
    progressHeartbeatMs: config.progressHeartbeatMs,
    noProgressTimeoutMs: config.noProgressTimeoutMs,
    permissionProfile: {
      sandbox: config.permissionProfile.sandbox,
      approval: config.permissionProfile.approval,
      filesystemScope: config.permissionProfile.filesystemScope,
      network: config.permissionProfile.network,
      tools: config.permissionProfile.tools,
    },
  };
}
