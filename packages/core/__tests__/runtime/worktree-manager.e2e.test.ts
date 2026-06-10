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

import {
  createCommandGateway,
  createRepositories,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('worktree manager e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('leases two isolated git worktrees and releases them safely', async () => {
    const repoPath = createTempGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const manager = createWorktreeManager({
      repositories,
      gateway: createCommandGateway(),
    });

    const first = await manager.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_rd',
      role: 'rd',
      baseRef: 'HEAD',
    });
    const second = await manager.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_qa',
      role: 'qa',
      baseRef: 'HEAD',
    });

    expect(first.branchName).toMatch(/^tekon\/run_1\/node_rd-rd-lease-/u);
    expect(second.branchName).toMatch(/^tekon\/run_1\/node_qa-qa-lease-/u);
    expect(first.branchName).not.toBe(second.branchName);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(existsSync(first.worktreePath)).toBe(true);
    expect(existsSync(second.worktreePath)).toBe(true);

    writeFileSync(join(first.worktreePath, 'feature.txt'), 'rd only', 'utf8');
    expect(existsSync(join(second.worktreePath, 'feature.txt'))).toBe(false);
    expect(
      readFileSync(join(first.worktreePath, 'README.md'), 'utf8'),
    ).toContain('fixture');

    expect(await manager.listLeases('run_1')).toHaveLength(2);

    await manager.releaseLease(first.id);
    await manager.releaseLease(second.id);
    await manager.pruneStaleLeases(repoPath);

    expect(existsSync(first.worktreePath)).toBe(false);
    expect(existsSync(second.worktreePath)).toBe(false);
    db.close();
  });

  it('commits lease changes without staging ignored Tekon runtime output', async () => {
    const repoPath = createTempGitRepo(tempDirs, { ignoreTekon: true });
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const manager = createWorktreeManager({
      repositories,
      gateway: createCommandGateway(),
    });

    const lease = await manager.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_rd',
      role: 'rd',
      baseRef: 'HEAD',
    });
    writeFileSync(join(lease.worktreePath, 'feature.txt'), 'rd only', 'utf8');
    mkdirSync(join(lease.worktreePath, '.tekon'), { recursive: true });
    writeFileSync(
      join(lease.worktreePath, '.tekon', 'runtime.log'),
      'ignored runtime output',
      'utf8',
    );

    await expect(
      manager.commitLeaseChanges(lease.id, { message: 'feature' }),
    ).resolves.toBe(true);
    const committedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--format=', 'HEAD'],
      { cwd: lease.worktreePath, encoding: 'utf8' },
    );
    expect(committedFiles).toContain('feature.txt');
    expect(committedFiles).not.toContain('.tekon');

    await manager.releaseLease(lease.id);
    db.close();
  });

  it('commits deleted, renamed, and spaced lease paths while excluding staged Tekon runtime output', async () => {
    const repoPath = createTempGitRepo(tempDirs, { ignoreTekon: true });
    writeFileSync(join(repoPath, 'old name.txt'), 'old\n', 'utf8');
    execFileSync('git', ['add', 'old name.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'add old file'], { cwd: repoPath });
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const manager = createWorktreeManager({
      repositories,
      gateway: createCommandGateway(),
    });

    const lease = await manager.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_rd',
      role: 'rd',
      baseRef: 'HEAD',
    });
    execFileSync('git', ['rm', 'README.md'], { cwd: lease.worktreePath });
    execFileSync('git', ['mv', 'old name.txt', 'new name with space.txt'], {
      cwd: lease.worktreePath,
    });
    mkdirSync(join(lease.worktreePath, '.tekon'), { recursive: true });
    writeFileSync(
      join(lease.worktreePath, '.tekon', 'staged.txt'),
      'runtime output',
      'utf8',
    );
    execFileSync('git', ['add', '-f', '.tekon/staged.txt'], {
      cwd: lease.worktreePath,
    });

    await expect(
      manager.commitLeaseChanges(lease.id, { message: 'path changes' }),
    ).resolves.toBe(true);
    const committedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--format=', 'HEAD'],
      { cwd: lease.worktreePath, encoding: 'utf8' },
    );
    expect(committedFiles).toContain('README.md');
    expect(committedFiles).toContain('new name with space.txt');
    expect(committedFiles).not.toContain('.tekon');

    await manager.releaseLease(lease.id);
    db.close();
  });
});

function createTempGitRepo(
  tempDirs: string[],
  options: { ignoreTekon?: boolean } = {},
) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-worktree-e2e-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture repo\n', 'utf8');
  const initialFiles = ['README.md'];
  if (options.ignoreTekon) {
    writeFileSync(join(repoPath, '.gitignore'), '.tekon\n', 'utf8');
    initialFiles.push('.gitignore');
  }
  execFileSync('git', ['add', ...initialFiles], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
