import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_DSH_PLUGIN_IDS,
  TESTED_DSH_VERSION,
  runDshPreflight,
} from '../../src/index.js';

interface RecordedProbeEnv {
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
  SSH_AUTH_SOCK?: string;
  NODE_OPTIONS?: string;
  npm_config_registry?: string;
  DSH_PERMISSION_MODE?: string;
}

function createRecordingDsh(tempDir: string): {
  executable: string;
  logPath: string;
} {
  const executable = join(tempDir, 'recording-dsh.mjs');
  const logPath = join(tempDir, 'probe-env.jsonl');
  const config = [
    'plugins:',
    ...REQUIRED_DSH_PLUGIN_IDS.map((id) => `  - id: ${id}`),
    '',
  ].join('\n');

  writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from 'node:fs';\n` +
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
        'SSH_AUTH_SOCK',
        'NODE_OPTIONS',
        'npm_config_registry',
        'DSH_PERMISSION_MODE',
      ])};\n` +
      `const entry = Object.fromEntries(keys.map((key) => [key, process.env[key]]));\n` +
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

function readProbeEnvs(logPath: string): RecordedProbeEnv[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedProbeEnv);
}

describe('dsh metadata probe isolation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes only metadata-runtime values and never forwards ambient credentials or injection settings', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-min-env-'));
    tempDirs.push(tempDir);
    const { executable, logPath } = createRecordingDsh(tempDir);

    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(tempDir, 'home'),
      DSH_HOME: join(tempDir, 'dsh-home'),
      DSH_AGENTS_HOME: join(tempDir, 'agents-home'),
      DSH_TELEMETRY_DISABLED: '0',
      DSH_TELEMETRY_MODE: 'FULL',
      DSH_TELEMETRY_OTLP_URL: 'https://telemetry.invalid/v1/logs',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY: 'openai-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GH_TOKEN: 'github-secret',
      HTTPS_PROXY: 'https://proxy-user:proxy-pass@proxy.invalid',
      SSH_AUTH_SOCK: join(tempDir, 'ssh-agent.sock'),
      NODE_OPTIONS: '--require=/tmp/untrusted-hook.cjs',
      npm_config_registry: 'https://registry.invalid',
      DSH_PERMISSION_MODE: 'danger-full-access',
    };

    await runDshPreflight(executable, {
      hostNodeVersion: '22.19.0',
      probeEnvSource: source,
    });

    const entries = readProbeEnvs(logPath);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.PATH).toBe(source.PATH);
      expect(entry.HOME).toBe(source.HOME);
      expect(entry.DSH_HOME).toBe(source.DSH_HOME);
      expect(entry.DSH_AGENTS_HOME).toBe(source.DSH_AGENTS_HOME);
      expect(entry.DSH_TELEMETRY_DISABLED).toBe('1');
      expect(entry.DEEPSEEK_API_KEY).toBeUndefined();
      expect(entry.OPENAI_API_KEY).toBeUndefined();
      expect(entry.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(entry.GH_TOKEN).toBeUndefined();
      expect(entry.HTTPS_PROXY).toBeUndefined();
      expect(entry.SSH_AUTH_SOCK).toBeUndefined();
      expect(entry.NODE_OPTIONS).toBeUndefined();
      expect(entry.npm_config_registry).toBeUndefined();
      expect(entry.DSH_PERMISSION_MODE).toBeUndefined();
    }
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
        return REQUIRED_DSH_PLUGIN_IDS.map((id) => `- id: ${id}`).join('\n');
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
