import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { openTekonDatabase } from '@tekon/core';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  writeFakeClaude,
} from '../helpers/fake-provider.js';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fixtureRepo(): string {
  const repo = tempDir('tekon-provider-diag-');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(
    join(repo, 'package.json'),
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
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
  return repo;
}

function cli(repo: string, binDir: string, home: string, args: string[]) {
  return runCliWithEnv(cliPath, [...args, '--repo', repo], {
    cwd: repo,
    binDirs: [binDir],
    isolatePath: true,
    home,
    timeoutMs: 90_000,
  });
}

function runCount(repo: string): number {
  const dbPath = join(repo, '.tekon', 'tekon.sqlite');
  if (!existsSync(dbPath)) return 0;
  const db = openTekonDatabase({ filename: dbPath });
  try {
    return (db.prepare('select count(*) as count from workflow_instances').get() as { count: number })
      .count;
  } finally {
    db.close();
  }
}

describe('provider diagnostics through a real CLI process', () => {
  it('refuses to start when the provider command is not installed', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-provider-diag-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    expect(cli(repo, binDir, home, ['init']).status).toBe(0);

    const result = cli(repo, binDir, home, [
      'run', '修复按钮文案', '--template', 'bugfix', '--agent', 'claude-code',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('找不到 claude 命令');
    expect(result.stderr).toContain('下一步: 安装 claude');
    expect(runCount(repo)).toBe(0);
  }, 120_000);

  it('explains a login failure, then drops the old reason after a successful resume', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-provider-diag-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    writeFakeClaude(binDir, {
      behavior: 'not-authenticated',
      auth: { loggedIn: false },
    });
    expect(cli(repo, binDir, home, ['init']).status).toBe(0);

    const run = cli(repo, binDir, home, [
      'run', '修复按钮文案', '--template', 'bugfix', '--agent', 'claude-code',
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Provider: claude-code，认证方式: 未检测到');
    expect(run.stderr).toContain('注意: claude 未检测到登录或凭据');
    expect(run.stdout).toContain('⚠ 运行中断');
    expect(run.stdout).toContain('原因: claude 未登录或凭据无效');
    expect(run.stdout).toMatch(/下一步: 执行 claude \/login/u);
    // Identity fields from `auth status` never reach the output.
    expect(`${run.stdout}${run.stderr}`).not.toContain('fake-user@example.invalid');
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(run.stdout)?.[1];
    expect(runId).toBeTruthy();

    const status = cli(repo, binDir, home, ['status', '--run-id', runId!]);
    expect(status.stdout).toContain('status=interrupted');
    expect(status.stdout).toContain('原因: claude 未登录或凭据无效');

    writeFakeClaude(binDir, { behavior: 'success' });
    const resume = cli(repo, binDir, home, ['resume', '--run-id', runId!]);
    expect(resume.stderr).toContain('认证方式: 订阅登录');
    const after = cli(repo, binDir, home, ['status', '--run-id', runId!]);
    expect(after.stdout).not.toContain('status=interrupted');
    expect(after.stdout).not.toContain('未登录或凭据无效');
  }, 240_000);
});
