import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactType } from '../../types/domain.js';
import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import { validateArtifactContent } from '../../artifact/schemas.js';
import {
  type GateRunnerInput,
  makeGateResult,
  semanticGateOutputPath,
} from '../helpers.js';
import type { GateDefinition } from '../registry.js';

export function schemaGateDefinition(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition {
  return {
    type: 'schema',
    category: 'validation',
    tags: ['schema', 'validation'],
    metadata: {
      commandLike: false,
      humanBlocking: false,
      supportsNotApplicable: false,
      requiredEvidence: ['artifact'],
      sideEffect: 'none',
      riskTags: ['quality'],
    },
    runner: async (input: GateRunnerInput) =>
      runSchemaGate(input, deps.repositories),
  };
}

async function runSchemaGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const artifactType = input.gate.artifactType;
  if (!artifactType) {
    writeFileSync(outputPath, 'missing artifact type for schema gate', 'utf8');
    return makeGateResult(input, 'failed', 'missing-artifact-type', outputPath);
  }

  const artifacts = await repositories.listArtifacts(
    input.runId,
    input.nodeId,
    artifactType,
  );

  if (artifacts.length === 0) {
    writeFileSync(
      outputPath,
      `missing artifact: ${artifactType ?? 'unspecified'}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'missing-artifact', outputPath);
  }

  const latestArtifact = artifacts.at(-1)!;
  try {
    const content = readFileSync(
      join(input.artifactRoot ?? input.cwd, latestArtifact.path),
      'utf8',
    );
    validateArtifactContent(artifactType, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      outputPath,
      `invalid artifact ${latestArtifact.path}: ${message}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'invalid-artifact', outputPath);
  }

  writeFileSync(
    outputPath,
    `schema gate passed for ${artifactType}: ${latestArtifact.path}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}
