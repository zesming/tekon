import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface RepoTextPreview {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

export function resolveRepoReadableFile(input: {
  repoPath: string;
  path: string;
}): string | null {
  const logicalRepoRoot = resolve(input.repoPath);
  const realRepoRootPath = realRepoRoot(logicalRepoRoot);
  if (!realRepoRootPath) {
    return null;
  }

  const candidate = isAbsolute(input.path)
    ? resolve(input.path)
    : resolve(logicalRepoRoot, input.path);
  if (!isSubpath(candidate, logicalRepoRoot) || !existsSync(candidate)) {
    return null;
  }

  try {
    lstatSync(candidate);
    const realTarget = realpathSync(candidate);
    if (!isSubpath(realTarget, realRepoRootPath)) {
      return null;
    }
    const stat = statSync(realTarget);
    return stat.isFile() ? realTarget : null;
  } catch {
    return null;
  }
}

export function readRepoTextFile(input: {
  repoPath: string;
  path: string;
  maxBytes?: number;
}): string | null {
  const filePath = resolveRepoReadableFile(input);
  if (!filePath) {
    return null;
  }

  try {
    const maxBytes = input.maxBytes;
    if (!maxBytes || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      return readFileSync(filePath, 'utf8');
    }
    const stat = statSync(filePath);
    const buffer = Buffer.alloc(Math.min(stat.size, Math.floor(maxBytes)));
    const fd = openSync(filePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readRepoTextPreview(input: {
  repoPath: string;
  path: string;
  maxContentChars: number;
}): RepoTextPreview {
  const filePath = resolveRepoReadableFile(input);
  if (!filePath) {
    return {
      path: input.path,
      exists: false,
      content: '',
      truncated: false,
      sizeBytes: 0,
    };
  }

  try {
    const stat = statSync(filePath);
    const maxContentChars = normalizeMaxContentChars(input.maxContentChars);
    const maxBytes = Math.min(stat.size, maxContentChars * 4 + 16);
    const buffer = Buffer.alloc(maxBytes);
    const fd = openSync(filePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
      const decoded = buffer.subarray(0, bytesRead).toString('utf8');
      const content = decoded.slice(0, maxContentChars);
      return {
        path: input.path,
        exists: true,
        content,
        truncated: stat.size > bytesRead || decoded.length > maxContentChars,
        sizeBytes: stat.size,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return {
      path: input.path,
      exists: false,
      content: '',
      truncated: false,
      sizeBytes: 0,
    };
  }
}

function realRepoRoot(repoPath: string): string | null {
  try {
    return realpathSync(resolve(repoPath));
  } catch {
    return null;
  }
}

function isSubpath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function normalizeMaxContentChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 4_000;
  }
  return Math.min(Math.floor(value), 20_000);
}
