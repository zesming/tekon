import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIO } from '../src/index.js';

const UNTESTED_VERSION = '0.1.2-alpha.1';
const CONTRACT_HELP = 'print the final assistant message';
const CONTRACT_CONFIG =
  'headless-runner sandbox-policy user-approval session-persistence-jsonl agent-default-model';

describe('dsh preflight version escape hatch', () => {
  const tempDirs: string[] = [];
  const originalPath = process.env.PATH;
  const originalAllowVersion = process.env.TEKON_DSH_ALLOW_VERSION;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAllowVersion === undefined) {
      delete process.env.TEKON_DSH_ALLOW_VERSION;
    } else {
      process.env.TEKON_DSH_ALLOW_VERSION = originalAllowVersion;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors --allow-version for the exact detected version', async () => {
    const fakeBinDir = createFakeDsh(tempDirs);
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    const exitCode = await runCli(
      [
        'provider',
        'preflight',
        'dsh-headless',
        '--allow-version',
        UNTESTED_VERSION,
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.takeStdout()).toContain('兼容性结论: 兼容');
  });

  it('honors TEKON_DSH_ALLOW_VERSION in the normal core preflight path', async () => {
    const fakeBinDir = createFakeDsh(tempDirs);
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    process.env.TEKON_DSH_ALLOW_VERSION = UNTESTED_VERSION;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.takeStdout()).toContain('兼容性结论: 兼容');
  });
});

function createFakeDsh(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-dsh-escape-'));
  tempDirs.push(dir);
  const path = join(dir, 'dsh');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write(${JSON.stringify(`${UNTESTED_VERSION}\n`)});
else if (args.includes('--help')) process.stdout.write(${JSON.stringify(`${CONTRACT_HELP}\n`)});
else if (args.includes('--dump-default-config')) process.stdout.write(${JSON.stringify(`${CONTRACT_CONFIG}\n`)});
`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return dir;
}

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
    takeStdout() {
      const value = stdout;
      stdout = '';
      return value;
    },
    takeStderr() {
      const value = stderr;
      stderr = '';
      return value;
    },
  };
}
