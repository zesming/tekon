import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIO } from '../src/index.js';
import { providerRuntimeFromCliOptions } from '../src/lib/agent-factory.js';

describe('CLI run-mode and provider consent policy', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects dsh-headless workflow runs before spawning the provider', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();

    await expect(
      runCli(
        [
          'run',
          '不应进入完整交付的 headless 任务',
          '--agent',
          'dsh-headless',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('dsh-headless 仅支持 goal');
  });

  it('rejects a dsh-headless goal before side effects without explicit network acknowledgement', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();

    await expect(
      runCli(
        [
          'run',
          '需要显式联网确认的 headless 任务',
          '--goal',
          '--agent',
          'dsh-headless',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain(
      '--acknowledge-unrestricted-network',
    );
  });

  it('threads the explicit CLI acknowledgement into provider runtime overrides', () => {
    expect(
      providerRuntimeFromCliOptions({
        'acknowledge-unrestricted-network': true,
      }),
    ).toMatchObject({ acknowledgeUnrestrictedNetwork: true });

    expect(
      providerRuntimeFromCliOptions({
        'acknowledge-unrestricted-network': false,
      }),
    ).not.toHaveProperty('acknowledgeUnrestrictedNetwork');
  });
});

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

function createFixtureRepo(tempDirs: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-run-mode-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      main: 'index.js',
      // npm init -y 隐式生成 scripts.test；保留以避免 detectRepoProfile 静默漂移
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      keywords: [],
      author: '',
      license: 'ISC',
      description: '',
    }),
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
