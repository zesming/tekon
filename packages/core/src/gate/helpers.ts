import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandPolicy } from '../types/config.js';
import type {
  Artifact,
  ArtifactType,
  GateConfig,
  GateResult,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import {
  type ArtifactPayload,
  validateArtifactContent,
} from '../artifact/schemas.js';
import { resolveRepoReadableFile } from '../repo/safe-path.js';

/**
 * Shared input available to all gate runners via the registry.
 */
export interface GateRunnerInput {
  runId: string;
  nodeId: string;
  gate: GateConfig;
  cwd: string;
  artifactRoot?: string;
  outputDir: string;
  policy: CommandPolicy;
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}

// ---------------------------------------------------------------------------
// Gate result construction
// ---------------------------------------------------------------------------

export function makeGateResult(
  input: Pick<GateRunnerInput, 'runId' | 'nodeId' | 'gate'>,
  status: GateResult['status'],
  failureClassification: string | null,
  outputPath?: string,
): GateResult {
  return {
    id: `gate_${randomUUID()}`,
    runId: input.runId,
    nodeId: input.nodeId,
    gateType: input.gate.type,
    gateKey: input.gate.gateKey,
    status,
    outputPath,
    durationMs: 0,
    retries: 0,
    failureClassification,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Output path helpers
// ---------------------------------------------------------------------------

export function semanticGateOutputPath(input: GateRunnerInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  return join(
    input.outputDir,
    `${input.nodeId}-${gateLogName(input.gate)}.log`,
  );
}

export function gateLogName(gate: Pick<GateConfig, 'type' | 'gateKey'>): string {
  return (gate.gateKey ?? gate.type).replace(/[^A-Za-z0-9._=-]+/gu, '-');
}

// ---------------------------------------------------------------------------
// Gate classification
// ---------------------------------------------------------------------------

export function isCommandGate(
  type: GateConfig['type'],
): type is 'build' | 'test' | 'lint' | 'e2e-pass' {
  return ['build', 'test', 'lint', 'e2e-pass'].includes(type);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatGateCommand(
  command: NonNullable<GateConfig['command']>,
): string {
  return [command.tool, ...(command.args ?? [])].join(' ').trim();
}

export function formatHumanGateContext(
  gate: GateConfig,
  result: GateResult,
): string {
  return [
    'request: Human approval is required before this node can continue.',
    `gate: ${result.id} ${gate.type} ${result.status}`,
    `exactCommand: ${gate.command ? formatGateCommand(gate.command) : 'not_applicable'}`,
    `risk: ${gate.type === 'human' ? 'human-control' : 'normal'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Key helpers (used by process-completeness and eval modules)
// ---------------------------------------------------------------------------

export function gateResultReferenceKey(gate: GateResult): string {
  return gateReferenceKey({
    nodeId: gate.nodeId,
    gateType: gate.gateType,
    gateKey: gate.gateKey ?? undefined,
  });
}

export function gateReferenceKey(input: {
  nodeId: string;
  gateType: string;
  gateKey?: string | null;
}): string {
  return `${input.nodeId}:${input.gateKey ?? input.gateType}`;
}

export function gateEvidenceKey(input: {
  nodeId: string;
  gateType: string;
  gateKey?: string | null;
  status: string;
}): string {
  return `${gateReferenceKey(input)}:${input.status}`;
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

export async function latestArtifactPayload(
  input: GateRunnerInput,
  outputPath: string,
): Promise<
  { artifact: Artifact; payload: ArtifactPayload } | { result: GateResult }
> {
  const artifactType = input.gate.artifactType;
  if (!artifactType) {
    return {
      result: makeGateResult(
        input,
        'failed',
        'missing-artifact-type',
        outputPath,
      ),
    };
  }

  const artifacts = await input.repositories.listArtifacts(
    input.runId,
    input.nodeId,
    artifactType,
  );
  if (artifacts.length === 0) {
    return {
      result: makeGateResult(input, 'failed', 'missing-artifact', outputPath),
    };
  }

  const artifact = artifacts.at(-1)!;
  const payload = readArtifactPayload(input, artifact);
  if (!payload) {
    return {
      result: makeGateResult(input, 'failed', 'invalid-artifact', outputPath),
    };
  }
  return { artifact, payload };
}

export function collectAcceptanceCriteria(
  input: GateRunnerInput,
  artifacts: Artifact[],
): Map<string, string> {
  const criteria = new Map<string, string>();
  for (const artifact of artifacts.filter((item) =>
    ['demand-card', 'prd'].includes(item.type),
  )) {
    const payload = readArtifactPayload(input, artifact);
    for (const criterion of payload?.acceptanceCriteria ?? []) {
      criteria.set(criterion.id, criterion.description);
    }
  }
  return criteria;
}

export function readArtifactPayload(
  input: Pick<GateRunnerInput, 'artifactRoot' | 'cwd'>,
  artifact: Artifact,
): ArtifactPayload | null {
  try {
    const content = readFileSync(
      join(input.artifactRoot ?? input.cwd, artifact.path),
      'utf8',
    );
    return validateArtifactContent(artifact.type as ArtifactType, content);
  } catch {
    return null;
  }
}

export async function validateEvidenceAnchors(
  input: GateRunnerInput,
  criteriaEvidence: NonNullable<ArtifactPayload['criteriaEvidence']>,
  outputPath: string,
): Promise<GateResult | null> {
  const gateResults = new Map(
    (await input.repositories.listGateResults(input.runId)).map((gate) => [
      gate.id,
      gate,
    ]),
  );
  const artifacts = new Map(
    (await input.repositories.listArtifacts(input.runId)).map((artifact) => [
      artifact.id,
      artifact,
    ]),
  );
  const repoRoot = input.artifactRoot ?? input.cwd;
  for (const evidence of criteriaEvidence) {
    const artifactIds = evidence.artifactIds ?? [];
    const gateResultIds = evidence.gateResultIds ?? [];
    const outputPaths = evidence.outputPaths ?? [];
    if (
      artifactIds.length === 0 &&
      gateResultIds.length === 0 &&
      outputPaths.length === 0
    ) {
      return makeGateResult(
        input,
        'failed',
        'missing-evidence-anchor',
        outputPath,
      );
    }
    for (const artifactId of artifactIds) {
      const artifact = artifacts.get(artifactId);
      if (
        !artifact ||
        artifact.runId !== input.runId ||
        !resolveRepoReadableFile({ repoPath: repoRoot, path: artifact.path })
      ) {
        return makeGateResult(
          input,
          'failed',
          'missing-evidence-artifact',
          outputPath,
        );
      }
    }
    for (const gateResultId of evidence.gateResultIds ?? []) {
      const gate = gateResults.get(gateResultId);
      if (!gate) {
        return makeGateResult(
          input,
          'failed',
          'missing-evidence-gate',
          outputPath,
        );
      }
      if (!['passed', 'skipped'].includes(gate.status)) {
        return makeGateResult(
          input,
          'failed',
          'failed-evidence-gate',
          outputPath,
        );
      }
    }
    for (const path of outputPaths) {
      if (!resolveRepoReadableFile({ repoPath: repoRoot, path })) {
        return makeGateResult(
          input,
          'failed',
          'missing-evidence-output',
          outputPath,
        );
      }
    }
  }
  return null;
}

export function latestGateResults(gates: GateResult[]): GateResult[] {
  const latest = new Map<string, GateResult>();
  for (const gate of gates) {
    const key = gateResultReferenceKey(gate);
    const existing = latest.get(key);
    if (
      !existing ||
      Date.parse(gate.createdAt) >= Date.parse(existing.createdAt)
    ) {
      latest.set(key, gate);
    }
  }
  return [...latest.values()];
}
