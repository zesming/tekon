import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
}

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-role-open-e2e-'));
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

describe('tekon role open naming through a real CLI process', () => {
  it('shows the built-in goal role, scaffolds a custom role, and rejects invalid ids', () => {
    const repo = fixtureRepo();
    expect(cli(repo, ['init']).status).toBe(0);

    // PD-10：role show goal 以前被 CLI 的内置枚举副本拒绝。
    const showGoal = cli(repo, ['role', 'show', 'goal']);
    expect(showGoal.status, showGoal.stdout + showGoal.stderr).toBe(0);
    expect(showGoal.stdout).toContain('role=goal');

    // PD-06：角色名放开，新名字走最小脚手架而不是枚举报错。
    const createWriter = cli(repo, ['role', 'create', 'writer']);
    expect(createWriter.status, createWriter.stdout + createWriter.stderr).toBe(0);
    const writerDir = join(repo, '.tekon', 'roles', 'writer');
    const agentPath = join(writerDir, 'agent.yaml');
    const systemPath = join(writerDir, 'system.md');
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(systemPath)).toBe(true);
    expect(readFileSync(agentPath, 'utf8')).toContain('role: writer');

    const listResult = cli(repo, ['role', 'list']);
    expect(listResult.status).toBe(0);
    const listed = listResult.stdout.split('\n').map((line) => line.trim());
    expect(listed).toContain('writer');
    expect(listed).toContain('goal');

    const showWriter = cli(repo, ['role', 'show', 'writer']);
    expect(showWriter.status, showWriter.stdout + showWriter.stderr).toBe(0);
    expect(showWriter.stdout).toContain('role=writer');

    // 同名重复创建必须被拒绝，不能覆盖已有角色目录。
    const duplicate = cli(repo, ['role', 'create', 'writer']);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr + duplicate.stdout).toMatch(/已存在|exists/u);

    // 非 kebab-case 标识符必须被拒绝并给出格式指引。
    // 含空格：先命中通用名称护栏；大写：通过名称护栏后命中角色标识符护栏。
    const spacedId = cli(repo, ['role', 'create', 'Senior Writer']);
    expect(spacedId.status).not.toBe(0);
    expect(spacedId.stderr + spacedId.stdout).toMatch(/名称|角色|标识符/u);

    const upperId = cli(repo, ['role', 'create', 'WRITER']);
    expect(upperId.status).not.toBe(0);
    expect(upperId.stderr + upperId.stdout).toMatch(/角色|标识符|kebab/u);
  });

  it('still copies a built-in role when the id matches one', () => {
    const repo = fixtureRepo();
    expect(cli(repo, ['init']).status).toBe(0);

    const createRd = cli(repo, ['role', 'create', 'rd']);
    expect(createRd.status, createRd.stdout + createRd.stderr).toBe(0);
    const copied = join(repo, '.tekon', 'roles', 'rd', 'agent.yaml');
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf8')).toContain('role: rd');
  });
});
