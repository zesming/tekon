import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from 'node:child_process';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Fake provider binaries shared by CLI and Web tests. Each fake reads the
 * Tekon prompt from stdin (or after `--`), writes schema-valid artifacts for
 * every "Required artifact types:" entry and a manifest at
 * TEKON_ARTIFACT_MANIFEST, so the run can pass its gates.
 *
 * The fakes are extensionless CommonJS scripts: put `binDir` in a temp dir,
 * never under a `"type": "module"` package, or `require` is undefined.
 */
export type FakeProviderBehavior =
  /** Write all artifacts and exit 0. */
  | 'success'
  /** Print a login hint on stderr and exit 1 (Claude also prints an is_error result line). */
  | 'not-authenticated'
  /** Exit 1 on the first run (marker file), then behave like success. */
  | 'fail-once'
  /** Wait until `releaseFile` exists (exit 124 after 60s), then behave like success. */
  | 'slow'
  /** Exit 0 without writing any artifact. */
  | 'missing-artifact';

export interface FakeProviderOptions {
  behavior?: FakeProviderBehavior;
  /** Printed for `--version`. */
  version?: string;
  /** Answer for `auth status --json` (Claude). Defaults to a logged-in subscription. */
  auth?: { loggedIn: boolean; authMethod?: string };
  /** Each invocation appends one JSON line `{ argv, envKeys }` (env names only, no values). */
  captureFile?: string;
  /** `fail-once` marker. Defaults to a file next to the binary. */
  failOnceMarker?: string;
  /** `slow` release file. Defaults to a file next to the binary. */
  releaseFile?: string;
}

export interface FakeCodexOptions extends FakeProviderOptions {
  /** Profile the fake requires before `exec`; null accepts any (or none). */
  expectProfile?: string | null;
}

export function writeFakeCodex(
  binDir: string,
  options: FakeCodexOptions = {},
): string {
  const expectProfile =
    options.expectProfile === undefined ? 'internal' : options.expectProfile;
  const profileCheck =
    expectProfile === null
      ? ''
      : `if (args.indexOf('--profile') === -1 || args.indexOf('--profile') > execIndex || args[args.indexOf('--profile') + 1] !== ${JSON.stringify(expectProfile)}) {
  console.error(${JSON.stringify(`expected ${expectProfile} profile before exec, got: `)} + args.join(' '));
  process.exit(2);
}
`;
  const body = `const execIndex = args.indexOf('exec');
if (execIndex === -1) {
  console.error('expected codex exec, got: ' + args.join(' '));
  process.exit(2);
}
${profileCheck}if (args.indexOf('--ask-for-approval') === -1 || args.indexOf('--ask-for-approval') > execIndex) {
  console.error('expected approval before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--sandbox') === -1 || args.indexOf('--sandbox') > execIndex) {
  console.error('expected sandbox before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--add-dir') === -1 || args.indexOf('--add-dir') > execIndex || args[args.indexOf('--add-dir') + 1] !== process.env.TEKON_OUTPUT_DIR) {
  console.error('expected controlled artifact output add-dir before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.includes('danger-full-access') || args.includes('--dangerously-bypass-approvals-and-sandbox')) {
  console.error('unsafe codex args');
  process.exit(3);
}
function notAuthenticated() {
  console.error('Not logged in. Run codex login.');
  process.exit(1);
}
function done() {
  console.log('fake codex completed');
}
`;
  return writeFake(binDir, 'codex', 'Codex', options, body);
}

