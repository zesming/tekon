import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DshCapabilityError,
  REQUIRED_DSH_PLUGIN_IDS,
  TESTED_DSH_VERSION,
  runDshPreflight,
} from '../../src/index.js';

const execFileAsync = promisify(execFile);

interface RecordedProbe {
  argv: string[];
  cwd: string;
  PATH?: string;
  HOME?: string;
  DSH_HOME?: string;
  DSH_AGENTS_HOME?: string;
  DSH_TELEMETRY_DISABLED?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  GH_TOKEN?: string;
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
  SSH_AUTH_SOCK?: string;
  NODE_OPTIONS?: string;
  LD_PRELOAD?: string;
  LD_LIBRARY_PATH?: string;
  DYLD_INSERT_LIBRARIES?: string;
  npm_config_registry?: string;
  DSH_PERMISSION_MODE?: string;
  SystemDrive?: string;
  windir?: string;
  WINDIR?: string;
  cwdDotEnv?: string;
  dshHomeDotEnv?: string;
  dshCredentials?: string;
}

function createRecordingDsh(
  tempDir: string,
  options: { validConfig?: boolean } = {},
): { executable: string; logPath: string } {
  const executable = join(tempDir, 'recording-dsh.mjs');
  const logPath = join(tempDir, 'probe-env.jsonl');
  const configIds =
    options.validConfig === false
      ? REQUIRED_DSH_PLUGIN_IDS.slice(1)
      : REQUIRED_DSH_PLUGIN_IDS;
  const config = [
    'plugins:',
    ...configIds.map((id) => `  - id: ${id}`),
    '',
  ].join('\n');

  writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      `import { appendFileSync, readFileSync } from 'node:fs';\n` +
      `import { join } from 'node:path';\n` +
      `const readOptional = (path) => {\n` +
      `  try { return readFileSync(path, 'utf8'); }\n` +
      `  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }\n` +
      `};\n` +
      `const keys = ${JSON.stringify([
        'PATH',
        'HOME',
        'DSH_HOME',
        'DSH_AGENTS_HOME',
        'DSH_TELEMETRY_DISABLED',
        'DEEPSEEK_API_KEY',
        'OPENAI_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'GH_TOKEN',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'SSH_AUTH_SOCK',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'npm_config_registry',
        'DSH_PERMISSION_MODE',
        'SystemDrive',
        'windir',
        'WINDIR',
      ])};\n` +
      `const entry = {\n` +
      `  argv: process.argv.slice(2),\n` +
      `  cwd: process.cwd(),\n` +
      `  ...Object.fromEntries(keys.map((key) => [key, process.env[key]])),\n` +
      `  cwdDotEnv: readOptional(join(process.cwd(), '.env')),\n` +
      `  dshHomeDotEnv: process.env.DSH_HOME ? readOptional(join(process.env.DSH_HOME, '.env')) : undefined,\n` +
      `  dshCredentials: process.env.DSH_HOME ? readOptional(join(process.env.DSH_HOME, '.credentials.yaml')) : undefined,\n` +
      `};\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + '\\n', 'utf8');\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.includes('--version')) process.stdout.write(${JSON.stringify(
        `${TESTED_DSH_VERSION}\n`,
      )});\n` +
      `else if (args.includes('--dump-default-config')) process.stdout.write(${JSON.stringify(
        config,
      )});\n` +
      `else if (args.includes('--help')) process.stdout.write('print the final assistant message\\n');\n` +
      `else process.exitCode = 1;\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  chmodSync(executable, 0o755);
  return { executable, logPath };
}

function readProbeRecords(logPath: string): RecordedProbe[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedProbe);
}

function validConfig(): string {
  return REQUIRED_DSH_PLUGIN_IDS.map((id) => `- id: ${id}`).join('\n');
}

function assertIsolatedWorkspace(records: RecordedProbe[]): string {
  expect(records.length).toBeGreaterThan(0);
  const root = records[0]!.cwd;
  for (const record of records) {
    expect(record.cwd).toBe(root);
    expect(record.DSH_HOME).toBe(join(root, 'dsh-home'));
    expect(record.DSH_AGENTS_HOME).toBe(join(root, 'agents-home'));
  }
  return root;
}

describe('dsh metadata probe isolation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses one isolated workspace for all default probes and resolves a relative command before changing cwd', async () => {
    const callerDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-caller-'));
    tempDirs.push(callerDir);
    const { logPath } = createRecordingDsh(callerDir);

    await runDshPreflight('./recording-dsh.mjs', {
      hostNodeVersion: '22.19.0',
      probeInvocationCwd: callerDir,
      probeEnvSource: {
        PATH: process.env.PATH,
        SystemDrive: 'C:',
        windir: 'C:\\Windows-lower',
        WINDIR: 'C:\\Windows-upper',
      },
    });

    const records = readProbeRecords(logPath);
    expect(records).toHaveLength(3);
    const root = assertIsolatedWorkspace(records);
    for (const record of records) {
      expect(record.SystemDrive).toBe('C:');
      expect(record.windir).toBe('C:\\Windows-lower');
      expect(record.WINDIR).toBe('C:\\Windows-upper');
    }
    expect(existsSync(root)).toBe(false);
  });

  it('cuts off ambient credentials and DSH home fallback files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-min-env-'));
    tempDirs.push(tempDir);
    const { executable, logPath } = createRecordingDsh(tempDir);
    const ambientDshHome = join(tempDir, 'ambient-dsh-home');
    mkdirSync(ambientDshHome);
    writeFileSync(
      join(ambientDshHome, '.env'),
      'DEEPSEEK_API_KEY=ambient-home-secret\n',
    );
    writeFileSync(
      join(ambientDshHome, '.credentials.yaml'),
      'deepseek: ambient-credential\n',
    );

    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(tempDir, 'home'),
      DSH_HOME: ambientDshHome,
      DSH_AGENTS_HOME: join(tempDir, 'ambient-agents-home'),
      DSH_TELEMETRY_DISABLED: '0',
      DSH_TELEMETRY_MODE: 'FULL',
      DSH_TELEMETRY_OTLP_URL: 'https://telemetry.invalid/v1/logs',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY: 'openai-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GH_TOKEN: 'github-secret',
      HTTPS_PROXY: 'https://proxy-user:proxy-pass@proxy.invalid',
      HTTP_PROXY: 'http://proxy-user:proxy-pass@proxy.invalid',
      ALL_PROXY: 'socks5://proxy.invalid',
      NO_PROXY: 'metadata.invalid',
      SSH_AUTH_SOCK: join(tempDir, 'ssh-agent.sock'),
      NODE_OPTIONS: '--require=/tmp/untrusted-hook.cjs',
      LD_PRELOAD: '/tmp/untrusted-preload.so',
      LD_LIBRARY_PATH: '/tmp/untrusted-libraries',
      DYLD_INSERT_LIBRARIES: '/tmp/untrusted-dylib.dylib',
      npm_config_registry: 'https://registry.invalid',
      DSH_PERMISSION_MODE: 'danger-full-access',
    };

    await runDshPreflight(executable, {
      hostNodeVersion: '22.19.0',
      probeEnvSource: source,
    });

    const records = readProbeRecords(logPath);
    const root = assertIsolatedWorkspace(records);
    for (const record of records) {
      expect(record.PATH).toBe(source.PATH);
      expect(record.HOME).toBe(source.HOME);
      expect(record.DSH_HOME).not.toBe(ambientDshHome);
      expect(record.DSH_TELEMETRY_DISABLED).toBe('1');
      expect(record.cwdDotEnv).toBeUndefined();
      expect(record.dshHomeDotEnv).toBeUndefined();
      expect(record.dshCredentials).toBeUndefined();
      expect(record.DEEPSEEK_API_KEY).toBeUndefined();
      expect(record.OPENAI_API_KEY).toBeUndefined();
      expect(record.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(record.GH_TOKEN).toBeUndefined();
      expect(record.HTTPS_PROXY).toBeUndefined();
      expect(record.HTTP_PROXY).toBeUndefined();
      expect(record.ALL_PROXY).toBeUndefined();
      expect(record.NO_PROXY).toBeUndefined();
      expect(record.SSH_AUTH_SOCK).toBeUndefined();
      expect(record.NODE_OPTIONS).toBeUndefined();
      expect(record.LD_PRELOAD).toBeUndefined();
      expect(record.LD_LIBRARY_PATH).toBeUndefined();
      expect(record.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(record.npm_config_registry).toBeUndefined();
      expect(record.DSH_PERMISSION_MODE).toBeUndefined();
    }
    expect(existsSync(root)).toBe(false);
  });

  it('does not inherit a real caller cwd containing a .env file', async () => {
    const callerDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-real-caller-'));
    tempDirs.push(callerDir);
    const { executable, logPath } = createRecordingDsh(callerDir);
    writeFileSync(join(callerDir, '.env'), 'DEEPSEEK_API_KEY=caller-secret\n');
    const runnerPath = join(callerDir, 'run-preflight.mts');
    const repoRoot = join(import.meta.dirname, '../../../..');
    const sourceEntryUrl = pathToFileURL(
      join(repoRoot, 'packages/core/src/index.ts'),
    ).href;
    writeFileSync(
      runnerPath,
      `import { runDshPreflight } from ${JSON.stringify(sourceEntryUrl)};\n` +
        `await runDshPreflight(${JSON.stringify(executable)}, {\n` +
        `  hostNodeVersion: '22.19.0',\n` +
        `  probeInvocationCwd: process.cwd(),\n` +
        `});\n`,
    );

    await execFileAsync(join(repoRoot, 'node_modules/.bin/tsx'), [runnerPath], {
      cwd: callerDir,
      env: process.env,
    });

    const records = readProbeRecords(logPath);
    const root = assertIsolatedWorkspace(records);
    expect(records.every((record) => record.cwdDotEnv === undefined)).toBe(
      true,
    );
    expect(root).not.toBe(callerDir);
    expect(existsSync(root)).toBe(false);
  });

  it('cleans the workspace after a default config contract failure', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-bad-config-'));
    tempDirs.push(tempDir);
    const { executable, logPath } = createRecordingDsh(tempDir, {
      validConfig: false,
    });

    await expect(
      runDshPreflight(executable, { hostNodeVersion: '22.19.0' }),
    ).rejects.toThrow(DshCapabilityError);

    const records = readProbeRecords(logPath);
    expect(records).toHaveLength(2);
    const root = assertIsolatedWorkspace(records);
    expect(existsSync(root)).toBe(false);
  });

  it('preserves native ENOENT for a missing default version command and cleans up', async () => {
    const missingCommand = `tekon-missing-dsh-${Date.now()}`;
    let workspace: string | undefined;
    let thrown: unknown;

    try {
      await runDshPreflight(missingCommand, {
        hostNodeVersion: '22.19.0',
        probeCleanup: (root) => {
          workspace = root;
          rmSync(root, { recursive: true, force: true });
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'ENOENT', path: missingCommand });
    expect(workspace).toBeDefined();
    expect(existsSync(workspace!)).toBe(false);
  });

  it('wraps ENOENT from default config after a custom version and keeps the detected version', async () => {
    const missingCommand = `tekon-missing-dsh-${Date.now()}`;
    let customCommand: string | undefined;
    let workspace: string | undefined;
    let thrown: unknown;

    try {
      await runDshPreflight(missingCommand, {
        hostNodeVersion: '22.19.0',
        probeVersion: async (command) => {
          customCommand = command;
          return `${TESTED_DSH_VERSION}\n`;
        },
        probeCleanup: (root) => {
          workspace = root;
          rmSync(root, { recursive: true, force: true });
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(customCommand).toBe(missingCommand);
    expect(thrown).toBeInstanceOf(DshCapabilityError);
    expect((thrown as DshCapabilityError).actualVersion).toBe(
      TESTED_DSH_VERSION,
    );
    expect(workspace).toBeDefined();
    expect(existsSync(workspace!)).toBe(false);
  });

  it('keeps the primary failure when cleanup also fails and records a warning', async () => {
    const warnings: string[] = [];

    await expect(
      runDshPreflight('raw-command', {
        hostNodeVersion: '22.19.0',
        probeVersion: async () => `${TESTED_DSH_VERSION}\n`,
        probeConfig: async () => {
          throw new Error('primary config failure');
        },
        probeCleanup: (root) => {
          tempDirs.push(root);
          throw new Error('cleanup failure');
        },
        onWarn: (warning) => warnings.push(warning),
      }),
    ).rejects.toThrow('primary config failure');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cleanup failure');
  });

  it('keeps a successful result when cleanup fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-cleanup-warning-'));
    tempDirs.push(tempDir);
    const { executable } = createRecordingDsh(tempDir);
    const warnings: string[] = [];

    const result = await runDshPreflight(executable, {
      hostNodeVersion: '22.19.0',
      probeVersion: async () => `${TESTED_DSH_VERSION}\n`,
      probeConfig: async () => validConfig(),
      probeCleanup: (root) => {
        tempDirs.push(root);
        throw new Error('cleanup failure');
      },
      onWarn: (warning) => warnings.push(warning),
    });

    expect(result.actualVersion).toBe(TESTED_DSH_VERSION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cleanup failure');
  });

  it('absorbs an onWarn callback failure without replacing the primary failure', async () => {
    await expect(
      runDshPreflight('raw-command', {
        hostNodeVersion: '22.19.0',
        probeVersion: async () => `${TESTED_DSH_VERSION}\n`,
        probeConfig: async () => {
          throw new Error('primary config failure');
        },
        probeCleanup: (root) => {
          tempDirs.push(root);
          throw new Error('cleanup failure');
        },
        onWarn: () => {
          throw new Error('warning callback failure');
        },
      }),
    ).rejects.toThrow('primary config failure');
  });

  it('passes isolated options to defaults and the raw command to a custom probe in mixed mode', async () => {
    const callerDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-mixed-'));
    tempDirs.push(callerDir);
    const { logPath } = createRecordingDsh(callerDir);
    const rawCommand = './recording-dsh.mjs';
    let customCommand: string | undefined;

    await runDshPreflight(rawCommand, {
      hostNodeVersion: '22.19.0',
      probeInvocationCwd: callerDir,
      probeVersion: async (command) => {
        customCommand = command;
        return `${TESTED_DSH_VERSION}\n`;
      },
    });

    expect(customCommand).toBe(rawCommand);
    const records = readProbeRecords(logPath);
    expect(records).toHaveLength(2);
    const root = assertIsolatedWorkspace(records);
    expect(records.some((record) => record.argv.includes('--help'))).toBe(true);
    expect(
      records.some((record) => record.argv.includes('--dump-default-config')),
    ).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('does not allocate or clean a workspace when all probes are custom', async () => {
    const rawCommand = './custom-dsh';
    const commands: string[] = [];
    let cleanupCalls = 0;

    await runDshPreflight(rawCommand, {
      hostNodeVersion: '22.19.0',
      get probeInvocationCwd() {
        throw new Error('all-custom probes must not read default-only cwd');
      },
      probeVersion: async (command) => {
        commands.push(command);
        return `${TESTED_DSH_VERSION}\n`;
      },
      probeConfig: async (command) => {
        commands.push(command);
        return validConfig();
      },
      probeHelp: async (command) => {
        commands.push(command);
        return 'print the final assistant message\n';
      },
      probeCleanup: () => {
        cleanupCalls += 1;
      },
    });

    expect(commands).toEqual([rawCommand, rawCommand, rawCommand]);
    expect(cleanupCalls).toBe(0);
  });

  it('finishes default-config validation before starting the help probe', async () => {
    const order: string[] = [];
    let configFinished = false;

    await runDshPreflight('dsh', {
      hostNodeVersion: '22.19.0',
      probeVersion: async () => `${TESTED_DSH_VERSION}\n`,
      probeConfig: async () => {
        order.push('config:start');
        await Promise.resolve();
        configFinished = true;
        order.push('config:end');
        return validConfig();
      },
      probeHelp: async () => {
        order.push('help');
        if (!configFinished) {
          throw new Error('help probe raced profile initialization');
        }
        return 'print the final assistant message\n';
      },
    });

    expect(order).toEqual(['config:start', 'config:end', 'help']);
  });
});
