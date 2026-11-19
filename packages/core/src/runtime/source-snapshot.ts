import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  readFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

// CD-09：workspace:none 在非 git 目录没有 `git status` 可用，用递归文件清单
// （相对路径 + sha256）作为源修改基线。排除目录与 git 工作树检查的关注点
// 对齐：.git 是 VCS 元数据，.tekon 是 Tekon 自身运行数据，node_modules
// 通常被 .gitignore 忽略且体量大，依赖安装不视为源码修改。
const EXCLUDED_DIRECTORIES = new Set(['.git', '.tekon', 'node_modules']);

export interface SourceSnapshotEntry {
  /** 相对快照根的 posix 风格路径，跨平台稳定。 */
  path: string;
  sha256: string;
  size: number;
  /**
   * POSIX 权限位（lstat.mode）。内容不变但 chmod 改权限也能被识别，
   * 对齐 git worktree 路径对 100644/100755 的检测能力。
   */
  mode: number;
  /** symlink 记录其目标字符串而非跟随内容，替换目标即被识别为修改。 */
  symlink?: boolean;
}

export interface SourceSnapshot {
  version: 1;
  root: string;
  createdAt: string;
  entries: SourceSnapshotEntry[];
}

export interface SourceSnapshotDiff {
  added: string[];
  modified: string[];
  removed: string[];
  changedPaths: string[];
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function walk(rootDir: string, currentDir: string): SourceSnapshotEntry[] {
  const entries: SourceSnapshotEntry[] = [];
  for (const dirent of readdirSync(currentDir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(dirent.name)) continue;
      entries.push(...walk(rootDir, join(currentDir, dirent.name)));
      continue;
    }
    const absolutePath = join(currentDir, dirent.name);
    const relativePath = toPosix(relative(rootDir, absolutePath));
    if (dirent.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      entries.push({
        path: relativePath,
        sha256: createHash('sha256').update(target).digest('hex'),
        size: target.length,
        mode: lstatSync(absolutePath).mode,
        symlink: true,
      });
      continue;
    }
    if (!dirent.isFile()) continue;
    const contents = readFileSync(absolutePath);
    entries.push({
      path: relativePath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: contents.length,
      mode: lstatSync(absolutePath).mode,
    });
  }
  return entries;
}

/** 递归捕获仓库工作区的源文件基线；根目录不存在时返回空清单。 */
export function captureSourceSnapshot(rootDir: string): SourceSnapshot {
  const entries = existsSync(rootDir) ? walk(rootDir, rootDir) : [];
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    root: rootDir,
    createdAt: new Date().toISOString(),
    entries,
  };
}

/** 比对当前工作区与基线快照，返回新增/修改/删除的相对路径。 */
export function diffSourceSnapshot(
  rootDir: string,
  baseline: SourceSnapshot,
): SourceSnapshotDiff {
  const current = captureSourceSnapshot(rootDir);
  const baselineById = new Map(
    baseline.entries.map((entry) => [entry.path, entry]),
  );
  const currentById = new Map(
    current.entries.map((entry) => [entry.path, entry]),
  );

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const entry of current.entries) {
    const before = baselineById.get(entry.path);
    if (!before) {
      added.push(entry.path);
    } else if (
      before.sha256 !== entry.sha256 ||
      // N-R1：mode 是后加字段，升级前的旧快照条目无 mode，跳过该项比较，
      // 避免 resume 旧 interrupted 运行时把全部文件误报为权限修改。
      (before.mode !== undefined && before.mode !== entry.mode) ||
      Boolean(before.symlink) !== Boolean(entry.symlink)
    ) {
      modified.push(entry.path);
    }
  }
  for (const path of baselineById.keys()) {
    if (!currentById.has(path)) removed.push(path);
  }

  const changedPaths = [...added, ...modified, ...removed].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    added: added.sort((a, b) => a.localeCompare(b)),
    modified: modified.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    changedPaths,
  };
}
