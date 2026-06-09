import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { Transform, Writable } from 'node:stream';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CommandInvocation } from '../types/domain.js';
import type { CommandPolicy } from '../types/config.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createSecretRedactionTransform } from '../security/secrets.js';

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
  envMode?: CommandEnvironmentMode;
  stdin?: string;
  runId?: string;
  nodeId?: string;
}

export type CommandEnvironmentMode = 'safe-default' | 'inherit' | 'exact';

export interface CommandGateway {
  run(input: CommandGatewayRunInput): Promise<CommandGatewayResult>;
}

export function createCommandGateway(
  options: {
    repositories?: TekonRepositories;
    spawnImpl?: SpawnImpl;
  } = {},
): CommandGateway {
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    async run(input) {
      const rejection = validateCommand(input.command, input.cwd, input.policy);
      if (rejection) {
        return { status: 'rejected', reason: rejection };
      }

      if (matchesAny(input.command, input.policy.requiresHumanApproval ?? [])) {
        if (!options.repositories || !input.runId || !input.nodeId) {
          return {
            status: 'rejected',
            reason: 'human approval requires repository and run context',
          };
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
        env: buildChildEnv({ env: input.env, envMode: input.envMode }),
        outputDir: input.outputDir ?? join(input.cwd, '.tekon', 'command-logs'),
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
  if (
    hasShellMetacharacters(command.tool) ||
    command.args.some(hasShellMetacharacters)
  ) {
    return 'shell metacharacters are not allowed in argv commands';
  }

  if (isDangerousRemove(command)) {
    return 'recursive forced remove is always rejected';
  }

  if (isForcePush(command)) {
    return 'force push is always rejected';
  }

  if (policy.network !== 'enabled' && isKnownNetworkCommand(command)) {
    return 'network command is not allowed by policy';
  }

  if (
    isAbsolute(command.tool) &&
    !policy.allow.some((entry) => entry.tool === command.tool)
  ) {
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

function matchesAny(
  command: CommandInvocation,
  patterns: CommandInvocation[],
): boolean {
  return patterns.some((pattern) => {
    const toolMatches =
      pattern.tool === command.tool || pattern.tool === basename(command.tool);
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

  const hasRecursive = command.args.some(
    (arg) =>
      arg === '-r' ||
      arg === '-R' ||
      arg === '--recursive' ||
      /^-[^-]*r/i.test(arg),
  );
  const hasForce = command.args.some(
    (arg) => arg === '-f' || arg === '--force' || /^-[^-]*f/i.test(arg),
  );
  return hasRecursive && hasForce;
}

function isForcePush(command: CommandInvocation): boolean {
  if (basename(command.tool) !== 'git' || command.args[0] !== 'push') {
    return false;
  }

  return command.args.some((arg) => arg === '-f' || arg.startsWith('--force'));
}

function isKnownNetworkCommand(command: CommandInvocation): boolean {
  const tool = basename(command.tool);

  if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'npx'].includes(tool)) {
    return true;
  }

  if (tool === 'git') {
    return [
      'fetch',
      'pull',
      'push',
      'clone',
      'ls-remote',
      'submodule',
    ].includes(command.args[0] ?? '');
  }

  if (tool === 'npm' || tool === 'pnpm') {
    return ['install', 'add', 'update', 'dlx', 'exec'].includes(
      command.args[0] ?? '',
    );
  }

  if (tool === 'gh') {
    return ['api', 'pr', 'repo', 'run'].includes(command.args[0] ?? '');
  }

  return false;
}

function isCwdAllowed(cwd: string, scopes: string[]): boolean {
  const resolvedCwd = resolve(cwd);
  return scopes.some((scope) => {
    const resolvedScope = resolve(scope);
    return (
      resolvedCwd === resolvedScope ||
      resolvedCwd.startsWith(`${resolvedScope}${sep}`)
    );
  });
}

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
] as const;

function buildChildEnv(input: {
  env?: NodeJS.ProcessEnv;
  envMode?: CommandEnvironmentMode;
}): NodeJS.ProcessEnv {
  if (input.envMode === 'inherit') {
    return { ...process.env, ...(input.env ?? {}) };
  }

  if (input.envMode === 'exact') {
    return { ...(input.env ?? {}) };
  }

  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      safeEnv[key] = process.env[key];
    }
  }

  return { ...safeEnv, ...(input.env ?? {}) };
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
  const stdoutRedactor = createSecretRedactionTransform();
  const stderrRedactor = createSecretRedactionTransform();
  const stdoutLog = monitorWritable(stdout);
  const stderrLog = monitorWritable(stderr);
  const stdoutRedaction = monitorTransform(stdoutRedactor);
  const stderrRedaction = monitorTransform(stderrRedactor);
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
    await Promise.allSettled([
      endTransform(stdoutRedactor),
      endTransform(stderrRedactor),
      endStream(stdout),
      endStream(stderr),
    ]);
    return {
      status: 'rejected',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  child.stdout.pipe(stdoutRedactor).pipe(stdout);
  child.stderr.pipe(stderrRedactor).pipe(stderr);
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdinError: Error | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    let hardSettleTimeout: ReturnType<typeof setTimeout> | null = null;
    const terminationGraceMs = getTerminationGraceMs(input.timeoutMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      killChildProcess(child, 'SIGTERM');
      forceKillTimeout = setTimeout(() => {
        killChildProcess(child, 'SIGKILL');
        hardSettleTimeout = setTimeout(() => {
          child.stdout.unpipe(stdoutRedactor);
          child.stderr.unpipe(stderrRedactor);
          settle({
            status: 'executed',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
            stdoutPath,
            stderrPath,
            durationMs: Date.now() - startedAt,
          });
        }, terminationGraceMs);
      }, terminationGraceMs);
    }, input.timeoutMs);
    const settle = (result: CommandGatewayResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      if (hardSettleTimeout) {
        clearTimeout(hardSettleTimeout);
      }
      Promise.allSettled([
        stdoutRedaction.end(),
        stderrRedaction.end(),
        stdoutLog.end(),
        stderrLog.end(),
      ]).then((streamResults) => {
        if (result.status === 'executed') {
          const streamError =
            stdoutRedaction.error ??
            stderrRedaction.error ??
            stdoutLog.error ??
            stderrLog.error ??
            getRejectedReason(streamResults);
          if (streamError) {
            resolvePromise({
              status: 'rejected',
              reason: `failed to write command logs: ${formatErrorMessage(streamError)}`,
            });
            return;
          }
        }

        resolvePromise(result);
      });
    };

    child.once('error', (error: Error) => {
      settle({
        status: 'rejected',
        reason: error.message,
      });
    });
    child.once('close', (exitCode, signal) => {
      if (input.stdin !== undefined && stdinError) {
        settle({
          status: 'rejected',
          reason: `failed to write command stdin: ${stdinError.message}`,
        });
        return;
      }
      settle({
        status: 'executed',
        exitCode,
        signal,
        timedOut,
        stdoutPath,
        stderrPath,
        durationMs: Date.now() - startedAt,
      });
    });
    child.stdin.prependListener('error', (error: Error) => {
      stdinError = error;
    });
    if (input.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input.stdin);
    }
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRejectedReason(results: PromiseSettledResult<void>[]): unknown {
  return results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )?.reason;
}

function getTerminationGraceMs(timeoutMs: number): number {
  return Math.min(1_000, Math.max(10, Math.floor(timeoutMs / 10)));
}

function killChildProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group signaling is unavailable.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Timeout handling should always converge through the bounded hard-settle path.
  }
}

