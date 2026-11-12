import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { buildClaudeProviderEnv } from './claude-code-support.js';
import { buildCodexProviderEnv } from './codex-adapter.js';

/**
 * How a provider would authenticate if started now. Names only what kind of
 * credential is in effect; never its value.
 */
export type ProviderAuthKind =
  | 'api-key'
  | 'auth-token'
  | 'oauth-token'
  | 'subscription'
  /** Codex keeps a saved login in CODEX_HOME/auth.json (not read by Tekon). */
  | 'stored-login'
  | 'none'
  | 'unknown';

export type ProbedProvider = 'claude-code' | 'codex';

export interface ProviderProbe {
  provider: ProbedProvider;
  command: string;
  installed: boolean;
  auth: ProviderAuthKind;
  version?: string;
}

export interface ProviderProbeDeps {
  /** Environment the provider process would receive. */
  env?: NodeJS.ProcessEnv;
  /** Runs `<command> <args>` and returns stdout, or undefined on failure/timeout. */
  runCommand?: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => Promise<string | undefined>;
  fileExists?: (path: string) => boolean;
  timeoutMs?: number;
  /** Also ask for `--version` (doctor). */
  includeVersion?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PROBE_STDOUT = 64 * 1024;

export const DEFAULT_PROVIDER_COMMANDS: Record<ProbedProvider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

/** Resolves a command against PATH the way spawn would; undefined when absent. */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export async function probeProvider(
  provider: ProbedProvider,
  options: ProviderProbeDeps & { command?: string } = {},
): Promise<ProviderProbe> {
  const env = options.env ?? process.env;
  const command = options.command ?? DEFAULT_PROVIDER_COMMANDS[provider];
  const runCommand = options.runCommand ?? runProbeCommand;
  const fileExists = options.fileExists ?? existsSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const executable = findExecutable(command, env);
  if (!executable) {
    return { provider, command, installed: false, auth: 'unknown' };
  }
  const version = options.includeVersion
    ? firstLine(await runCommand(executable, ['--version'], env, timeoutMs))
    : undefined;
  const auth = provider === 'claude-code'
    ? claudeAuthKind(
        await runCommand(executable, ['auth', 'status', '--json'], env, timeoutMs),
        env,
      )
    : codexAuthKind(env, fileExists);
  return { provider, command, installed: true, auth, ...(version ? { version } : {}) };
}

/** Maps `claude auth status --json`; only loggedIn and authMethod are read. */
export function claudeAuthKind(
  stdout: string | undefined,
  env: NodeJS.ProcessEnv,
): ProviderAuthKind {
  if (stdout === undefined) return 'unknown';
  let parsed: { loggedIn?: unknown; authMethod?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return 'unknown';
  }
  if (parsed.loggedIn === false) return 'none';
  if (parsed.loggedIn !== true) return 'unknown';
  const method = typeof parsed.authMethod === 'string' ? parsed.authMethod.toLowerCase() : '';
  if (method === 'claude.ai' || method.includes('subscription')) return 'subscription';
  if (method.includes('api') && method.includes('key')) return 'api-key';
  if (method.includes('token') || method.includes('oauth')) {
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'oauth-token';
    if (env.ANTHROPIC_AUTH_TOKEN) return 'auth-token';
    return 'oauth-token';
  }
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  return 'unknown';
}

function codexAuthKind(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): ProviderAuthKind {
  if (env.OPENAI_API_KEY) return 'api-key';
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  return fileExists(join(codexHome, 'auth.json')) ? 'stored-login' : 'none';
}

/** Spawns a probe with an exact environment; stdout stays in memory. */
function runProbeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      // A neutral cwd keeps repository-level provider settings out of the probe.
      child = spawn(command, args, { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_STDOUT) stdout += chunk.toString('utf8');
    });
    child.once('error', () => finish(undefined));
    // `auth status` exits non-zero when logged out but still prints JSON.
    child.once('close', () => finish(stdout));
  });
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r?\n/u).find((item) => item.trim());
  return line?.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Preflight: the check every start and resume runs before work is queued.
// ---------------------------------------------------------------------------

export interface ProviderPreflightInput {
  provider: string;
  phase: 'start' | 'resume';
  /** Frozen provider config summary (command, passthroughEnv). */
  configSummary?: Record<string, unknown>;
}

export interface ProviderPreflightResult {
  provider: ProbedProvider;
  auth: ProviderAuthKind;
  /** Names of variables passed through to the provider (never values). */
  passthroughEnv: string[];
  /** Non-blocking notices for the person starting the run. */
  warnings: string[];
}

export type ProviderPreflight = (
  input: ProviderPreflightInput,
) => Promise<ProviderPreflightResult | undefined>;

export class ProviderPreflightError extends Error {
  readonly code = 'PROVIDER_NOT_INSTALLED';
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'ProviderPreflightError';
  }
}

const AUTH_NONE_HINT: Record<ProbedProvider, string> = {
  'claude-code': '执行 claude auth login（或在 claude 里输入 /login），或在启动 Tekon 的环境里配置 ANTHROPIC_API_KEY',
  codex: '执行 codex login，或在启动 Tekon 的环境里配置 OPENAI_API_KEY',
};

export function isProbedProvider(provider: string): provider is ProbedProvider {
  return provider === 'claude-code' || provider === 'codex';
}

/**
 * Builds the start/resume preflight. A missing provider command refuses the
 * run; a missing login only warns, since credentials may come from places a
 * probe cannot see.
 */
export function createProviderPreflight(
  deps: ProviderProbeDeps & {
    probe?: typeof probeProvider;
  } = {},
): ProviderPreflight {
  return async ({ provider, configSummary }) => {
    if (!isProbedProvider(provider)) return undefined;
    const passthroughEnv = stringArray(configSummary?.passthroughEnv);
    const command = typeof configSummary?.command === 'string'
      ? configSummary.command
      : DEFAULT_PROVIDER_COMMANDS[provider];
    const source = deps.env ?? process.env;
    const env = provider === 'claude-code'
      ? buildClaudeProviderEnv(source, passthroughEnv)
      : buildCodexProviderEnv(source, passthroughEnv);
    const probe = await (deps.probe ?? probeProvider)(provider, { ...deps, env, command });
    if (!probe.installed) {
      throw new ProviderPreflightError(
        `找不到 ${command} 命令。Tekon 按启动它的终端或服务进程的 PATH 查找 provider，这个 PATH 里没有 ${command}`,
        `安装 ${command}，或从能执行 ${command} 的终端重新启动 Tekon；运行 tekon doctor 查看详情`,
      );
    }
    const warnings = probe.auth === 'none'
      ? [`${command} 未检测到登录或凭据：${AUTH_NONE_HINT[provider]}`]
      : [];
    return { provider, auth: probe.auth, passthroughEnv, warnings };
  };
}

/** Audit payload for a preflight; names and categories only. */
export function providerPreflightAuditPayload(
  phase: 'start' | 'resume',
  result: ProviderPreflightResult,
): Record<string, unknown> {
  return {
    phase,
    provider: result.provider,
    auth: result.auth,
    ...(result.passthroughEnv.length > 0 ? { passthroughEnv: result.passthroughEnv } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
