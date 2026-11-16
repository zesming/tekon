import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureSourceSnapshot,
  diffSourceSnapshot,
} from '../../src/runtime/source-snapshot.js';

// CD-09 8b-2：非 git 目录下 workspace:none 节点无法用 git status 判定源修改，
// 用文件清单 + sha256 快照提供可移植的基线，finalize 时比对差异。
describe('CD-09 source snapshot for non-git workspace enforcement', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-source-snapshot-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    mkdirSync(join(repoPath, '.tekon', 'runs'), { recursive: true });
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    mkdirSync(join(repoPath, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'a.txt'), 'alpha\n');
    writeFileSync(join(repoPath, '.tekon', 'state.json'), '{}');
    writeFileSync(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(repoPath, 'node_modules', 'pkg', 'index.js'),
      '// pkg\n',
    );
    return repoPath;
  }

  it('captures regular files with relative posix paths and content hashes', () => {
    const repoPath = makeRepo();
    const snapshot = captureSourceSnapshot(repoPath);

    expect(snapshot.version).toBe(1);
    const paths = snapshot.entries.map((entry) => entry.path);
    expect(paths).toContain('src/a.txt');
    expect(paths).not.toContain(expect.stringContaining('.tekon'));
    expect(paths.some((path) => path.startsWith('.git'))).toBe(false);
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
    const entry = snapshot.entries.find((item) => item.path === 'src/a.txt');
    expect(entry?.sha256).toHaveLength(64);
    expect(entry?.size).toBe(6);
  });

  it('reports added, modified and removed files against the baseline', () => {
    const repoPath = makeRepo();
    const baseline = captureSourceSnapshot(repoPath);

    writeFileSync(join(repoPath, 'src', 'b.txt'), 'beta\n');
    writeFileSync(join(repoPath, 'src', 'a.txt'), 'alpha-changed\n');
    rmSync(join(repoPath, 'src', 'a.txt'));
    writeFileSync(join(repoPath, 'src', 'a.txt'), 'alpha-changed\n');

    const diff = diffSourceSnapshot(repoPath, baseline);
    expect(diff.added).toEqual(['src/b.txt']);
    expect(diff.modified).toEqual(['src/a.txt']);
    expect(diff.removed).toEqual([]);
    expect(diff.changedPaths).toEqual(
      expect.arrayContaining(['src/a.txt', 'src/b.txt']),
    );
  });

  it('detects a removed file and ignores writes inside excluded directories', () => {
    const repoPath = makeRepo();
    const baseline = captureSourceSnapshot(repoPath);

    rmSync(join(repoPath, 'src', 'a.txt'));
    writeFileSync(join(repoPath, '.tekon', 'runs', 'log.txt'), 'runtime');
    writeFileSync(join(repoPath, 'node_modules', 'pkg', 'extra.js'), '// x');

    const diff = diffSourceSnapshot(repoPath, baseline);
    expect(diff.removed).toEqual(['src/a.txt']);
    expect(diff.changedPaths).toEqual(['src/a.txt']);
  });

  it('detects a symlink target change as a modification', () => {
    const repoPath = makeRepo();
    writeFileSync(join(repoPath, 'target-a.txt'), 'a\n');
    writeFileSync(join(repoPath, 'target-b.txt'), 'b\n');
    symlinkSync('target-a.txt', join(repoPath, 'link.txt'));
    const baseline = captureSourceSnapshot(repoPath);

    rmSync(join(repoPath, 'link.txt'));
    symlinkSync('target-b.txt', join(repoPath, 'link.txt'));

    const diff = diffSourceSnapshot(repoPath, baseline);
    expect(diff.modified).toEqual(['link.txt']);
  });

  it('produces an empty diff when nothing under the tracked tree changed', () => {
    const repoPath = makeRepo();
    const baseline = captureSourceSnapshot(repoPath);

    const diff = diffSourceSnapshot(repoPath, baseline);
    expect(diff.changedPaths).toEqual([]);
  });
});
