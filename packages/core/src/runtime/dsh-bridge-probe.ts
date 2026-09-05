// ---------------------------------------------------------------------------
// dsh bridge probe (phase 5b). Version pin + capability contract checks for the
// external `dsh` CLI. Every parser/assertion here is deterministic; the probe
// runner is the only function that spawns a process.
//
// Boundary rationale (design §3): the dsh headless CLI contract (argv → stdout/
// stderr/exit-code) is the only documented, machine-consumable surface of the
// prerelease package. We pin the exact tested version and fail closed on drift
// rather than bind any private library export or file layout.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_DSH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Metadata probes must not receive the caller's full credential-bearing
 * environment. Keep only process discovery and home/temp/locale values needed
 * to start the installed CLI on supported platforms. DSH state roots are
 * replaced with paths inside a per-preflight workspace. In particular, do not
 * forward API keys, cloud credentials, proxy URLs, SSH agents, NODE_OPTIONS or
 * arbitrary npm_config values.
 */
const DSH_PROBE_SAFE_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'SystemDrive',
  'windir',
  'WINDIR',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
] as const;

/** The exact dsh version this bridge was built and tested against (design §5.1). */
export const TESTED_DSH_VERSION = '0.1.2-alpha.3';

/** DSH's own runtime prerequisite, which is stricter than Tekon's Node contract. */
export const DSH_NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';

/**
 * Copy/paste-safe install command for a compatible dsh build. Runtime
 * prerequisites are returned as a separate structured field instead of being
 * appended to the command, so JSON and automation consumers can execute this
 * value without parsing localized prose.
 */
export function dshInstallHint(version: string = TESTED_DSH_VERSION): string {
  return `npm install -g @deepseek-ai/dsh@${version}`;
}

/**
 * Config row ids that MUST appear in
 * `dsh --profile headless --dump-default-config`. Their presence is the
 * capability contract (design §5.2): headless runner, sandbox/approval
 * governance, session persistence, and the default model. These are row ids
 * from the composed YAML tree — not package-name substrings.
 */
export const REQUIRED_DSH_PLUGIN_IDS = [
  'headless-runner',
  'sandbox-policy',
  'approval',
  'session-persistence-jsonl',
  'agent-default-model',
] as const;

/** Documented stdout-contract anchor in `dsh --profile headless --help`. */
const HEADLESS_HELP_ANCHOR = 'print the final assistant message';

interface StableNodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the stable, complete Node version shape used by `process.versions.node`.
 * npm/node-semver excludes prereleases from ordinary range matching unless a
 * range explicitly opts into them, so `22.19.0-rc.1` must not satisfy
 * `^22.19.0`. Build metadata is harmless and remains accepted.
 */
function parseStableNodeVersion(version: string): StableNodeVersion | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      version.trim(),
    );
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

export class DshVersionGateError extends Error {
  constructor(
    readonly actualVersion: string,
    readonly testedVersion: string,
  ) {
    super(
      `dsh version mismatch: found '${actualVersion}', but this Tekon build was ` +
        `tested against '${testedVersion}'. The dsh bridge fails closed on ` +
        `untested versions because @deepseek-ai/dsh is a developer-preview ` +
        `release with explicit compatibility-breaking changes. To run anyway, ` +
        `set the escape hatch env TEKON_DSH_ALLOW_VERSION='${actualVersion}' ` +
        `and re-verify the contract manually first.`,
    );
    this.name = 'DshVersionGateError';
  }
}

export class DshCapabilityError extends Error {
  constructor(
    message: string,
    readonly actualVersion: string | null = null,
  ) {
    super(message);
    this.name = 'DshCapabilityError';
  }
}

export class DshHostNodeError extends Error {
  constructor(readonly hostNodeVersion: string) {
    const stable = parseStableNodeVersion(hostNodeVersion) !== null;
    super(
      `host Node.js '${hostNodeVersion}' does not satisfy DSH requirement ` +
        `'${DSH_NODE_REQUIREMENT}'. ` +
        (stable
          ? `Upgrade Node.js or set TEKON_DSH_ALLOW_HOST_NODE='${hostNodeVersion}' ` +
            `to acknowledge an unsupported stable host at your own risk.`
          : `Use a complete stable Node.js version; prerelease or malformed ` +
            `versions cannot be admitted by the escape hatch.`),
    );
    this.name = 'DshHostNodeError';
  }
}

export function isHostNodeVersionCompatible(version: string): boolean {
  const parsed = parseStableNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major >= 24) return true;
  return parsed.major === 22 && parsed.minor >= 19;
}