export function writeFakeClaude(
  binDir: string,
  options: FakeProviderOptions = {},
): string {
  const auth = options.auth ?? { loggedIn: true, authMethod: 'claude.ai' };
  const authJson = JSON.stringify({
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod ?? (auth.loggedIn ? 'claude.ai' : 'none'),
    apiProvider: 'firstParty',
    // Identity fields are present so tests can assert Tekon never prints them.
    ...(auth.loggedIn
      ? { email: 'fake-user@example.invalid', orgName: 'Fake Org' }
      : {}),
  });
  const body = `if (args[0] === 'auth' && args[1] === 'status') {
  console.log(${JSON.stringify(authJson)});
  process.exit(${auth.loggedIn ? 0 : 1});
}
const json = args[args.indexOf('--output-format') + 1] === 'json';
function resultLine(isError, text) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
}
function notAuthenticated() {
  console.error('Invalid API key · Please run /login');
  if (json) console.log(resultLine(true, 'Invalid API key · Please run /login'));
  process.exit(1);
}
function done() {
  console.log(json ? resultLine(false, 'fake claude completed') : 'fake claude completed');
}
`;
  return writeFake(binDir, 'claude', 'Claude', options, body);
}

/**
 * Creates a temp bin dir holding only `node` and `git` symlinks, for PATH
 * isolation: a provider missing from this dir is "not installed" no matter
 * what the host has. Caller owns cleanup.
 */
export function createIsolatedBinDir(prefix = 'tekon-isolated-bin-'): string {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(process.execPath, join(binDir, 'node'));
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitPath, join(binDir, 'git'));
  return binDir;
}

export interface RunCliWithEnvOptions {
  cwd: string;
  /** Prepended to PATH. With `isolatePath`, PATH is exactly these dirs. */
  binDirs?: string[];
  /**
   * Hermetic child env: PATH is only `binDirs`, HOME is `home`, global and
   * system git config are ignored, and host provider/Tekon variables
   * (ANTHROPIC_*, CLAUDE_*, OPENAI_*, CODEX_*, TEKON_*) are dropped.
   * `env` is applied afterwards, so a test can inject exactly what it needs.
   */
  isolatePath?: boolean;
  /** Required with `isolatePath`; caller owns cleanup. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const HOST_PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'CODEX_',
  'TEKON_',
];

export function buildCliEnv(options: RunCliWithEnvOptions): NodeJS.ProcessEnv {
  const binDirs = options.binDirs ?? [];
  if (!options.isolatePath) {
    return {
      ...process.env,
      ...options.env,
      PATH: [...binDirs, process.env.PATH ?? ''].join(delimiter),
    };
  }
  if (!options.home) {
    throw new Error('isolatePath requires a temp home dir');
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !HOST_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
  return {
    ...inherited,
    HOME: options.home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...options.env,
    PATH: binDirs.join(delimiter),
  };
}

/** Runs the built CLI in a real child process and waits for it to exit. */
export function runCliWithEnv(
  cliPath: string,
  args: string[],
  options: RunCliWithEnvOptions,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env: buildCliEnv(options),
  });
}

/**
 * Starts the built CLI without waiting, for tests that act while a run is in
 * flight (pause, cancel, release a `slow` fake). Caller must await exit or kill.
 */
