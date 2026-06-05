import type { AgentAdapterConfig } from '../types/config.js';
import type { CommandInvocation } from '../types/domain.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import { assertAgentProviderCapabilities } from './agent-adapter.js';
import { buildClaudeProviderEnv } from './claude-code-support.js';

export interface BuiltClaudeCodeCommand extends CommandInvocation {
  stdin?: string;
}

export function buildClaudeCodeCommand(
  config: AgentAdapterConfig,
  input: { prompt: string; promptFile?: string },
): BuiltClaudeCodeCommand {
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
      const result = await gateway.run({
        command,
        cwd: input.worktreeLease.worktreePath,
        policy: input.commandPolicy,
        outputDir: input.outputDir,
        timeoutMs: config.timeoutMs,
        envMode: 'exact',
        env: buildClaudeProviderEnv(),
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

      return {
        provider: 'claude-code',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputFiles: [result.stdoutPath, result.stderrPath],
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
