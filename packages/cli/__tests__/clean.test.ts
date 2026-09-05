import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('CLI clean command suspended guard', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('returns exit code 1 with CLEAN_SUSPENDED on stderr, empty stdout, and preserves worktrees', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tekon-clean-unit-'));
    tempDirs.push(repoDir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"test"}\n');
    execFileSync('git', ['add', 'package.json'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const io = createMemoryIO();
    const initExit = await runCli(['init', '--repo', repoDir], io);
    expect(initExit).toBe(0);
    io.takeStdout();
    io.takeStderr();

    // Create dummy worktree entry
    const worktreesDir = join(repoDir, '.tekon', 'worktrees');
    const sampleWorktree = join(worktreesDir, 'sample-wt');
    mkdirSync(sampleWorktree, { recursive: true });
    writeFileSync(join(sampleWorktree, 'preserve.txt'), 'preserved content');

    const cleanExit = await runCli(['clean', '--repo', repoDir], io);
    expect(cleanExit).toBe(1);

    expect(io.takeStdout()).toBe('');
    const stderr = io.takeStderr();
    expect(stderr).toContain('CLEAN_SUSPENDED');
    expect(stderr).toMatch(/#33.*#18|#18.*#33/);

    // Worktree and content preserved
    expect(existsSync(join(sampleWorktree, 'preserve.txt'))).toBe(true);
    expect(readFileSync(join(sampleWorktree, 'preserve.txt'), 'utf8')).toBe(
      'preserved content',
    );
  });

  it('still rejects an uninitialized repository before reporting the clean suspension', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tekon-clean-uninitialized-'));
    tempDirs.push(repoDir);
    const io = createMemoryIO();

    const exitCode = await runCli(['clean', '--repo', repoDir], io);

    expect(exitCode).toBe(1);
    expect(io.takeStdout()).toBe('');
    const stderr = io.takeStderr();
    expect(stderr).toContain('项目未初始化');
    expect(stderr).not.toContain('CLEAN_SUSPENDED');
  });
});
