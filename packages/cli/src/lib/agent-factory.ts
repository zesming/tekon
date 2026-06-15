import {
  createAgentRuntime as coreCreateAgentRuntime,
  createAgentAdapterFromSnapshot as coreCreateFromSnapshot,
  applyProviderRuntimeOverrides as coreApplyOverrides,
  summarizeAgentConfig as coreSummarize,
  defaultProviderConfig as coreDefaultConfig,
  type AgentAdapterConfig,
  type AgentAdapter,
  type CommandGateway,
  type RunProviderConfig,
  type ProviderRuntimeOverrides,
  type ApprovalDefault,
} from '@tekon/core';

export type { ProviderRuntimeOverrides, ApprovalDefault } from '@tekon/core';

export function createAgentAdapter(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
  approvalDefault?: ApprovalDefault;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  return coreCreateAgentRuntime({
    agent: input.agent,
    repoPath: input.repoPath,
    gateway: input.gateway,
    runtime: input.runtime,
    approvalDefault: input.approvalDefault ?? 'on-failure',
  });
}

export function createAgentAdapterFromSnapshot(input: {
  snapshot: RunProviderConfig;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  return coreCreateFromSnapshot({
    snapshot: input.snapshot,
    gateway: input.gateway,
    runtime: input.runtime,
  });
}

export function applyProviderRuntimeOverrides(
  config: AgentAdapterConfig,
  runtime?: ProviderRuntimeOverrides,
): AgentAdapterConfig {
  return coreApplyOverrides(config, runtime);
}

export function summarizeAgentConfig(
  config: AgentAdapterConfig,
): Record<string, unknown> {
  return coreSummarize(config);
}

export function defaultClaudeCodeConfig(
  repoPath: string,
): AgentAdapterConfig {
  return coreDefaultConfig('claude-code', repoPath, {
    approvalDefault: 'on-failure',
  });
}

export function defaultCodexConfig(
  repoPath: string,
): AgentAdapterConfig {
  return coreDefaultConfig('codex', repoPath, {
    approvalDefault: 'on-failure',
  });
}

export function providerRuntimeFromCliOptions(
  values: Record<string, string | boolean | undefined>,
): ProviderRuntimeOverrides {
  return {
    timeoutMs: parsePositiveIntOption(
      values['timeout-ms'],
      '--timeout-ms',
    ),
    noProgressTimeoutMs: parsePositiveIntOption(
      values['no-progress-timeout-ms'],
      '--no-progress-timeout-ms',
    ),
    progressHeartbeatMs: parsePositiveIntOption(
      values['progress-heartbeat-ms'],
      '--progress-heartbeat-ms',
    ),
  };
}

export function parsePositiveIntOption(
  value: string | boolean | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}
