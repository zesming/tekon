import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import {
  agentArtifactManifestSchema,
  validateArtifactContent,
} from '../artifact/schemas.js';
import type { AgentAdapterConfig } from '../types/config.js';
import type {
  Artifact,
  ArtifactType,
  CommandInvocation,
} from '../types/domain.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';
import { assertAgentProviderCapabilities } from './agent-adapter.js';
import { buildClaudeProviderEnv } from './claude-code-support.js';

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
          artifacts = await ingestManifestArtifacts(input, manifestPath);
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

async function ingestManifestArtifacts(
  input: AgentRunInput,
  manifestPath: string,
): Promise<Artifact[]> {
  if (!input.artifactStore) {
    return [];
  }
  if (!existsSync(manifestPath)) {
    if ((input.requiredArtifactTypes ?? []).length === 0) {
      return [];
    }
    throw new Error(`missing artifact manifest: ${manifestPath}`);
  }

  const manifest = agentArtifactManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  const artifacts: Artifact[] = [];
  for (const entry of manifest.artifacts) {
    const artifactPath = resolveOutputPath(input.outputDir, entry.path);
    const content = readFileSync(artifactPath, 'utf8');
    validateArtifactContent(entry.type, content);
    artifacts.push(
      await input.artifactStore.writeArtifact({
        runId: input.runContext.runId,
        nodeId: input.runContext.nodeId,
        type: entry.type,
        content,
        summary: entry.summary,
      }),
    );
  }
  return artifacts;
}

function resolveOutputPath(outputDir: string, path: string): string {
  const root = resolve(outputDir);
  const target = resolve(root, path);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }
  throw new Error(`artifact path escapes TEKON_OUTPUT_DIR: ${path}`);
}

function missingRequiredArtifactTypes(
  required: ArtifactType[] | undefined,
  artifacts: Artifact[],
): ArtifactType[] {
  const seen = new Set(artifacts.map((artifact) => artifact.type));
  return (required ?? []).filter((type) => !seen.has(type));
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
