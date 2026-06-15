import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createMockAgentAdapter,
  agentAdapterConfigSchema,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  type AgentAdapter,
  type AgentAdapterConfig,
  type CommandGateway,
  type RunProviderConfig,
} from '@tekon/core';

export type ProviderRuntimeOverrides = Partial<
  Pick<
    AgentAdapterConfig,
    'timeoutMs' | 'progressHeartbeatMs' | 'noProgressTimeoutMs'
  >
>;

export function createAgentAdapter(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.agent === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  }

  if (input.agent === 'claude-code') {
    const config = applyProviderRuntimeOverrides(
      defaultClaudeCodeConfig(input.repoPath),
      input.runtime,
    );
    return {
      adapter: createClaudeCodeAdapter(config, input.gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(config),
    };
  }

  if (input.agent === 'codex') {
    const config = applyProviderRuntimeOverrides(
      defaultCodexConfig(input.repoPath),
      input.runtime,
    );
    return {
      adapter: createCodexAdapter(config, input.gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new Error(
    `不支持的 agent 类型: ${input.agent}。目前支持的 agent 有: mock, claude-code, codex`,
  );
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

export function createAgentAdapterFromSnapshot(input: {
  snapshot: RunProviderConfig;
  repoPath: string;
  gateway: CommandGateway;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.snapshot.provider === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: input.snapshot.configSummary,
    };
  }

  if (input.snapshot.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new Error(
        `运行 ${input.snapshot.runId} 的 claude-code provider 快照无法恢复，可能已损坏或版本不兼容`,
      );
    }
    return {
      adapter: createClaudeCodeAdapter(parsed.data, input.gateway),
      provider: 'claude-code',
      configSummary: parsed.data,
    };
  }

  if (input.snapshot.provider === 'codex') {
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new Error(
        `运行 ${input.snapshot.runId} 的 codex provider 快照无法恢复，可能已损坏或版本不兼容`,
      );
    }
    return {
      adapter: createCodexAdapter(parsed.data, input.gateway),
      provider: 'codex',
      configSummary: parsed.data,
    };
  }

  throw new Error(
    '自定义 agent provider 的快照无法安全恢复，目前仅支持 mock、claude-code 和 codex',
  );
}

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

export function defaultClaudeCodeConfig(
  repoPath: string,
): AgentAdapterConfig {
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
      approval: 'on-failure',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

export function defaultCodexConfig(
  repoPath: string,
): AgentAdapterConfig {
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
      approval: 'on-failure',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}
