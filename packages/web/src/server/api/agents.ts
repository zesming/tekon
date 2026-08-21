import {
  createAgentAdapterFromSnapshot,
  createAgentRuntime,
  createCommandGateway,
  createGateEngine,
  createWorkflowEngine,
  createWorktreeManager,
  isWorkflowTerminalError,
  type AgentRuntimeResult,
  type CommandGateway,
  type ProviderRuntimeOverrides,
  type RunProviderConfig,
  type TekonRepositories,
  type AuditLogger,
} from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';
import { ApiError } from './errors.js';
import { positiveIntOrUndefined } from './common.js';

export function createWebAgentRuntime(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
}): AgentRuntimeResult {
  try {
    return createAgentRuntime({
      agent: input.agent,
      repoPath: input.repoPath,
      gateway: input.gateway,
      runtime: input.runtime,
      approvalDefault: 'on-request',
    });
  } catch (error) {
    throw new ApiError(
      'BAD_REQUEST',
      error instanceof Error ? error.message : String(error),
    );
  }
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
  const agentRuntime = webAdapterFromSnapshot(gateway, runProvider);
  const engine = createWorkflowEngine({
    repoPath: input.context.projectRoot,
    dataDir: '.tekon',
    repositories: input.repositories,
    audit: input.audit,
    adapter: agentRuntime.adapter,
    agentProvider: agentRuntime.provider,
    agentConfigSummary: agentRuntime.configSummary,
    gateEngine: createGateEngine({
      repositories: input.repositories,
      gateway,
    }),
    worktreeManager: createWorktreeManager({
      repositories: input.repositories,
      gateway,
    }),
  });
  // S2 过渡:core resumeRun 对终态 run 抛 WorkflowTerminalError(P1-04/M8);
  // 映射为 400,避免落入 dispatch 的 INTERNAL_ERROR(500)。S7 重构 resume/approve
  // 为异步 job 后,此映射随之调整。
  try {
    return await engine.resumeRun(input.runId);
  } catch (error) {
    if (isWorkflowTerminalError(error)) {
      throw new ApiError('BAD_REQUEST', error.message);
    }
    throw error;
  }
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
  webAdapterFromSnapshot(createCommandGateway(), provider);
}

function webAdapterFromSnapshot(
  gateway: CommandGateway,
  provider: RunProviderConfig,
) {
  try {
    return createAgentAdapterFromSnapshot({
      snapshot: provider,
      gateway,
    });
  } catch (error) {
    throw new ApiError(
      'BAD_REQUEST',
      error instanceof Error ? error.message : String(error),
    );
  }
}