export function parseDshVersion(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (!last) {
    throw new DshCapabilityError(
      'could not parse a dsh version from empty `dsh --version` output',
    );
  }
  return last;
}

export function assertDshVersionAllowed(
  actualVersion: string,
  options: { allowVersion?: string; onWarn?: (message: string) => void },
): void {
  if (actualVersion === TESTED_DSH_VERSION) {
    return;
  }
  if (options.allowVersion && options.allowVersion === actualVersion) {
    options.onWarn?.(
      `dsh version '${actualVersion}' does not match the tested ` +
        `'${TESTED_DSH_VERSION}', but was explicitly allowed via allowVersion. ` +
        `Proceeding without contract guarantees.`,
    );
    return;
  }
  throw new DshVersionGateError(actualVersion, TESTED_DSH_VERSION);
}

export function assertDshHeadlessHelpContract(helpOutput: string): void {
  if (!helpOutput.toLowerCase().includes(HEADLESS_HELP_ANCHOR)) {
    throw new DshCapabilityError(
      `dsh headless --help no longer contains the documented stdout contract ` +
        `anchor ("${HEADLESS_HELP_ANCHOR}"). The output surface may have ` +
        `changed; re-verify the bridge before trusting it.`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsConfigRowId(dumpOutput: string, id: string): boolean {
  const escaped = escapeRegExp(id);
  const yamlRow = new RegExp(
    `^\\s*(?:-\\s*)?id:\\s*["']?${escaped}["']?\\s*$`,
    'mu',
  );
  return yamlRow.test(dumpOutput);
}

export function assertDshDefaultConfigContract(dumpOutput: string): void {
  for (const id of REQUIRED_DSH_PLUGIN_IDS) {
    if (!containsConfigRowId(dumpOutput, id)) {
      throw new DshCapabilityError(
        `dsh headless default config is missing the required plugin id ` +
          `'${id}'. The headless composition drifted from the tested contract; ` +
          `a human must re-verify the sandbox/approval/session boundary.`,
      );
    }
  }
}

export interface DshPreflightResult {
  testedVersion: string;
  actualVersion: string;
  nodeRequirement: string;
  helpContractOk: boolean;
  configContractOk: boolean;
  installHint: string;
  /** True only when the installed dsh exactly matches the tested pin. */
  versionCompatible: boolean;
  /** True when an untested version was admitted through an exact escape hatch. */
  versionBypassed: boolean;
  /** Actual range compatibility, not admission after an escape hatch. */
  hostNodeCompatible: boolean;
  /** Exact Node version assessed by this preflight. */
  hostNodeVersion: string;
  /** True only when an incompatible but parseable stable host was admitted. */
  hostNodeBypassed: boolean;
}

export interface RunDshPreflightOptions {
  probeVersion?: (command: string) => Promise<string>;
  probeHelp?: (command: string) => Promise<string>;
  probeConfig?: (command: string) => Promise<string>;
  /** Programmatic/test seam for probe execution environment snapshot; not exposed via CLI or RPC. */
  probeEnvSource?: NodeJS.ProcessEnv;
  /** Programmatic/test seam for resolving relative probe commands; not exposed via CLI or RPC. */
  probeInvocationCwd?: string;
  /** Programmatic/test seam for deterministic cleanup failure coverage. */
  probeCleanup?: (dir: string) => void | Promise<void>;
  allowVersion?: string;
  /** Programmatic/test seam; the CLI does not expose a host-version override. */
  hostNodeVersion?: string;
  /** Exact-match host escape hatch; defaults to TEKON_DSH_ALLOW_HOST_NODE. */
  allowHostNode?: string;
  /** Timeout for each built-in metadata probe. Custom probes own their budget. */
  probeTimeoutMs?: number;
  onWarn?: (message: string) => void;
}

/**
 * Constructs a minimal, isolated environment for built-in metadata probes.
 *
 * Metadata commands need PATH plus a small set of home/temp/locale values and
 * isolated DSH state roots. They do not need model credentials, cloud tokens,
 * proxy credentials, SSH agents or arbitrary Node/npm injection settings.
 * Telemetry is hard-disabled independently of the caller's environment.
 */
function buildProbeTelemetryEnv(
  workspace: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DSH_PROBE_SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.DSH_TELEMETRY_DISABLED = '1';
  env.DSH_HOME = join(workspace, 'dsh-home');
  env.DSH_AGENTS_HOME = join(workspace, 'agents-home');
  return env;
}

interface DefaultProbeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

async function defaultProbeVersion(
  command: string,
  options: DefaultProbeOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(command, ['--version'], {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    cwd: options.cwd,
    env: options.env,
  });
  return stdout;
}

async function defaultProbeHelp(
  command: string,
  options: DefaultProbeOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(
    command,
    ['--profile', 'headless', '--help'],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    },
  );
  return stdout;
}

async function defaultProbeConfig(
  command: string,
  options: DefaultProbeOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(
    command,
    ['--profile', 'headless', '--dump-default-config'],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    },
  );
  return stdout;
}

async function safeWarnCleanup(
  root: string,
  options?: RunDshPreflightOptions,
): Promise<void> {
  try {
    if (options?.probeCleanup) {
      await options.probeCleanup(root);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    try {
      options?.onWarn?.(
        `[dsh bridge] failed to clean up probe workspace: ${String(cleanupError)}`,
      );
    } catch {
      // A consumer warning callback must not replace the probe result/error.
    }
  }
}

export async function runDshPreflight(
  dshCommand = 'dsh',
  options?: RunDshPreflightOptions,
): Promise<DshPreflightResult> {
  const hostNodeVersion = options?.hostNodeVersion ?? process.versions.node;
  const hostNodeCompatible = isHostNodeVersionCompatible(hostNodeVersion);
  let hostNodeBypassed = false;
  if (!hostNodeCompatible) {
    const stableHost = parseStableNodeVersion(hostNodeVersion) !== null;
    const allowHostNode =
      options?.allowHostNode ?? process.env.TEKON_DSH_ALLOW_HOST_NODE;
    if (stableHost && allowHostNode === hostNodeVersion) {
      hostNodeBypassed = true;
      options?.onWarn?.(
        `[dsh bridge] host Node check bypassed via TEKON_DSH_ALLOW_HOST_NODE='${hostNodeVersion}'`,
      );
    } else {
      throw new DshHostNodeError(hostNodeVersion);
    }
  }

  const needsWorkspace =
    !options?.probeVersion || !options.probeConfig || !options.probeHelp;
  const root = needsWorkspace
    ? mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-'))
    : null;
  try {
    const probeTimeoutMs =
      options?.probeTimeoutMs ?? DEFAULT_DSH_PROBE_TIMEOUT_MS;
    const resolvedDshCommand =
      root && (dshCommand.includes('/') || dshCommand.includes('\\'))
        ? resolve(options?.probeInvocationCwd ?? process.cwd(), dshCommand)
        : dshCommand;
    const defaultOptions = root
      ? {
          cwd: root,
          env: buildProbeTelemetryEnv(root, options?.probeEnvSource),
          timeoutMs: probeTimeoutMs,
        }
      : null;

    const rawVersion = options?.probeVersion
      ? await options.probeVersion(dshCommand)
      : await defaultProbeVersion(resolvedDshCommand, defaultOptions!);
    const actualVersion = parseDshVersion(rawVersion);
    const versionCompatible = actualVersion === TESTED_DSH_VERSION;
    const allowVersion =
      options?.allowVersion ?? process.env.TEKON_DSH_ALLOW_VERSION;
    assertDshVersionAllowed(actualVersion, {
      allowVersion,
      onWarn: options?.onWarn,
    });
    const versionBypassed = !versionCompatible;

    try {
      // Both commands may auto-initialize the shipped headless profile in the
      // same DSH_HOME. Run them sequentially so a clean home cannot race two
      // writers during first-use profile creation.
      const rawConfig = options?.probeConfig
        ? await options.probeConfig(dshCommand)
        : await defaultProbeConfig(resolvedDshCommand, defaultOptions!);
      assertDshDefaultConfigContract(rawConfig);

      const rawHelp = options?.probeHelp
        ? await options.probeHelp(dshCommand)
        : await defaultProbeHelp(resolvedDshCommand, defaultOptions!);
      assertDshHeadlessHelpContract(rawHelp);
    } catch (error) {
      throw new DshCapabilityError(
        error instanceof Error ? error.message : String(error),
        actualVersion,
      );
    }

    return {
      testedVersion: TESTED_DSH_VERSION,
      actualVersion,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      helpContractOk: true,
      configContractOk: true,
      installHint: dshInstallHint(),
      versionCompatible,
      versionBypassed,
      hostNodeVersion,
      hostNodeCompatible,
      hostNodeBypassed,
    };
  } finally {
    if (root) {
      await safeWarnCleanup(root, options);
    }
  }
}
