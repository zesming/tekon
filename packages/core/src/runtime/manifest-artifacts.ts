import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  agentArtifactManifestSchema,
  validateArtifactContent,
} from '../artifact/schemas.js';
import type { Artifact, ArtifactType } from '../types/domain.js';
import type { AgentRunInput } from './agent-adapter.js';

export async function ingestAgentManifestArtifacts(input: {
  runInput: AgentRunInput;
  manifestPath: string;
}): Promise<Artifact[]> {
  if (!input.runInput.artifactStore) {
    return [];
  }
  const manifestPath = resolveExistingManifestPath(
    input.manifestPath,
    input.runInput.outputDir,
  );
  if (!manifestPath) {
    if ((input.runInput.requiredArtifactTypes ?? []).length === 0) {
      return [];
    }
    throw new Error(`missing artifact manifest: ${input.manifestPath}`);
  }

  const manifest = agentArtifactManifestSchema.parse(
    JSON.parse(
      readOutputFile(
        input.runInput.outputDir,
        manifestPath,
        'artifact manifest',
      ),
    ),
  );
  const artifacts: Artifact[] = [];
  for (const entry of manifest.artifacts) {
    const content = readOutputFile(
      input.runInput.outputDir,
      entry.path,
      'artifact file',
    );
    validateArtifactContent(entry.type, content);
    artifacts.push(
      await input.runInput.artifactStore.writeArtifact({
        runId: input.runInput.runContext.runId,
        nodeId: input.runInput.runContext.nodeId,
        type: entry.type,
        content,
        summary: entry.summary,
      }),
    );
  }
  return artifacts;
}

function resolveExistingManifestPath(
  expectedManifestPath: string,
  outputDir: string,
): string | null {
  const candidates = [
    expectedManifestPath,
    'TEKON_ARTIFACT_MANIFEST',
    'manifest.json',
    'artifact-manifest.json',
    'artifacts.manifest.json',
  ];
  for (const candidate of candidates) {
    const resolved = resolveOutputPath(outputDir, candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function readOutputFile(
  outputDir: string,
  path: string,
  label: string,
): string {
  const outputPath = resolveOutputPath(outputDir, path);
  const fileStat = lstatSync(outputPath);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symlink: ${outputPath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a regular file: ${outputPath}`);
  }

  const root = realpathSync(outputDir);
  const target = realpathSync(outputPath);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return readFileSync(outputPath, 'utf8');
  }
  throw new Error(`${label} escapes TEKON_OUTPUT_DIR: ${path}`);
}

export function missingRequiredArtifactTypes(
  required: ArtifactType[] | undefined,
  artifacts: Artifact[],
): ArtifactType[] {
  const seen = new Set(artifacts.map((artifact) => artifact.type));
  return (required ?? []).filter((type) => !seen.has(type));
}

function resolveOutputPath(outputDir: string, path: string): string {
  const root = resolve(outputDir);
  const target = resolve(root, path);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }
  throw new Error(`artifact path escapes TEKON_OUTPUT_DIR: ${path}`);
}
