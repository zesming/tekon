import { lstatSync } from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';

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
const DEFAULT_CODEX_PROFILE = 'internal';
const CODEX_EXEC_SUBCOMMAND = 'exec';

export function buildCodexCommand(
  config: AgentAdapterConfig,
  input: {
    artifactOutputDir?: string;
    prompt: string;
    runContext?: { nodeId: string; runId: string };
  },
): BuiltCodexCommand {
  const userArgs = config.args ?? [];
  const command = config.command ?? 'codex';
  const isRealCodexCommand = isCodexCommand(command);
  if (isRealCodexCommand) {
    assertSafeCodexArgs(userArgs);
  }
  const args = isRealCodexCommand
    ? [
        ...controlledCodexGlobalArgs(config, {
          artifactOutputDir: input.artifactOutputDir,
          runContext: input.runContext,
        }),
        CODEX_EXEC_SUBCOMMAND,
        ...userArgs,
      ]
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
      const command = buildCodexCommand(config, {
        artifactOutputDir: input.outputDir,
        prompt: input.prompt,
        runContext: {
          nodeId: input.runContext.nodeId,
          runId: input.runContext.runId,
        },
      });
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

function controlledCodexGlobalArgs(
  config: AgentAdapterConfig,
  input: {
    artifactOutputDir?: string;
    runContext?: { nodeId: string; runId: string };
  },
): string[] {
  const profileArgs = [
    '--profile',
    assertSafeCodexProfile(config.profile ?? DEFAULT_CODEX_PROFILE),
  ];
  const outputDir = assertSafeCodexArtifactOutputDir(
    config,
    input.artifactOutputDir,
    input.runContext,
  );
  return [
    ...profileArgs,
    ...CONTROLLED_CODEX_GLOBAL_ARGS,
    '--add-dir',
    outputDir,
  ];
}

function assertSafeCodexProfile(profile: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(profile)) {
    throw new Error('codex profile must be a safe profile name');
  }
  return profile;
}

function assertSafeCodexArtifactOutputDir(
  config: AgentAdapterConfig,
  outputDir: string | undefined,
  runContext: { nodeId: string; runId: string } | undefined,
): string {
  if (!outputDir) {
    throw new Error('codex artifact output directory is required');
  }
  const normalizedOutputDir = normalize(outputDir);
  const runStoragePath = config.permissionProfile.filesystemScope
    .map((scope) => tekonRunStoragePath(scope, normalizedOutputDir))
    .find((path) => path !== undefined);
  if (!isAbsolute(normalizedOutputDir) || !runStoragePath) {
    throw new Error(
      'codex artifact output directory must be under Tekon run storage',
    );
  }
  if (!runContext) {
    throw new Error('codex run context is required');
  }
  if (
    runStoragePath.runId !== runContext.runId ||
    runStoragePath.nodeId !== runContext.nodeId
  ) {
    throw new Error(
      'codex artifact output directory must match the current run and node',
    );
  }
  if (
    config.permissionProfile.filesystemScope.some((scope) =>
      pathIncludesSymlink(scope, normalizedOutputDir),
    )
  ) {
    throw new Error('codex artifact output directory cannot include symlinks');
  }
  return normalizedOutputDir;
}

function tekonRunStoragePath(
  scope: string,
  candidate: string,
): { nodeId: string; runId: string } | undefined {
  if (!isPathInside(scope, candidate)) {
    return undefined;
  }
  const segments = normalize(relative(resolve(scope), resolve(candidate)))
    .split(/[\\/]+/u)
    .filter(Boolean);
  if (
    segments[0] === '.tekon' &&
    segments[1] === 'runs' &&
    segments.length === 4 &&
    Boolean(segments[2]) &&
    Boolean(segments[3])
  ) {
    return { runId: segments[2], nodeId: segments[3] };
  }
  return undefined;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath.length > 0 &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
  );
}

function pathIncludesSymlink(parent: string, candidate: string): boolean {
  if (!isPathInside(parent, candidate)) {
    return false;
  }
  let currentPath = resolve(parent);
  for (const segment of normalize(relative(currentPath, resolve(candidate)))
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    currentPath = join(currentPath, segment);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  return false;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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
        arg === '--image' ||
        arg === '-i' ||
        arg.startsWith('-i') ||
        arg.startsWith('--image=') ||
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