export function spawnCliWithEnv(
  cliPath: string,
  args: string[],
  options: Omit<RunCliWithEnvOptions, 'timeoutMs'>,
): ChildProcess {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: buildCliEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeFake(
  binDir: string,
  name: string,
  label: string,
  options: FakeProviderOptions,
  providerBody: string,
): string {
  const behavior = options.behavior ?? 'success';
  const failOnceMarker =
    options.failOnceMarker ?? join(binDir, `.${name}-failed-once`);
  const releaseFile = options.releaseFile ?? join(binDir, `.${name}-release`);
  const scriptPath = join(binDir, name);
  const script = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const captureFile = ${JSON.stringify(options.captureFile ?? null)};
if (captureFile) {
  appendFileSync(captureFile, JSON.stringify({ argv: args, envKeys: Object.keys(process.env).sort() }) + '\\n');
}
const dashIndex = args.indexOf('--');
const flags = dashIndex === -1 ? args : args.slice(0, dashIndex);
if (flags.includes('--version')) {
  console.log(${JSON.stringify(options.version ?? `fake-${name} 1.0.0`)});
  process.exit(0);
}
${providerBody}
const behavior = ${JSON.stringify(behavior)};
let prompt = dashIndex === -1 ? '' : args.slice(dashIndex + 1).join(' ');
// Runs after stdin is fully read, like a real CLI, so an early exit never
// turns into a broken pipe on the writer side.
function start() {
  if (behavior === 'not-authenticated') notAuthenticated();
  if (behavior === 'fail-once' && !existsSync(${JSON.stringify(failOnceMarker)})) {
    writeFileSync(${JSON.stringify(failOnceMarker)}, 'failed');
    console.error(${JSON.stringify(`${label} fixture failed on first attempt`)});
    process.exit(1);
  }
  waitForRelease();
}
const releaseDeadline = Date.now() + 60000;
function finish() {
  const outputDir = process.env.TEKON_OUTPUT_DIR;
  const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;
  if (!outputDir || !manifestPath) {
    console.error('missing Tekon artifact environment');
    process.exit(4);
  }
  if (behavior === 'missing-artifact') {
    done();
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  ${ARTIFACT_WRITER.replaceAll('__LABEL__', label).replaceAll('__NAME__', name)}
  writeFileSync(manifestPath, JSON.stringify({ artifacts }));
  done();
}
function waitForRelease() {
  if (behavior !== 'slow' || existsSync(${JSON.stringify(releaseFile)})) {
    finish();
    return;
  }
  if (Date.now() > releaseDeadline) {
    console.error('release file never appeared');
    process.exit(124);
  }
  setTimeout(waitForRelease, 50);
}
if (dashIndex !== -1 || process.stdin.isTTY) {
  start();
} else {
  process.stdin.on('data', (chunk) => {
    prompt += chunk;
  });
  process.stdin.on('end', start);
}
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Writes one schema-valid artifact per required type; defines `artifacts`. */
const ARTIFACT_WRITER = `const types = Array.from(new Set((prompt.match(/Required artifact types: ([^\\.]+)/) || ['', ''])[1].split(',').map((item) => item.trim()).filter(Boolean)));
  const deliveryRef = (prompt.match(/exact tested delivery ref: ([^\\.\\n]+)/) || ['', '__NAME__-fixture-ref'])[1];
  const artifacts = types.map((type) => {
    const filename = type + '.json';
    const base = {
      title: type + ' artifact',
      body: '__LABEL__ fixture artifact for ' + type + '.',
      summary: '__LABEL__ fixture artifact for ' + type + '.'
    };
    let payload = base;
    if (type === 'demand-card' || type === 'prd') {
      payload = {
        ...base,
        acceptanceCriteria: [{
          id: 'AC-1',
          description: 'The __LABEL__ provider run stores a resumable provider snapshot.',
          verification: 'Inspect run_provider_configs for the provider.'
        }]
      };
    } else if (type === 'test-report' || type === 'review-report' || type === 'delivery-package') {
      payload = {
        ...base,
        criteriaEvidence: [{
          criterionId: 'AC-1',
          status: 'passed',
          evidence: '__LABEL__ fixture produced schema-valid evidence for ' + type + '.'
        }]
      };
    } else if (type === 'qa-release-signoff') {
      payload = {
        ...base,
        targetRef: deliveryRef,
        validatedRef: deliveryRef,
        overallStatus: 'passed',
        criteriaEvidence: [{
          criterionId: 'AC-1',
          status: 'passed',
          evidence: '__LABEL__ fixture QA signoff validates ' + deliveryRef + '.',
          outputPaths: [join(outputDir, filename)]
        }]
      };
    } else if (type === 'security-report') {
      payload = { ...base, securityFindings: [] };
    }
    writeFileSync(join(outputDir, filename), JSON.stringify(payload));
    return { type, path: filename, summary: '__LABEL__ fixture artifact for ' + type + '.' };
  });`;
