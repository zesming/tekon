import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { Artifact, ArtifactType } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import { scanTextForSecrets } from '../security/secrets.js';

export interface CreateArtifactStoreOptions {
  repoPath: string;
  repositories: TekonRepositories;
  maxPromptChars?: number;
}

export interface WriteArtifactInput {
  runId: string;
  nodeId: string;
  type: ArtifactType;
  content: string;
  summary?: string;
  docKey?: string;
  title?: string;
  pinned?: boolean;
}

export interface ArtifactStore {
  writeArtifact(input: WriteArtifactInput): Promise<Artifact>;
  readArtifact(artifact: Artifact): Promise<string>;
  readArtifactForPrompt(artifact: Artifact): Promise<string>;
}

let tempWriteSeq = 0;

/**
 * Atomic file write inside a verified managed directory: writes to a hidden
 * sibling temp file, fsyncs, and atomically renames into place.
 */
export function writeFileAtomically(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${tempWriteSeq++}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeSync(fd, content, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/**
 * Resolves a path strictly within `<repoPath>/.tekon` and rejects any symlink
 * along the existing prefix or target itself.
 */
export function resolveSafeTekonPath(
  repoPath: string,
  relativePath: string,
): string {
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\0') ||
    relativePath.split(/[\\/]/u).some((segment) => segment === '..')
  ) {
    throw new Error(`artifact path escapes .tekon: ${relativePath}`);
  }
  const repoReal = existsSync(repoPath)
    ? realpathSync(repoPath)
    : resolve(repoPath);
  const root = resolve(repoReal, '.tekon');
  const target = resolve(repoReal, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`artifact path escapes .tekon: ${relativePath}`);
  }

  // Reject symlinks on .tekon itself and every existing component down to target.
  const relFromRepo = relative(repoReal, target);
  const parts = relFromRepo.split(sep).filter(Boolean);
  let cursor = repoReal;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) {
      // Check dangling symlink via lstatSync before breaking.
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          throw new Error(`artifact path contains symlink: ${relativePath}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw err;
        }
      }
      break;
    }
    const lst = lstatSync(cursor);
    if (lst.isSymbolicLink()) {
      throw new Error(`artifact path contains symlink: ${relativePath}`);
    }
    const realCursor = realpathSync(cursor);
    if (
      cursor.startsWith(root) &&
      realCursor !== root &&
      !realCursor.startsWith(`${root}${sep}`)
    ) {
      throw new Error(`artifact path escapes .tekon: ${relativePath}`);
    }
  }

  return target;
}

export function createArtifactStore(
  options: CreateArtifactStoreOptions,
): ArtifactStore {
  const maxPromptChars = options.maxPromptChars ?? 16_000;

  return {
    async writeArtifact(input) {
      const runSegment = assertSafePathSegment(input.runId);
      const nodeSegment = assertSafePathSegment(input.nodeId);
      const docKey = input.docKey ? assertSafePathSegment(input.docKey) : undefined;
      const secretFindings = scanTextForSecrets(
        input.content,
        `${input.runId}/${input.nodeId}/${input.type}`,
      );
      if (secretFindings.length > 0) {
        throw new Error(
          `artifact contains sensitive content: ${secretFindings
            .map((finding) => finding.ruleId)
            .join(',')}`,
        );
      }

      // Cross-node document family versioning when docKey is set; otherwise
      // legacy per-(runId, nodeId, type) versioning.
      let version: number;
      if (docKey) {
        const allRunArtifacts = await options.repositories.listArtifacts(
          input.runId,
        );
        const sameFamily = allRunArtifacts.filter(
          (a) => (a.docKey ?? a.type) === docKey,
        );
        version =
          sameFamily.reduce(
            (highest, artifact) => Math.max(highest, artifact.version),
            0,
          ) + 1;
      } else {
        const existing = await options.repositories.listArtifacts(
          input.runId,
          input.nodeId,
          input.type,
        );
        version =
          existing.reduce(
            (highest, artifact) => Math.max(highest, artifact.version),
            0,
          ) + 1;
      }

      const relativePath = `.tekon/runs/${runSegment}/artifacts/${nodeSegment}/${input.type}.v${version}.md`;
      const absolutePath = resolveSafeTekonPath(options.repoPath, relativePath);
      writeFileAtomically(absolutePath, input.content);

      const artifact: Artifact = {
        id: `artifact_${randomUUID()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        type: input.type,
        version,
        path: relativePath,
        sha256: createHash('sha256').update(input.content).digest('hex'),
        sizeBytes: statSync(absolutePath).size,
        summary: input.summary ?? deriveSummary(input.content),
        ...(docKey ? { docKey } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        createdAt: new Date().toISOString(),
      };

      return options.repositories.recordArtifact(artifact);
    },

    async readArtifact(artifact) {
      const absolutePath = resolveSafeTekonPath(options.repoPath, artifact.path);
      if (!existsSync(absolutePath)) {
        throw new Error(`missing artifact file: ${artifact.path}`);
      }
      return readFileSync(absolutePath, 'utf8');
    },

    async readArtifactForPrompt(artifact) {
      const content = await this.readArtifact(artifact);
      if (content.length <= maxPromptChars) {
        return content;
      }

      return `${content.slice(0, maxPromptChars)}\n\n[truncated artifact: ${content.length - maxPromptChars} chars omitted]`;
    },
  };
}

function deriveSummary(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstNonEmptyLine ?? content.slice(0, 120)).slice(0, 240);
}

function assertSafePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
}
