import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Drop every repository-local git variable (GIT_DIR, GIT_INDEX_FILE, …) so a
// test run from inside a git hook cannot leak into the temporary repositories.
const localGitVars = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean);
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of localGitVars) delete env[name];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
}

function init(repo: string, { allowStderr = false } = {}) {
  const result = spawnSync(process.execPath, [cliPath, 'init', '--repo', repo], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, env: cleanEnv(),
  });
  expect(result.error).toBeUndefined();
  if (!allowStderr) expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result;
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

  it('does not append a second line when .gitignore re-includes .tekon', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), '!.tekon/\n', 'utf8');

    init(repo);
    init(repo);

    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.tekon/')).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)('warns and still initializes when the exclude file cannot be written', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    const infoDir = join(repo, '.git', 'info');
    rmSync(infoDir, { recursive: true, force: true });
    mkdirSync(infoDir);
    chmodSync(infoDir, 0o500);
    try {
      const result = init(repo, { allowStderr: true });
      expect(result.stderr).toContain('.tekon/');
      expect(existsSync(join(repo, '.tekon', 'config.yaml'))).toBe(true);
    } finally {
      chmodSync(infoDir, 0o700);
    }
  });

  it('still initializes a directory that is not a git repository', () => {
    const dir = tempDir();
    init(dir);
    expect(existsSync(join(dir, '.tekon', 'config.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});