function monitorWritable(stream: Writable): {
  readonly error: Error | null;
  end(): Promise<void>;
} {
  let streamError: Error | null = null;
  stream.on('error', (error: Error) => {
    streamError ??= error;
  });

  return {
    get error() {
      return streamError;
    },
    async end() {
      if (streamError || stream.destroyed || stream.writableFinished) {
        return;
      }

      await endStream(stream);
    },
  };
}

function monitorTransform(stream: Transform): {
  readonly error: Error | null;
  end(): Promise<void>;
} {
  let streamError: Error | null = null;
  stream.on('error', (error: Error) => {
    streamError ??= error;
  });

  return {
    get error() {
      return streamError;
    },
    async end() {
      if (streamError || stream.destroyed || stream.writableEnded) {
        return;
      }

      await endTransform(stream);
    },
  };
}

async function endTransform(stream: Transform): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      stream.off('end', onEnd);
      stream.off('finish', onFinish);
      stream.off('error', onError);
    };
    const resolveOnce = () => {
      cleanup();
      resolvePromise();
    };
    const onEnd = resolveOnce;
    const onFinish = resolveOnce;
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once('end', onEnd);
    stream.once('finish', onFinish);
    stream.once('error', onError);
    stream.end();
  });
}

async function endStream(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableFinished) {
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
