import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// PD-07/CD-20：workflow list/show/validate/create --minimal 走真实 CLI
// 进程（dist），保证 argv 解析到退出码的完整链路；细粒度行为由
// __tests__/workflow-inspect.test.ts 的进程内用例覆盖。
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-wf-inspect-e2e-'));
  roots.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@tekon.local');
  git(repo, 'config', 'user.name', 'Tekon Test');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  return repo;
}

function cli(repo: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

function writeTemplate(repo: string, name: string, content: string): void {
  const dir = join(repo, '.tekon', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), content, 'utf8');
}

const brokenTemplate = 'id: broken-tpl\nphases: nope\n';

describe('tekon workflow inspection through a real CLI process (PD-07)', () => {
  it('lists with source markers, shows node structure, and flags invalid templates without failing the list', () => {
    const repo = fixtureRepo();
    expect(cli(repo, ['init']).status).toBe(0);
    writeTemplate(repo, 'broken-tpl', brokenTemplate);

    // --repo 紧跟在 list 之后（而不是位置参数后），覆盖曾经被位置参数
    // 吞掉 --repo 的 argv 解析隐患。
    const list = spawnSync(
      process.execPath,
      [cliPath, 'workflow', 'list', '--repo', repo],
      { cwd: repo, encoding: 'utf8', timeout: 90_000 },
    );
    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(list.stdout).toContain('standard-delivery [builtin]');
    expect(list.stdout).toMatch(/broken-tpl.*invalid/u);
    // list 的一行一模板合同：YAML/zod 错误的换行不得撑破行结构。
    for (const line of list.stdout.trim().split('\n')) {
      expect(line).toMatch(/^\S+ \[[^\n]+\]$/u);
    }

    // CD-20：show 坏模板给可读中文，不裸抛校验器 JSON。
    const showBroken = cli(repo, ['workflow', 'show', 'broken-tpl']);
    expect(showBroken.status).toBe(1);
    const brokenOutput = showBroken.stderr + showBroken.stdout;
    expect(brokenOutput).toContain('broken-tpl');
    expect(brokenOutput).toMatch(/类型错误|phases/u);
    expect(brokenOutput).not.toContain('ZodError');
    expect(brokenOutput).not.toContain('"code"');

    // 不存在的模板给 list 指路，不泄漏 CLI 安装路径。
    const ghost = cli(repo, ['workflow', 'validate', 'ghost-tpl']);
    expect(ghost.status).toBe(1);
    expect(ghost.stderr + ghost.stdout).toMatch(/不存在/u);
    expect(ghost.stderr + ghost.stdout).toContain('workflow list');
    expect(ghost.stderr + ghost.stdout).not.toContain('ENOENT');

    const show = cli(repo, ['workflow', 'show', 'standard-delivery']);
    expect(show.status, show.stdout + show.stderr).toBe(0);
    expect(show.stdout).toContain('phase ');
    expect(show.stdout).toMatch(/node .* role=/u);
    expect(show.stdout).toContain('gates=');

    // 标志位在位置参数之前时，不得把 --repo 误当模板名。
    const flagFirst = spawnSync(
      process.execPath,
      [cliPath, 'workflow', 'show', '--repo', repo, 'standard-delivery'],
      { cwd: repo, encoding: 'utf8', timeout: 90_000 },
    );
    expect(flagFirst.status, flagFirst.stdout + flagFirst.stderr).toBe(0);
    expect(flagFirst.stdout).toContain('id=standard-delivery');
    expect(flagFirst.stderr).not.toContain('--repo.yaml');

    // 无位置参数的 preflight 回落 standard-delivery。
    const preflight = spawnSync(
      process.execPath,
      [cliPath, 'workflow', 'preflight', '--repo', repo],
      { cwd: repo, encoding: 'utf8', timeout: 90_000 },
    );
    expect(preflight.status, preflight.stdout + preflight.stderr).toBe(0);
    expect(preflight.stdout).toContain('gate=');
  });

  it('validate reports exit code with a readable message, and create --minimal yields a valid template', () => {
    const repo = fixtureRepo();
    expect(cli(repo, ['init']).status).toBe(0);
    writeTemplate(repo, 'broken-tpl', brokenTemplate);

    const bad = cli(repo, ['workflow', 'validate', 'broken-tpl']);
    expect(bad.status).toBe(1);
    const badOutput = bad.stderr + bad.stdout;
    expect(badOutput).toContain('broken-tpl');
    // CD-20：给可读指路（含字段路径），不裸抛校验器 JSON。
    expect(badOutput).toContain('phases');
    expect(badOutput).not.toContain('ZodError');
    expect(badOutput).not.toContain('"code"');

    const created = cli(repo, ['workflow', 'create', 'lite-tpl', '--minimal']);
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const scaffoldPath = created.stdout.trim();
    expect(existsSync(scaffoldPath)).toBe(true);
    expect(readFileSync(scaffoldPath, 'utf8')).toContain('id: lite-tpl');

    const revalidated = cli(repo, ['workflow', 'validate', 'lite-tpl']);
    expect(revalidated.status, revalidated.stdout + revalidated.stderr).toBe(0);
    expect(revalidated.stdout).toContain('lite-tpl');
    expect(revalidated.stdout).toContain('valid');
  });
});
