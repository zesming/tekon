import {
  createAgentAdapterFromSnapshot,
  createAgentRuntime,
  createCommandGateway,
  type AgentRuntimeResult,
  type CommandGateway,
  type ProviderRuntimeOverrides,
  type RunProviderConfig,
  type TekonRepositories,
} from '@tekon/core';

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
      // Match the CLI write baseline (PD-10/PD-24): on-failure maps to
      // acceptEdits plus the role's disallowedTools, so a headless Web write
      // node no longer fails closed for ordinary file edits. The read-only
      // draft agent uses its own default-permission path and is unaffected.
      approvalDefault: 'on-failure',
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
  acknowledgeUnrestrictedNetwork?: boolean;
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
    ...(input.acknowledgeUnrestrictedNetwork !== undefined
      ? { acknowledgeUnrestrictedNetwork: input.acknowledgeUnrestrictedNetwork }
      : {}),
  };
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
