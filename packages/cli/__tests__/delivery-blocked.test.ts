import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIO } from '../src/index.js';
import { writePermissiveRepoProfile } from './helpers/repo-profile.js';

// PD-02：不可交付/旧 run 的 prepare 阻断必须给中文原因与补救路径，
// 而不是 assertPrePullRequestReady 的英文裸串。
describe('PD-02 delivery prepare 阻断中文化', { timeout: 60_000 }, () => {
  const tempDirs: string[] = [];
  const anchorCwd = process.cwd();

  afterEach(() => {
    try {
      process.chdir(anchorCwd);
    } catch {
      // anchor 始终存在；忽略竞态
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
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
      takeStdout: () => {
        const value = stdout;
        stdout = '';
        return value;
      },
      takeStderr: () => {
        const value = stderr;
        stderr = '';
        return value;
      },
    };
  }

  function createFixtureRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-blocked-'));
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
        scripts: {
          build: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      }),
    );
    execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    writePermissiveRepoProfile(repoPath);
    return repoPath;
  }

  it('对不可交付模板的 run 执行 prepare：exit 1 且 stderr 给中文阻断原因与补救路径', async () => {
    const repoPath = createFixtureRepo();
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();

    // lightweight-delivery 无 delivery 声明；运行在人工门暂停（exit 3 是
    // 既有契约），但冻结快照已落库，足以验证 prepare 的声明阻断。
    const runExit = await runCli(
      [
        'run',
        '一个不需要 PR 的小改动',
        '--template',
        'lightweight-delivery',
        '--agent',
        'mock',
        '--repo',
        repoPath,
      ],
      io,
    );
    expect(runExit).toBe(3);
    io.takeStdout();

    const exitCode = await runCli(
      ['delivery', 'prepare', '--repo', repoPath],
      io,
    );
    expect(exitCode).toBe(1);
    const stderr = io.takeStderr();
    expect(stderr).toContain('当前运行不满足 PR 准备条件');
    expect(stderr).toContain('不可交付');
    expect(stderr).toContain('重新发起');
    // 英文技术裸串不得直达用户。
    expect(stderr).not.toContain('run is not ready for PR creation');
  });
});
