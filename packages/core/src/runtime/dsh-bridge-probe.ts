// ---------------------------------------------------------------------------
// dsh bridge probe (phase 5b). Version pin + capability contract checks for the
// external `dsh` CLI. Every function here is PURE (operates on strings the
// caller captured from `dsh --version` / `--help` / `--dump-default-config`),
// so the L1 fixture contract test can exercise the full parser without spawning
// a process. The adapter factory (dsh-headless-adapter.ts) is the only place
// that actually spawns dsh and feeds these outputs in.
//
// Boundary rationale (design §3): the dsh headless CLI contract (argv → stdout/
// stderr/exit-code) is the only documented, machine-consumable surface of the
// rc package. We pin the exact tested version and fail closed on drift rather
// than bind any private library export or file layout.
// ---------------------------------------------------------------------------

/** The exact dsh version this bridge was built and tested against (design §5.1). */
export const TESTED_DSH_VERSION = '0.1.1-rc.2';

/**
 * Plugin ids that MUST appear in `dsh --profile headless --dump-default-config`.
 * Their presence is the capability contract (design §5.2): headless runner,
 * the sandbox/approval governance seams we pin, the session store, and the
 * default model. Their disappearance means the headless composition drifted and
 * a human must re-verify the boundary before trusting it.
 */
export const REQUIRED_DSH_PLUGIN_IDS = [
  'headless-runner',
  'sandbox-policy',
  'user-approval',
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
 * Raised when a capability contract check fails — the dsh CLI is present and
 * the version matched, but its documented behavior surface (help anchor,
 * plugin composition) drifted from what the ACL was built against.
 */
export class DshCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshCapabilityError';
  }
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

/**
 * Verify the headless default-config dump still contains every required plugin
 * id (design §5.2). The dump format is NOT a schema we bind — we only assert
 * substring presence of each id, which is the deliberately loose contract:
 * a required id disappearing means the composition drifted.
 */
export function assertDshDefaultConfigContract(dumpOutput: string): void {
  for (const id of REQUIRED_DSH_PLUGIN_IDS) {
    if (!dumpOutput.includes(id)) {
      throw new DshCapabilityError(
        `dsh headless default config is missing the required plugin id ` +
          `'${id}'. The headless composition drifted from the tested contract; ` +
          `a human must re-verify the sandbox/approval/session boundary.`,
      );
    }
  }
}
