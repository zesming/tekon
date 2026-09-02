import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TESTED_DSH_VERSION,
  isHostNodeVersionCompatible,
} from '@tekon/core';

import { runCli, type CliIO } from '../src/index.js';
import {
  createFakeDsh as writeFakeDsh,
  VALID_DSH_CONFIG,
} from './helpers/fake-dsh.js';

const UNTESTED_VERSION = '9.9.9-untested';
const CONTRACT_HELP = 'print the final assistant message';

describe('dsh preflight version escape hatch', () => {
  const tempDirs: string[] = [];
  const originalPath = process.env.PATH;
  const originalAllowVersion = process.env.TEKON_DSH_ALLOW_VERSION;
  const originalAllowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;

  function admitCurrentHostForFixture(): void {
    if (!isHostNodeVersionCompatible(process.versions.node)) {
      process.env.TEKON_DSH_ALLOW_HOST_NODE = process.versions.node;
    }
  }

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAllowVersion === undefined) {
      delete process.env.TEKON_DSH_ALLOW_VERSION;
    } else {
      process.env.TEKON_DSH_ALLOW_VERSION = originalAllowVersion;
    }
    if (originalAllowHostNode === undefined) {
      delete process.env.TEKON_DSH_ALLOW_HOST_NODE;
    } else {
      process.env.TEKON_DSH_ALLOW_HOST_NODE = originalAllowHostNode;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a genuinely untested version', () => {
    expect(UNTESTED_VERSION).not.toBe(TESTED_DSH_VERSION);
  });

  it('honors --allow-version for the exact detected version', async () => {
    admitCurrentHostForFixture();
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

  it('rejects the untested version without an escape hatch', async () => {
    admitCurrentHostForFixture();
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

  it('honors TEKON_DSH_ALLOW_VERSION in the normal preflight path', async () => {
    admitCurrentHostForFixture();
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
    config: VALID_DSH_CONFIG,
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
