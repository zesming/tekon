import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_DSH_PLUGIN_IDS,
  TESTED_DSH_VERSION,
  runDshPreflight,
  type RunDshPreflightOptions,
} from '../../src/index.js';

interface ProbeExecutionRecord {
  argv: string[];
  DSH_TELEMETRY_DISABLED?: string;
  DSH_TELEMETRY_MODE?: string;
  DSH_TELEMETRY_OTLP_URL?: string;
  PATH?: string;
  DSH_HOME?: string;
  DSH_AGENTS_HOME?: string;
  cwd: string;
}

/**
 * Creates an executable fake dsh binary that conforms to the default probe contract:
 * - `--version` -> outputs tested pin version (TESTED_DSH_VERSION)
 * - `--profile headless --help` -> stdout containing the documented help anchor
 * - `--profile headless --dump-default-config` -> YAML tree containing the 5 required plugin IDs
 *
 * Appends observed environment variables (DSH_TELEMETRY_DISABLED, DSH_TELEMETRY_MODE,
 * DSH_TELEMETRY_OTLP_URL, PATH, DSH_HOME, DSH_AGENTS_HOME and cwd) to a
 * temporary JSONL log file on each invocation.
 */
function createFakeDsh(tempDir: string): {
  fakeDshPath: string;
  logFilePath: string;
} {
  const logFilePath = join(tempDir, 'probe-env-records.jsonl');
  const fakeDshPath = join(tempDir, 'fake-dsh.mjs');

  const scriptContent = `#!${process.execPath}
import { appendFileSync } from 'node:fs';

const logFilePath = ${JSON.stringify(logFilePath)};
const entry = {
  argv: process.argv.slice(2),
  DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
  DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE,
  DSH_TELEMETRY_OTLP_URL: process.env.DSH_TELEMETRY_OTLP_URL,
  PATH: process.env.PATH,
  DSH_HOME: process.env.DSH_HOME,
  DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
  cwd: process.cwd(),
};

appendFileSync(logFilePath, JSON.stringify(entry) + '\\n', 'utf8');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${TESTED_DSH_VERSION}\n`)});
  process.exit(0);
}
if (args.includes('--dump-default-config')) {
  const config = ${JSON.stringify(
    ['plugins:', ...REQUIRED_DSH_PLUGIN_IDS.map((id) => `  - id: ${id}`)].join(
      '\n',
    ) + '\n',
  )};
  process.stdout.write(config);
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: dsh --profile headless [options] [task...]\\n' +
    'Answer one task, print the final assistant message, and exit.\\n',
  );
  process.exit(0);
}

