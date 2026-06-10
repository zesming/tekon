import { existsSync, readFileSync } from 'node:fs';
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
  if (!existsSync(input.manifestPath)) {
    if ((input.runInput.requiredArtifactTypes ?? []).length === 0) {
      return [];
    }
    throw new Error(`missing artifact manifest: ${input.manifestPath}`);
  }

  const manifest = agentArtifactManifestSchema.parse(
    JSON.parse(readFileSync(input.manifestPath, 'utf8')),
  );
  const artifacts: Artifact[] = [];
  for (const entry of manifest.artifacts) {
    const artifactPath = resolveOutputPath(
      input.runInput.outputDir,
      entry.path,
    );
    const content = readFileSync(artifactPath, 'utf8');
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
