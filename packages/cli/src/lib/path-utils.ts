import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readDemandShapeFile, type DemandShape } from '@tekon/core';

export function findUp(
  startDir: string,
  predicate: (candidateDir: string) => boolean,
): string | null {
  let current = resolve(startDir);
  for (;;) {
    if (predicate(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function findGitRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function findInitializedRepoRoot(
  startDir: string,
): string | null {
  return findUp(startDir, (dir) =>
    existsSync(join(dir, '.tekon', 'config.yaml')),
  );
}

export function resolveProjectRepoPath(repoArg?: string): string {
  if (repoArg) {
    return resolve(repoArg);
  }
  return (
    findInitializedRepoRoot(process.cwd()) ??
    findGitRoot() ??
    resolve(process.cwd())
  );
}

export function resolveDemandShapePath(
  repoPath: string,
  shapeArg?: string,
  options: {
    latestMustBeApproved?: boolean;
    latestMustBeUnapproved?: boolean;
  } = {},
): string {
  if (shapeArg) {
    const shapePath = resolveExplicitPath(repoPath, shapeArg);
    if (!existsSync(shapePath)) {
      throw new Error(`未找到需求草案文件: ${shapePath}`);
    }
    return shapePath;
  }

  const candidates = listDemandShapeCandidates(repoPath);
  if (candidates.length === 0) {
    throw new Error(
      `在 ${join(repoPath, '.tekon', 'drafts')} 目录下未找到需求草案文件。请先使用 tekon draft new 创建需求草案。`,
    );
  }

  const latest = candidates[0];
  if (options.latestMustBeApproved && !latest.shape.approved) {
    throw new Error(
      `最新的需求草案尚未批准: ${latest.path}。请运行 tekon draft approve 或使用 --draft-file <path> 指定已批准的草案。`,
    );
  }
  if (options.latestMustBeUnapproved && latest.shape.approved) {
    throw new Error(
      `最新的需求草案已经批准: ${latest.path}。如需批准历史草案，请使用 --shape <path> 参数指定。`,
    );
  }

  return latest.path;
}

export function resolveExplicitPath(
  repoPath: string,
  inputPath: string,
): string {
  if (inputPath.startsWith('/')) {
    return inputPath;
  }
  const cwdPath = resolve(process.cwd(), inputPath);
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  return resolve(repoPath, inputPath);
}

export function listDemandShapeCandidates(
  repoPath: string,
): Array<{
  path: string;
  shape: DemandShape;
  mtimeMs: number;
}> {
  const candidates: Array<{
    path: string;
    shape: DemandShape;
    mtimeMs: number;
  }> = [];

  const dirs = [
    join(repoPath, '.tekon', 'drafts'),
    join(repoPath, '.tekon', 'demands'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const shapePath = join(dir, entry);
      try {
        candidates.push({
          path: shapePath,
          shape: readDemandShapeFile(shapePath),
          mtimeMs: statSync(shapePath).mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return candidates.sort((left, right) => {
    const createdCompare = right.shape.createdAt.localeCompare(
      left.shape.createdAt,
    );
    if (createdCompare !== 0) {
      return createdCompare;
    }
    const mtimeCompare = right.mtimeMs - left.mtimeMs;
    if (mtimeCompare !== 0) {
      return mtimeCompare;
    }
    return right.path.localeCompare(left.path);
  });
}