process.stderr.write('unexpected fake dsh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;

  writeFileSync(fakeDshPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
  chmodSync(fakeDshPath, 0o755);
  return { fakeDshPath, logFilePath };
}

function readRecordedEntries(logFilePath: string): ProbeExecutionRecord[] {
  try {
    const raw = readFileSync(logFilePath, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ProbeExecutionRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

describe('dsh bridge probe telemetry environment', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('default probes strip ambient telemetry variables, replace DSH homes, and hard-disable telemetry', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-ambient-'));
    tempDirs.push(tempDir);
    const { fakeDshPath, logFilePath } = createFakeDsh(tempDir);

    const expectedDshHome = join(tempDir, 'fake-dsh-home');
    const priorDisabled = process.env.DSH_TELEMETRY_DISABLED;
    const priorMode = process.env.DSH_TELEMETRY_MODE;
    const priorOtlpUrl = process.env.DSH_TELEMETRY_OTLP_URL;
    const priorHome = process.env.DSH_HOME;

    try {
      // Upstream treats any non-empty value of DSH_TELEMETRY_DISABLED as disabled.
      // Ambient '0' does not enable telemetry; fixing child env to '1' is Tekon's canonical normalization.
      process.env.DSH_TELEMETRY_DISABLED = '0';
      process.env.DSH_TELEMETRY_MODE = 'FULL';
      process.env.DSH_TELEMETRY_OTLP_URL = 'https://collector.invalid/v1/logs';
      process.env.DSH_HOME = expectedDshHome;

      const result = await runDshPreflight(fakeDshPath, {
        hostNodeVersion: '22.19.0',
      });

      expect(result.versionCompatible).toBe(true);
      expect(result.helpContractOk).toBe(true);
      expect(result.configContractOk).toBe(true);

      const entries = readRecordedEntries(logFilePath);
      expect(entries).toHaveLength(3);

      const versionEntry = entries.find((e) => e.argv.includes('--version'));
      const helpEntry = entries.find((e) => e.argv.includes('--help'));
      const configEntry = entries.find((e) =>
        e.argv.includes('--dump-default-config'),
      );

      expect(versionEntry).toBeDefined();
      expect(helpEntry).toBeDefined();
      expect(configEntry).toBeDefined();

      for (const entry of [versionEntry!, helpEntry!, configEntry!]) {
        expect(entry.DSH_TELEMETRY_DISABLED).toBe('1');
        expect(entry.DSH_TELEMETRY_MODE).toBeUndefined();
        expect(entry.DSH_TELEMETRY_OTLP_URL).toBeUndefined();
        expect(entry.PATH).toBe(process.env.PATH);
        expect(entry.DSH_HOME).not.toBe(expectedDshHome);
        expect(dirname(entry.DSH_HOME!)).toBe(entry.cwd);
        expect(entry.DSH_AGENTS_HOME).toBe(join(entry.cwd, 'agents-home'));
      }
    } finally {
      if (priorDisabled === undefined)
        delete process.env.DSH_TELEMETRY_DISABLED;
      else process.env.DSH_TELEMETRY_DISABLED = priorDisabled;
      if (priorMode === undefined) delete process.env.DSH_TELEMETRY_MODE;
      else process.env.DSH_TELEMETRY_MODE = priorMode;
      if (priorOtlpUrl === undefined) delete process.env.DSH_TELEMETRY_OTLP_URL;
      else process.env.DSH_TELEMETRY_OTLP_URL = priorOtlpUrl;
      if (priorHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = priorHome;
    }
  });

  it('default probes respect programmatic probeEnvSource seam and isolate telemetry', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-source-'));
    tempDirs.push(tempDir);
    const { fakeDshPath, logFilePath } = createFakeDsh(tempDir);

    const customDshHome = join(tempDir, 'custom-dsh-home');
    const customPath = process.env.PATH ?? '/bin:/usr/bin';

    const options: RunDshPreflightOptions = {
      hostNodeVersion: '22.19.0',
      probeEnvSource: {
        PATH: customPath,
        DSH_HOME: customDshHome,
        DSH_TELEMETRY_DISABLED: '0',
        DSH_TELEMETRY_MODE: 'FULL',
        DSH_TELEMETRY_OTLP_URL: 'https://collector.invalid/v1/logs',
      },
    };

    const result = await runDshPreflight(fakeDshPath, options);

    expect(result.versionCompatible).toBe(true);
    expect(result.helpContractOk).toBe(true);
    expect(result.configContractOk).toBe(true);

    const entries = readRecordedEntries(logFilePath);
    expect(entries).toHaveLength(3);

    const versionEntry = entries.find((e) => e.argv.includes('--version'));
    const helpEntry = entries.find((e) => e.argv.includes('--help'));
    const configEntry = entries.find((e) =>
      e.argv.includes('--dump-default-config'),
    );

    expect(versionEntry).toBeDefined();
    expect(helpEntry).toBeDefined();
    expect(configEntry).toBeDefined();

    for (const entry of [versionEntry!, helpEntry!, configEntry!]) {
      expect(entry.DSH_TELEMETRY_DISABLED).toBe('1');
      expect(entry.DSH_TELEMETRY_MODE).toBeUndefined();
      expect(entry.DSH_TELEMETRY_OTLP_URL).toBeUndefined();
      expect(entry.PATH).toBe(customPath);
      expect(entry.DSH_HOME).not.toBe(customDshHome);
      expect(dirname(entry.DSH_HOME!)).toBe(entry.cwd);
      expect(entry.DSH_AGENTS_HOME).toBe(join(entry.cwd, 'agents-home'));
    }
  });
});
