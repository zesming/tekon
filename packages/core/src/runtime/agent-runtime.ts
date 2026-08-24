import {
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  type AgentAdapterConfig,
} from '../types/config.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { RunProviderConfig } from '../types/domain.js';
// There is a module cycle with provider-registry (it imports the config
// helpers exported below). It is safe at runtime because neither module calls
// the other's exports during evaluation — the live binding is resolved before
// the first factory call, not at import time.
import { createBuiltInProviderRegistry } from './provider-registry.js';

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
 * This is the single factory shared by CLI and Web runtimes. Delegates to the
 * provider registry (phase 2 S1); the registry is imported lazily to avoid a
 * cycle (provider-registry imports the helpers defined in this module).
 */
export function createAgentRuntime(
  config: AgentRuntimeConfig,
): AgentRuntimeResult {
  const def = createBuiltInProviderRegistry().get(config.agent);
  if (!def) {
    throw new Error(
      `Unsupported agent: ${config.agent}. Supported agents: mock, claude-code, codex`,
    );
  }
  return def.create(config);
}

/**
 * Restore an agent adapter from a persisted RunProviderConfig snapshot.
 * Used by both CLI resume and Web resume to safely reconstruct adapters.
 * Delegates to the provider registry (phase 2 S1/S2).
 */
export function createAgentAdapterFromSnapshot(
  input: AgentSnapshotInput,
): AgentRuntimeResult {
  const def = createBuiltInProviderRegistry().get(input.snapshot.provider);
  if (!def) {
    throw new Error(
      'Custom agent provider snapshots cannot be safely replayed; only mock, claude-code, and codex are supported.',
    );
  }
  return def.restore(input);
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
