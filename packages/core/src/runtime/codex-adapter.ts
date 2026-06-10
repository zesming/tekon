import { basename, join } from 'node:path';

import type { AgentAdapterConfig } from '../types/config.js';
import type { Artifact, CommandInvocation } from '../types/domain.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import { assertAgentProviderCapabilities } from './agent-adapter.js';
import {
  ingestAgentManifestArtifacts,
  missingRequiredArtifactTypes,
} from './manifest-artifacts.js';

export interface BuiltCodexCommand extends CommandInvocation {
  stdin?: string;
}

const CONTROLLED_CODEX_GLOBAL_ARGS = [
  '--sandbox',
  'workspace-write',
  '--ask-for-approval',
  'on-request',
] as const;
const CODEX_EXEC_SUBCOMMAND = 'exec';

export function buildCodexCommand(
  config: AgentAdapterConfig,
  input: { prompt: string },
): BuiltCodexCommand {
  const userArgs = config.args ?? [];
  const command = config.command ?? 'codex';
  const isRealCodexCommand = isCodexCommand(command);
  if (isRealCodexCommand) {
    assertSafeCodexArgs(userArgs);
  }
  const args = isRealCodexCommand
    ? [...CONTROLLED_CODEX_GLOBAL_ARGS, CODEX_EXEC_SUBCOMMAND, ...userArgs]
    : [...userArgs, CODEX_EXEC_SUBCOMMAND, ...CONTROLLED_CODEX_GLOBAL_ARGS];

  if (config.promptMode === 'arg-append') {
    args.push(input.prompt);
  } else if (config.promptMode === 'file') {
    throw new Error('codex promptMode=file is not supported');
  }

  return {
    tool: command,
    args,
    stdin: config.promptMode === 'stdin' ? input.prompt : undefined,
  };
}

export function createCodexAdapter(
  config: AgentAdapterConfig,
  gateway: CommandGateway,
): AgentAdapter {
  assertAgentProviderCapabilities(config);

  return {
    async runAgent(input) {
      const startedAt = Date.now();
      const command = buildCodexCommand(config, { prompt: input.prompt });
      const manifestPath = join(input.outputDir, 'artifact-manifest.json');
      const result = await gateway.run({
        command,
        cwd: input.worktreeLease.worktreePath,
        policy: input.commandPolicy,
        outputDir: input.outputDir,
        timeoutMs: config.timeoutMs,
        envMode: 'inherit',
        env: {
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
          provider: 'codex',
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
            provider: 'codex',
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
          provider: 'codex',
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
        provider: 'codex',
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

function isCodexCommand(command: string): boolean {
  return basename(command) === 'codex';
}

function assertSafeCodexArgs(args: readonly string[]): void {
  if (
    args.some(
      (arg) =>
        arg === '--' ||
        arg === '--sandbox' ||
        arg === '-s' ||
        arg.startsWith('-s') ||
        arg.startsWith('--sandbox=') ||
        arg === '--ask-for-approval' ||
        arg === '-a' ||
        arg.startsWith('-a') ||
        arg.startsWith('--ask-for-approval=') ||
        arg === '--approval-policy' ||
        arg.startsWith('--approval-policy=') ||
        arg === '--config' ||
        arg === '-c' ||
        arg.startsWith('-c') ||
        arg.startsWith('--config=') ||
        arg === '--enable' ||
        arg.startsWith('--enable=') ||
        arg === '--disable' ||
        arg.startsWith('--disable=') ||
        arg === '--remote' ||
        arg.startsWith('--remote=') ||
        arg === '--remote-auth-token-env' ||
        arg.startsWith('--remote-auth-token-env=') ||
        arg === '--cd' ||
        arg === '-C' ||
        arg.startsWith('-C') ||
        arg.startsWith('--cd=') ||
        arg === '--add-dir' ||
        arg.startsWith('--add-dir=') ||
        arg === '--profile' ||
        arg === '-p' ||
        arg.startsWith('-p') ||
        arg.startsWith('--profile=') ||
        arg === '--output-last-message' ||
        arg === '-o' ||
        arg.startsWith('-o') ||
        arg.startsWith('--output-last-message=') ||
        arg === '--output-schema' ||
        arg.startsWith('--output-schema=') ||
        arg === '--ignore-rules' ||
        arg === '--ignore-user-config' ||
        arg === '--skip-git-repo-check' ||
        arg === '--ephemeral' ||
        arg === '--search' ||
        arg === '--oss' ||
        arg === '--local-provider' ||
        arg.startsWith('--local-provider=') ||
        arg === 'resume' ||
        arg === 'review' ||
        arg === 'help' ||
        arg === '--dangerously-bypass-approvals-and-sandbox' ||
        arg === '--dangerously-bypass-hook-trust' ||
        arg === '--yolo' ||
        arg.includes('danger-full-access') ||
        arg.includes('bypass'),
    )
  ) {
    throw new Error(
      'codex sandbox, approval, filesystem, and config boundaries are controlled by Tekon',
    );
  }
}
