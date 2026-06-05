import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CommandInvocation } from '../types/domain.js';
import type { CommandPolicy } from '../types/config.js';
import type { DonkeyRepositories } from '../db/repositories.js';

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: 'pipe';
    detached: true;
  },
) => ChildProcessWithoutNullStreams;

export type CommandGatewayResult =
  | {
      status: 'executed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stdoutPath: string;
      stderrPath: string;
      durationMs: number;
    }
  | { status: 'rejected'; reason: string }
  | { status: 'blocked-for-approval'; decisionId: string };

export interface CommandGatewayRunInput {
  command: CommandInvocation;
  cwd: string;
  policy: CommandPolicy;
  outputDir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  runId?: string;
  nodeId?: string;
}

export interface CommandGateway {
  run(input: CommandGatewayRunInput): Promise<CommandGatewayResult>;
}

export function createCommandGateway(options: {
  repositories?: DonkeyRepositories;
  spawnImpl?: SpawnImpl;
} = {}): CommandGateway {
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    async run(input) {
      const rejection = validateCommand(input.command, input.cwd, input.policy);
      if (rejection) {
        return { status: 'rejected', reason: rejection };
      }

      if (matchesAny(input.command, input.policy.requiresHumanApproval ?? [])) {
        if (!options.repositories || !input.runId || !input.nodeId) {
          return { status: 'rejected', reason: 'human approval requires repository and run context' };
        }

        const decisionId = `decision_${randomUUID()}`;
        await options.repositories.createHumanDecision({
          id: decisionId,
          runId: input.runId,
          nodeId: input.nodeId,
          status: 'pending',
          note: `Command requires approval: ${input.command.tool} ${input.command.args.join(' ')}`,
          createdAt: new Date().toISOString(),
        });
        return { status: 'blocked-for-approval', decisionId };
      }

      return runProcess({
        command: input.command,
        cwd: input.cwd,
        env: { ...process.env, ...(input.env ?? {}) },
        outputDir: input.outputDir ?? join(input.cwd, '.donkey', 'command-logs'),
        timeoutMs: input.timeoutMs ?? 60_000,
        stdin: input.stdin,
        spawnImpl,
      });
    },
  };
}

function validateCommand(
  command: CommandInvocation,
  cwd: string,
  policy: CommandPolicy,
): string | null {
  if (hasShellMetacharacters(command.tool) || command.args.some(hasShellMetacharacters)) {
    return 'shell metacharacters are not allowed in argv commands';
  }

  if (isDangerousRemove(command)) {
    return 'recursive forced remove is always rejected';
  }

  if (isForcePush(command)) {
    return 'force push is always rejected';
  }

  if (isAbsolute(command.tool) && !policy.allow.some((entry) => entry.tool === command.tool)) {
    return 'absolute command paths must be explicitly allowlisted';
  }

  if (!isCwdAllowed(cwd, policy.cwdScope)) {
    return 'cwd is outside command policy scope';
  }

  if (matchesAny(command, policy.deny)) {
    return 'command matches deny policy';
  }

  if (policy.allow.length === 0) {
    return 'command policy allow list must be explicit';
  }

  if (!matchesAny(command, policy.allow)) {
    return 'command does not match allow policy';
  }

  return null;
}

function hasShellMetacharacters(value: string): boolean {
  return /[;&|`$<>]/u.test(value);
}

function matchesAny(command: CommandInvocation, patterns: CommandInvocation[]): boolean {
  return patterns.some((pattern) => {
    const toolMatches = pattern.tool === command.tool || pattern.tool === basename(command.tool);
    if (!toolMatches) {
      return false;
    }
    return pattern.args.every((arg, index) => command.args[index] === arg);
  });
}

function isDangerousRemove(command: CommandInvocation): boolean {
  if (basename(command.tool) !== 'rm') {
    return false;
  }

  const hasRecursive = command.args.some((arg) => arg === '-r' || arg === '-R' || arg === '--recursive' || /^-[^-]*r/i.test(arg));
  const hasForce = command.args.some((arg) => arg === '-f' || arg === '--force' || /^-[^-]*f/i.test(arg));
  return hasRecursive && hasForce;
}

function isForcePush(command: CommandInvocation): boolean {
  if (basename(command.tool) !== 'git' || command.args[0] !== 'push') {
    return false;
  }

  return command.args.some((arg) => arg === '-f' || arg.startsWith('--force'));
}

function isCwdAllowed(cwd: string, scopes: string[]): boolean {
  const resolvedCwd = resolve(cwd);
  return scopes.some((scope) => {
    const resolvedScope = resolve(scope);
    return resolvedCwd === resolvedScope || resolvedCwd.startsWith(`${resolvedScope}${sep}`);
  });
}

async function runProcess(input: {
  command: CommandInvocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputDir: string;
  timeoutMs: number;
  stdin?: string;
  spawnImpl: SpawnImpl;
}): Promise<CommandGatewayResult> {
  mkdirSync(input.outputDir, { recursive: true });
  const commandId = `${Date.now()}-${randomUUID()}`;
  const stdoutPath = join(input.outputDir, `${commandId}.stdout.log`);
  const stderrPath = join(input.outputDir, `${commandId}.stderr.log`);
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const startedAt = Date.now();
  let timedOut = false;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = input.spawnImpl(input.command.tool, input.command.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
      detached: true,
    });
  } catch (error) {
    await Promise.allSettled([endStream(stdout), endStream(stderr)]);
    return {
      status: 'rejected',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdin.end(input.stdin ?? '');

  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }, input.timeoutMs);

  return new Promise((resolvePromise) => {
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      Promise.all([endStream(stdout), endStream(stderr)]).then(() => {
        resolvePromise({
        status: 'executed',
        exitCode,
        signal,
        timedOut,
        stdoutPath,
        stderrPath,
        durationMs: Date.now() - startedAt,
      });
      });
    });
  });
}

async function endStream(stream: Writable): Promise<void> {
  if (stream.writableFinished) {
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      stream.off?.('finish', onFinish);
      stream.off?.('error', onError);
    };
    const onFinish = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once?.('finish', onFinish);
    stream.once?.('error', onError);
    if (!stream.writableEnded) {
      stream.end();
    }
  });
}
