import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-init-ignore-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
}

function init(repo: string) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const result = spawnSync(process.execPath, [cliPath, 'init', '--repo', repo], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, env,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe('tekon init keeps .tekon out of git', () => {
  it('adds .tekon/ to the local exclude file once and leaves .gitignore alone', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n', 'utf8');

    init(repo);
    init(repo);

    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .gitignore\n');
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.tekon/')).toHaveLength(1);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('does not touch the exclude file when .tekon is already ignored', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), '.tekon/\n', 'utf8');
    const before = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');

    init(repo);

    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(before);
  });

  it('still initializes a directory that is not a git repository', () => {
    const dir = tempDir();
    init(dir);
    expect(existsSync(join(dir, '.tekon', 'config.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});
