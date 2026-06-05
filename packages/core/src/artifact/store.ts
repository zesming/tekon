import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { Artifact, ArtifactType } from '../types/domain.js';
import type { DonkeyRepositories } from '../db/repositories.js';

export interface CreateArtifactStoreOptions {
  repoPath: string;
  repositories: DonkeyRepositories;
  maxPromptChars?: number;
}

export interface WriteArtifactInput {
  runId: string;
  nodeId: string;
  type: ArtifactType;
  content: string;
  summary?: string;
}

export interface ArtifactStore {
  writeArtifact(input: WriteArtifactInput): Promise<Artifact>;
  readArtifact(artifact: Artifact): Promise<string>;
  readArtifactForPrompt(artifact: Artifact): Promise<string>;
}

export function createArtifactStore(options: CreateArtifactStoreOptions): ArtifactStore {
  const maxPromptChars = options.maxPromptChars ?? 16_000;

  return {
    async writeArtifact(input) {
      const runSegment = assertSafePathSegment(input.runId);
      const nodeSegment = assertSafePathSegment(input.nodeId);
      const existing = await options.repositories.listArtifacts(
        input.runId,
        input.nodeId,
        input.type,
      );
      const version =
        existing.reduce((highest, artifact) => Math.max(highest, artifact.version), 0) + 1;
      const relativePath = `.donkey/runs/${runSegment}/artifacts/${nodeSegment}/${input.type}.v${version}.md`;
      const absolutePath = resolveManagedPath(options.repoPath, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, input.content, 'utf8');

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
        createdAt: new Date().toISOString(),
      };

      return options.repositories.recordArtifact(artifact);
    },

    async readArtifact(artifact) {
      const absolutePath = resolveManagedPath(options.repoPath, artifact.path);
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

function resolveManagedPath(repoPath: string, relativePath: string): string {
  const root = resolve(repoPath, '.donkey');
  const target = resolve(repoPath, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`artifact path escapes .donkey: ${relativePath}`);
  }
  return target;
}
