import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TESTED_DSH_VERSION } from '@tekon/core';

import { runCli, type CliIO } from '../src/index.js';
import {
  createFakeDsh as writeFakeDsh,
  VALID_DSH_CONFIG,
} from './helpers/fake-dsh.js';

// A version that is genuinely different from the pin, so the escape-hatch
// branch (not the version-match fast path) is what under test.
const UNTESTED_VERSION = '9.9.9-untested';

it('sanity: the escape-hatch test version is genuinely different from the pin', () => {
  // If this fails, the escape-hatch tests would pass via the version-match
  // fast path instead of exercising the allowVersion override.
  expect(UNTESTED_VERSION).not.toBe(TESTED_DSH_VERSION);
});
const CONTRACT_HELP = 'print the final assistant message';
const CONTRACT_CONFIG = VALID_DSH_CONFIG;

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

  it('rejects the untested version without an escape hatch (proves the hatch is what allows it)', async () => {
    const fakeBinDir = createFakeDsh(tempDirs);
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    delete process.env.TEKON_DSH_ALLOW_VERSION;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.takeStdout()).toContain('兼容性结论: 不兼容');
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
  writeFakeDsh(dir, {
    version: UNTESTED_VERSION,
    help: CONTRACT_HELP,
    config: CONTRACT_CONFIG,
  });
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
