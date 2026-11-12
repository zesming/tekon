import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const repo = mkdtempSync(join(tmpdir(), 'tekon-clean-e2e-'));
  roots.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@tekon.local');
  git(repo, 'config', 'user.name', 'Tekon Test');
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
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  return repo;
}

function cli(repo: string, args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 90_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function nodeBranches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/tekon/')
    .split('\n')
    .filter(Boolean);
}

describe('tekon clean through a real CLI process', () => {
  it('cleans only finished runs, lists before acting, and keeps delivery and evidence', () => {
    const repo = fixtureRepo();
    expect(cli(repo, ['init']).status).toBe(0);
    const run = cli(repo, ['run', '修复按钮文案', '--template', 'bugfix', '--agent', 'mock']);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(run.stdout)?.[1];
    expect(runId, run.stdout + run.stderr).toBeTruthy();
    expect(run.stdout).toContain('状态: paused');
    expect(nodeBranches(repo).length).toBeGreaterThan(0);

    // A paused run can still resume, so its worktrees and branches stay.
    const refused = cli(repo, ['clean', '--run-id', runId!]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`运行 ${runId} 的状态是 paused`);
    expect(cli(repo, ['clean']).stdout).toContain('没有需要清理的运行');

    expect(cli(repo, ['cancel', '--run-id', runId!]).status).toBe(0);
    const before = nodeBranches(repo);
    const runDir = join(repo, '.tekon', 'runs', runId!);
    const runFiles = () => readdirSync(runDir, { recursive: true, encoding: 'utf8' }).sort();
    const filesBefore = runFiles();

    // Without --yes it only lists; --dry-run never changes anything either.
    const listed = cli(repo, ['clean']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`${runId}（cancelled）`);
    expect(listed.stdout).toContain(`节点分支 ${before.length} 个`);
    expect(listed.stdout).toContain('tekon clean --yes');
    const preview = cli(repo, ['clean', '--run-id', runId!, '--dry-run']);
    expect(preview.stdout).toContain('预览，没有做任何改动');
    expect(nodeBranches(repo)).toEqual(before);
    expect(runFiles()).toEqual(filesBefore);

    const cleaned = cli(repo, ['clean', '--yes']);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(cleaned.stdout).toContain(`已清理 ${runId}`);
    expect(cleaned.stdout).toContain(`删除节点分支 ${before.length} 个`);
    expect(nodeBranches(repo)).toEqual([]);
    expect(git(repo, 'branch', '--list', `tekon-delivery/${runId}`).trim()).not.toBe('');
    expect(existsSync(join(repo, '.tekon', 'runs', runId!))).toBe(true);
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);

    const status = cli(repo, ['status', '--run-id', runId!]);
    expect(status.stdout).toContain('status=cancelled');
    expect(cli(repo, ['clean', '--yes']).stdout).toContain('没有需要清理的运行');
  }, 180_000);
});
