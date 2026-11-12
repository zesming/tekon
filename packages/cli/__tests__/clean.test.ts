import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

interface MemoryIO {
  stdout: { write: (str: string) => void };
  stderr: { write: (str: string) => void };
  takeStdout: () => string;
  takeStderr: () => string;
}

function createMemoryIO(): MemoryIO {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
    takeStdout: () => {
      const out = stdout;
      stdout = '';
      return out;
    },
    takeStderr: () => {
      const err = stderr;
      stderr = '';
      return err;
    },
  };
}

// The clean behavior itself runs through a real process in e2e/clean.e2e.test.ts.
describe('CLI clean command', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects an uninitialized repository without touching it', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tekon-clean-uninitialized-'));
    tempDirs.push(repoDir);
    const io = createMemoryIO();

    const exitCode = await runCli(['clean', '--repo', repoDir], io);

    expect(exitCode).toBe(1);
    expect(io.takeStdout()).toBe('');
    expect(io.takeStderr()).toContain('项目未初始化');
  });
});
