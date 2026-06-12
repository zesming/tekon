import {
  agentAdapterConfigSchema,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCommandGateway,
  createGateEngine,
  createMockAgentAdapter,
  createWorkflowEngine,
  createWorktreeManager,
  type AgentAdapter,
  type AgentAdapterConfig,
  type CommandGateway,
  type RunProviderConfig,
  type TekonRepositories,
  type AuditLogger,
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
} from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';
import { ApiError } from './errors.js';
import { positiveIntOrUndefined } from './common.js';

type ProviderRuntimeOverrides = Partial<
  Pick<
    AgentAdapterConfig,
    'timeoutMs' | 'progressHeartbeatMs' | 'noProgressTimeoutMs'
  >
>;

export function createWebAgentRuntime(input: {
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
      defaultWebClaudeCodeConfig(input.repoPath),
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
      defaultWebCodexConfig(input.repoPath),
      input.runtime,
    );
    return {
      adapter: createCodexAdapter(config, input.gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new ApiError('BAD_REQUEST', `Unsupported agent: ${input.agent}`);
}

export function providerRuntimeFromRunInput(input: {
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
}): ProviderRuntimeOverrides {
  return {
    timeoutMs: positiveIntOrUndefined(input.timeoutMs, 'timeoutMs'),
    noProgressTimeoutMs: positiveIntOrUndefined(
      input.noProgressTimeoutMs,
      'noProgressTimeoutMs',
    ),
    progressHeartbeatMs: positiveIntOrUndefined(
      input.progressHeartbeatMs,
      'progressHeartbeatMs',
    ),
  };
}

export async function resumeWorkflowRun(input: {
  context: WebProjectContext;
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
}) {
  const gateway = createCommandGateway({ repositories: input.repositories });
  const runProvider = await input.repositories.getRunProviderConfig(
    input.runId,
  );
  if (!runProvider) {
    throw new ApiError(
      'BAD_REQUEST',
      `Run ${input.runId} has no provider snapshot; cannot resume safely.`,
    );
  }
  const engine = createWorkflowEngine({
    repoPath: input.context.projectRoot,
    dataDir: '.tekon',
    repositories: input.repositories,
    audit: input.audit,
    adapter: createWebAgentAdapterFromSnapshot(gateway, runProvider),
    agentProvider: runProvider.provider,
    agentConfigSummary: runProvider.configSummary,
    gateEngine: createGateEngine({
      repositories: input.repositories,
      gateway,
    }),
    worktreeManager: createWorktreeManager({
      repositories: input.repositories,
      gateway,
    }),
  });
  return engine.resumeRun(input.runId);
}

export async function assertRunCanResume(input: {
  repositories: TekonRepositories;
  runId: string;
}) {
  const provider = await input.repositories.getRunProviderConfig(input.runId);
  if (!provider) {
    throw new ApiError(
      'BAD_REQUEST',
      `Run ${input.runId} has no provider snapshot; cannot resume safely.`,
    );
  }
  createWebAgentAdapterFromSnapshot(createCommandGateway(), provider);
}

function createWebAgentAdapterFromSnapshot(
  gateway: CommandGateway,
  provider: RunProviderConfig,
) {
  if (provider.provider === 'mock') {
    return createMockAgentAdapter();
  }
  if (provider.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(provider.configSummary);
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new ApiError(
        'BAD_REQUEST',
        `Run ${provider.runId} has a non-replayable claude-code provider snapshot.`,
      );
    }
    return createClaudeCodeAdapter(parsed.data, gateway);
  }
  if (provider.provider === 'codex') {
    const parsed = agentAdapterConfigSchema.safeParse(provider.configSummary);
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new ApiError(
        'BAD_REQUEST',
        `Run ${provider.runId} has a non-replayable codex provider snapshot.`,
      );
    }
    return createCodexAdapter(parsed.data, gateway);
  }
  throw new ApiError(
    'BAD_REQUEST',
    'Web resume does not support custom agent adapters yet',
  );
}

function applyProviderRuntimeOverrides(
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

function defaultWebClaudeCodeConfig(repoPath: string): AgentAdapterConfig {
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
      approval: 'on-request',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

function defaultWebCodexConfig(repoPath: string): AgentAdapterConfig {
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
      approval: 'on-request',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

function summarizeAgentConfig(
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
