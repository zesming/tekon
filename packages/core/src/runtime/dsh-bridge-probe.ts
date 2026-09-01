// ---------------------------------------------------------------------------
// dsh bridge probe (phase 5b). Version pin + capability contract checks for the
// external `dsh` CLI. Every function here is PURE (operates on strings the
// caller captured from `dsh --version` / `--help` / `--dump-default-config`),
// so the L1 fixture contract test can exercise the full parser without spawning
// a process. The adapter factory (dsh-headless-adapter.ts) and runDshPreflight
// feed these outputs in.
//
// Boundary rationale (design §3): the dsh headless CLI contract (argv → stdout/
// stderr/exit-code) is the only documented, machine-consumable surface of the
// rc package. We pin the exact tested version and fail closed on drift rather
// than bind any private library export or file layout.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

/**
 * Raised when the PATH `dsh` version does not match {@link TESTED_DSH_VERSION}
 * and no matching `allowVersion` escape hatch was provided. Never a silent
 * downgrade — the message names both the actual and the tested version plus the
 * escape hatch (design §5.1).
 */
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

/**
 * Raised when a capability contract check fails. `actualVersion` is populated
 * when version probing succeeded but the later help/config surface failed, so
 * callers do not misreport an installed dsh as "not installed".
 */
export class DshCapabilityError extends Error {
  constructor(
    message: string,
    readonly actualVersion: string | null = null,
  ) {
    super(message);
    this.name = 'DshCapabilityError';
  }
}

/**
 * Raised when the host Node.js runtime does not satisfy DSH's requirement.
 * Distinct from {@link DshCapabilityError} because no dsh binary has been
 * probed yet — the host itself is incompatible. `hostNodeVersion` lets callers
 * render a precise "host Node incompatible" message instead of misreporting
 * "dsh not installed".
 */
export class DshHostNodeError extends Error {
  constructor(readonly hostNodeVersion: string) {
    super(
      `host Node.js '${hostNodeVersion}' does not satisfy DSH requirement ` +
        `'${DSH_NODE_REQUIREMENT}' (odd Node release lines such as 23.x are ` +
        `not supported). Upgrade Node.js or set ` +
        `TEKON_DSH_ALLOW_HOST_NODE='${hostNodeVersion}' to bypass this check ` +
        `at your own risk.`,
    );
    this.name = 'DshHostNodeError';
  }
}

/**
 * Pure host Node.js version compatibility check. Returns true when the host
 * satisfies DSH's runtime requirement. Pre-release suffixes are tolerated
 * (only the numeric major.minor segment is compared); unparseable input
 * returns false (fail-closed).
 */
export function isHostNodeVersionCompatible(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (Number.isNaN(major) || Number.isNaN(minor)) return false;
  if (major >= 24) return true;
  if (major === 22 && minor >= 19) return true;
  return false;
}

/**
 * Parse `dsh --version` stdout into a bare version string. Tolerates a leading
 * boot banner by taking the last non-empty trimmed line.
 */
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

/**
 * Enforce the version pin. Throws {@link DshVersionGateError} unless the actual
 * version equals {@link TESTED_DSH_VERSION} or an explicit, exactly-matching
 * `allowVersion` escape hatch is provided (which logs a warning via onWarn).
 */
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

/**
 * Verify `dsh --profile headless --help` still advertises the stdout contract
 * this bridge relies on (a single final assistant message on stdout).
 */
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

/**
 * Verify the headless default-config YAML still contains every required row id.
 * `dsh --dump-default-config` is a documented YAML composition dump. Matching
 * complete `id:` rows prevents a package name such as
 * `@deepseek-ai/dsh-user-approval` from falsely satisfying the contract when
 * the actual config row id is absent or renamed.
 */
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
  hostNodeVersion: string;
  hostNodeCompatible: boolean;
  hostNodeBypassed: boolean;
}

export interface RunDshPreflightOptions {
  probeVersion?: (command: string) => Promise<string>;
  probeHelp?: (command: string) => Promise<string>;
  probeConfig?: (command: string) => Promise<string>;
  allowVersion?: string;
  onWarn?: (message: string) => void;
  /** Test injection: override the host Node.js version (defaults to process.versions.node). */
  hostNodeVersion?: string;
}

async function defaultProbeVersion(command: string): Promise<string> {
  const { stdout } = await execFileAsync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return stdout;
}

async function defaultProbeHelp(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    command,
    ['--profile', 'headless', '--help'],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  return stdout;
}

async function defaultProbeConfig(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    command,
    ['--profile', 'headless', '--dump-default-config'],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  return stdout;
}

/**
 * Run DSH preflight probe: checks version, headless help contract, and plugin composition.
 */
export async function runDshPreflight(
  dshCommand = 'dsh',
  options?: RunDshPreflightOptions,
): Promise<DshPreflightResult> {
  const probeVersion = options?.probeVersion ?? defaultProbeVersion;
  const probeHelp = options?.probeHelp ?? defaultProbeHelp;
  const probeConfig = options?.probeConfig ?? defaultProbeConfig;

  const hostNodeVersion = options?.hostNodeVersion ?? process.versions.node;
  let hostNodeCompatible = isHostNodeVersionCompatible(hostNodeVersion);
  let hostNodeBypassed = false;
  if (!hostNodeCompatible) {
    const allowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;
    if (allowHostNode === hostNodeVersion) {
      hostNodeCompatible = true;
      hostNodeBypassed = true;
      options?.onWarn?.(
        `[dsh bridge] host Node check bypassed via TEKON_DSH_ALLOW_HOST_NODE='${hostNodeVersion}'`,
      );
    } else {
      throw new DshHostNodeError(hostNodeVersion);
    }
  }

  const rawVersion = await probeVersion(dshCommand);
  const actualVersion = parseDshVersion(rawVersion);
  const allowVersion =
    options?.allowVersion ?? process.env.TEKON_DSH_ALLOW_VERSION;
  assertDshVersionAllowed(actualVersion, {
    allowVersion,
    onWarn: options?.onWarn,
  });

  try {
    const [rawHelp, rawConfig] = await Promise.all([
      probeHelp(dshCommand),
      probeConfig(dshCommand),
    ]);

    assertDshHeadlessHelpContract(rawHelp);
    assertDshDefaultConfigContract(rawConfig);
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
    hostNodeVersion,
    hostNodeCompatible,
    hostNodeBypassed,
  };
}
