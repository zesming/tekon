import { join } from 'node:path';

import type { AgentAdapterConfig } from '../types/config.js';
import type { Artifact, CommandInvocation } from '../types/domain.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import { assertAgentProviderCapabilities } from './agent-adapter.js';
import { buildClaudeProviderEnv } from './claude-code-support.js';
import {
  ingestAgentManifestArtifacts,
  missingRequiredArtifactTypes,
} from './manifest-artifacts.js';

export interface BuiltClaudeCodeCommand extends CommandInvocation {
  stdin?: string;
}

export function buildClaudeCodeCommand(
  config: AgentAdapterConfig,
  input: { prompt: string; promptFile?: string },
): BuiltClaudeCodeCommand {
  assertSafeClaudeArgs(config.args ?? []);

  const args = [...(config.args ?? [])];

  if (config.outputFormat === 'json') {
    args.push('--output-format', 'json');
  }

  args.push('--permission-mode', permissionModeFor(config));

  if (config.promptMode === 'arg-append') {
    args.push(input.prompt);
  } else if (config.promptMode === 'file') {
    if (!input.promptFile) {
      throw new Error('promptMode=file requires promptFile');
    }
    args.push('--prompt-file', input.promptFile);
  }

  return {
    tool: config.command ?? 'claude',
    args,
    stdin: config.promptMode === 'stdin' ? input.prompt : undefined,
  };
}

export function createClaudeCodeAdapter(
  config: AgentAdapterConfig,
  gateway: CommandGateway,
): AgentAdapter {
  assertAgentProviderCapabilities(config);

  return {
    async runAgent(input) {
      const startedAt = Date.now();
      const command = buildClaudeCodeCommand(config, { prompt: input.prompt });
      const manifestPath = join(input.outputDir, 'artifact-manifest.json');
      const result = await gateway.run({
        command,
        cwd: input.worktreeLease.worktreePath,
        policy: input.commandPolicy,
        outputDir: input.outputDir,
        timeoutMs: config.timeoutMs,
        envMode: 'exact',
        env: {
          ...buildClaudeProviderEnv(),
          TEKON_OUTPUT_DIR: input.outputDir,
          TEKON_ARTIFACT_MANIFEST: manifestPath,
          TEKON_RUN_ID: input.runContext.runId,
          TEKON_NODE_ID: input.runContext.nodeId,
        },
        stdin: command.stdin,
        runId: input.runContext.runId,
        nodeId: input.runContext.nodeId,
      });

      if (result.status !== 'executed') {
        return {
          provider: 'claude-code',
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          outputFiles: [],
          timedOut: false,
        };
      }

      let artifacts: Artifact[] = [];
      let artifactOutputFiles: string[] = [];
      if (result.exitCode === 0 && input.artifactStore) {
        try {
          artifacts = await ingestAgentManifestArtifacts({
            runInput: input,
            manifestPath,
          });
          artifactOutputFiles = artifacts.map((artifact) => artifact.path);
        } catch {
          return {
            provider: 'claude-code',
            exitCode: 1,
            durationMs: result.durationMs,
            outputFiles: [result.stdoutPath, result.stderrPath],
            timedOut: result.timedOut,
          };
        }
      }

      if (
        result.exitCode === 0 &&
        missingRequiredArtifactTypes(input.requiredArtifactTypes, artifacts)
          .length > 0
      ) {
        return {
          provider: 'claude-code',
          exitCode: 1,
          durationMs: result.durationMs,
          outputFiles: [
            result.stdoutPath,
            result.stderrPath,
            ...artifactOutputFiles,
          ],
          artifacts,
          timedOut: result.timedOut,
        };
      }

      return {
        provider: 'claude-code',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputFiles: [
          result.stdoutPath,
          result.stderrPath,
          ...artifactOutputFiles,
        ],
        artifacts,
        timedOut: result.timedOut,
      };
    },
  };
}

function permissionModeFor(config: AgentAdapterConfig): string {
  if (config.permissionProfile.approval === 'on-request') {
    return 'default';
  }
  return 'acceptEdits';
}

function assertSafeClaudeArgs(args: readonly string[]): void {
  if (
    args.some(
      (arg) =>
        arg === '--permission-mode' || arg.startsWith('--permission-mode='),
    )
  ) {
    throw new Error('claude permission mode is controlled by Tekon');
  }

  if (
    args.some(
      (arg) =>
        arg === 'bypassPermissions' ||
        arg.startsWith('--dangerously-skip-permissions') ||
        arg.includes('bypassPermissions'),
    )
  ) {
    throw new Error('claude bypass permissions mode is not allowed');
  }
}
