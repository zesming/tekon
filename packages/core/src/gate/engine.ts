import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandPolicy } from '../types/config.js';
import type {
  Artifact,
  ArtifactType,
  GateConfig,
  GateResult,
  Node,
  Role,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import {
  type ArtifactPayload,
  validateArtifactContent,
} from '../artifact/schemas.js';
import { runCommandGate, runSecurityScanGate } from './runners.js';
import { createHumanGate } from './human-gate.js';

export interface GateEngineRunInput {
  runId: string;
  nodeId: string;
  gate: GateConfig;
  cwd: string;
  artifactRoot?: string;
  outputDir: string;
  policy: CommandPolicy;
}

export interface GateEngine {
  runGate(input: GateEngineRunInput): Promise<GateResult>;
  createAutoFixRepairNode(input: {
    failedGateResult: GateResult;
    fixerRole: Role;
  }): Promise<Node>;
}

export function createGateEngine(options: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateEngine {
  return {
    async runGate(input) {
      let result: GateResult;

      if (input.gate.skipReason && isCommandGate(input.gate.type)) {
        result = runSkippedGate(input, input.gate.skipReason);
      } else if (input.gate.type === 'security-scan') {
        result = await runSecurityScanGate({
          gateway: options.gateway,
          runId: input.runId,
          nodeId: input.nodeId,
          cwd: input.cwd,
          command: input.gate.command,
          policy: input.policy,
          outputDir: input.outputDir,
          timeoutMs: input.gate.timeoutMs,
        });
      } else if (isCommandGate(input.gate.type)) {
        if (!options.gateway || !input.gate.command) {
          result = makeGateResult(input, 'failed', 'missing-command');
        } else {
          result = await runCommandGate({
            gateway: options.gateway,
            runId: input.runId,
            nodeId: input.nodeId,
            gateType: input.gate.type,
            cwd: input.cwd,
            command: input.gate.command,
            policy: input.policy,
            outputDir: input.outputDir,
            retries: 0,
            timeoutMs: input.gate.timeoutMs,
          });
        }
      } else if (input.gate.type === 'schema') {
        result = await runSchemaGate(input, options.repositories);
      } else if (input.gate.type === 'independent-review') {
        result = await runIndependentReviewGate(input, options.repositories);
      } else if (input.gate.type === 'role-scope') {
        result = await runRoleScopeGate(input, options.repositories);
      } else if (input.gate.type === 'ac-evidence') {
        result = await runAcceptanceEvidenceGate(input, options.repositories);
      } else if (input.gate.type === 'qa-signoff') {
        result = await runQaSignoffGate(input, options.repositories);
      } else if (input.gate.type === 'process-completeness') {
        result = await runProcessCompletenessGate(input, options.repositories);
      } else if (input.gate.type === 'human') {
        result = makeGateResult(input, 'blocked', 'human-approval');
        await options.repositories.recordGateResult(result);
        await createHumanGate({
          repositories: options.repositories,
        }).requestHumanGate({
          runId: input.runId,
          nodeId: input.nodeId,
          gateResultId: result.id,
          note: formatHumanGateContext(input.gate, result),
        });
        return result;
      } else {
        result = makeGateResult(input, 'failed', 'unsupported-gate');
      }

      return options.repositories.recordGateResult(result);
    },

    async createAutoFixRepairNode(input) {
      const now = new Date().toISOString();
      return options.repositories.createNode({
        id: `repair_${input.failedGateResult.id}`,
        runId: input.failedGateResult.runId,
        role: input.fixerRole,
        status: 'pending',
        inputs: [],
        outputs: [],
        gates: [],
        dependencies: [input.failedGateResult.nodeId],
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

function runSkippedGate(input: GateEngineRunInput, reason: string): GateResult {
  mkdirSync(input.outputDir, { recursive: true });
  const outputPath = join(
    input.outputDir,
    `${input.nodeId}-${input.gate.type}.log`,
  );
  writeFileSync(
    outputPath,
    `gate skipped because it is explicitly marked not applicable\n${reason}\n`,
    'utf8',
  );
  return makeGateResult(input, 'skipped', 'not-applicable', outputPath);
}

function formatHumanGateContext(gate: GateConfig, result: GateResult): string {
  return [
    'request: Human approval is required before this node can continue.',
    `gate: ${result.id} ${gate.type} ${result.status}`,
    `exactCommand: ${gate.command ? formatCommand(gate.command) : 'not_applicable'}`,
    `risk: ${gate.type === 'human' ? 'human-control' : 'normal'}`,
  ].join('\n');
}

function formatCommand(command: NonNullable<GateConfig['command']>): string {
  return [command.tool, ...(command.args ?? [])].join(' ').trim();
}

function isCommandGate(
  type: GateConfig['type'],
): type is 'build' | 'test' | 'lint' | 'e2e-pass' {
  return ['build', 'test', 'lint', 'e2e-pass'].includes(type);
}

async function runSchemaGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  mkdirSync(input.outputDir, { recursive: true });
  const outputPath = join(input.outputDir, `${input.nodeId}-schema.log`);
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

async function runIndependentReviewGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, repositories, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }

  const process = loaded.payload.reviewProcess;
  if (!process) {
    writeFileSync(outputPath, 'missing reviewProcess', 'utf8');
    return makeGateResult(
      input,
      'failed',
      'missing-review-process',
      outputPath,
    );
  }
  if (process.targetNodeId === input.nodeId) {
    writeFileSync(
      outputPath,
      `self review is not independent: ${process.targetNodeId}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'self-review', outputPath);
  }
  if (loaded.payload.decision && loaded.payload.decision !== 'approved') {
    writeFileSync(
      outputPath,
      `review decision is ${loaded.payload.decision}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'review-not-approved', outputPath);
  }

  writeFileSync(
    outputPath,
    `independent review passed for ${loaded.artifact.type}: ${loaded.artifact.path}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

async function runRoleScopeGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, repositories, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }
  const node = await repositories.getNode(input.nodeId);
  if (!node) {
    writeFileSync(outputPath, `node not found: ${input.nodeId}`, 'utf8');
    return makeGateResult(input, 'failed', 'missing-node', outputPath);
  }
  const reviewScope = loaded.payload.reviewScope;
  if (!reviewScope) {
    writeFileSync(outputPath, 'missing reviewScope', 'utf8');
    return makeGateResult(input, 'failed', 'missing-review-scope', outputPath);
  }
  const allowed = allowedReviewScopesByRole[node.role];
  if (!allowed.includes(reviewScope)) {
    writeFileSync(
      outputPath,
      `${reviewScope} is not allowed for ${node.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-scope-violation', outputPath);
  }
  if (
    loaded.payload.reviewProcess &&
    loaded.payload.reviewProcess.reviewerRole !== node.role
  ) {
    writeFileSync(
      outputPath,
      `reviewerRole ${loaded.payload.reviewProcess.reviewerRole} does not match node role ${node.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-mismatch', outputPath);
  }

  writeFileSync(
    outputPath,
    `role scope passed for ${node.role}: ${reviewScope}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

const allowedReviewScopesByRole: Record<Role, string[]> = {
  pm: ['demand-quality', 'test-plan-intent'],
  rd: ['requirement-interface', 'technical-design', 'implementation-risk'],
  qa: ['requirement-interface', 'test-plan', 'validation', 'release-signoff'],
  reviewer: ['code-change'],
  pmo: ['process-completeness', 'delivery-readiness'],
};

async function runAcceptanceEvidenceGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  mkdirSync(input.outputDir, { recursive: true });
  const artifacts = await repositories.listArtifacts(input.runId);
  const criteria = collectAcceptanceCriteria(input, artifacts);
  if (criteria.size === 0) {
    writeFileSync(outputPath, 'missing acceptance criteria', 'utf8');
    return makeGateResult(
      input,
      'failed',
      'missing-acceptance-criteria',
      outputPath,
    );
  }

  const passed = new Set<string>();
  for (const artifact of artifacts) {
    const payload = readArtifactPayload(input, artifact);
    for (const evidence of payload?.criteriaEvidence ?? []) {
      if (evidence.status === 'passed') {
        passed.add(evidence.criterionId);
      }
    }
  }

  const missing = [...criteria.keys()].filter((id) => !passed.has(id));
  if (missing.length > 0) {
    writeFileSync(
      outputPath,
      `missing passed AC evidence: ${missing.join(', ')}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'missing-ac-evidence', outputPath);
  }

  writeFileSync(
    outputPath,
    `AC evidence passed for ${criteria.size} criteria`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

async function runQaSignoffGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, repositories, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }
  if (loaded.payload.overallStatus !== 'passed') {
    writeFileSync(
      outputPath,
      `QA signoff status is ${loaded.payload.overallStatus ?? 'missing'}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'qa-signoff-not-passed', outputPath);
  }
  if (
    !loaded.payload.targetRef ||
    !loaded.payload.validatedRef ||
    loaded.payload.targetRef !== loaded.payload.validatedRef
  ) {
    writeFileSync(
      outputPath,
      `QA signoff ref mismatch: target=${loaded.payload.targetRef ?? 'missing'} validated=${loaded.payload.validatedRef ?? 'missing'}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'qa-signoff-ref-mismatch',
      outputPath,
    );
  }
  const criteriaEvidence = loaded.payload.criteriaEvidence ?? [];
  if (
    criteriaEvidence.length === 0 ||
    criteriaEvidence.some((item) => item.status !== 'passed')
  ) {
    writeFileSync(outputPath, 'QA signoff has non-passed AC evidence', 'utf8');
    return makeGateResult(
      input,
      'failed',
      'qa-signoff-ac-evidence',
      outputPath,
    );
  }

  writeFileSync(
    outputPath,
    `QA signoff passed for ${loaded.payload.targetRef}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

async function runProcessCompletenessGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, repositories, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }
  const requiredNodes = loaded.payload.requiredNodes ?? [];
  const incomplete = requiredNodes.filter((node) => node.status !== 'passed');
  const missingInformation = loaded.payload.missingInformation ?? [];
  if (requiredNodes.length === 0 || incomplete.length > 0) {
    writeFileSync(
      outputPath,
      `incomplete process nodes: ${incomplete.map((node) => node.nodeId).join(', ') || 'none listed'}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'process-incomplete', outputPath);
  }
  if (missingInformation.length > 0) {
    writeFileSync(
      outputPath,
      `missing process information: ${missingInformation.join('; ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'process-missing-information',
      outputPath,
    );
  }

  writeFileSync(
    outputPath,
    `process completeness passed for ${requiredNodes.length} nodes`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

function semanticGateOutputPath(input: GateEngineRunInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  return join(input.outputDir, `${input.nodeId}-${input.gate.type}.log`);
}

async function latestArtifactPayload(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
  outputPath: string,
): Promise<
  { artifact: Artifact; payload: ArtifactPayload } | { result: GateResult }
> {
  const artifactType = input.gate.artifactType;
  if (!artifactType) {
    writeFileSync(outputPath, 'missing artifact type for gate', 'utf8');
    return {
      result: makeGateResult(
        input,
        'failed',
        'missing-artifact-type',
        outputPath,
      ),
    };
  }

  const artifacts = await repositories.listArtifacts(
    input.runId,
    input.nodeId,
    artifactType,
  );
  if (artifacts.length === 0) {
    writeFileSync(outputPath, `missing artifact: ${artifactType}`, 'utf8');
    return {
      result: makeGateResult(input, 'failed', 'missing-artifact', outputPath),
    };
  }

  const artifact = artifacts.at(-1)!;
  const payload = readArtifactPayload(input, artifact);
  if (!payload) {
    writeFileSync(outputPath, `invalid artifact: ${artifact.path}`, 'utf8');
    return {
      result: makeGateResult(input, 'failed', 'invalid-artifact', outputPath),
    };
  }
  return { artifact, payload };
}

function collectAcceptanceCriteria(
  input: GateEngineRunInput,
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

function readArtifactPayload(
  input: GateEngineRunInput,
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

function makeGateResult(
  input: GateEngineRunInput,
  status: GateResult['status'],
  failureClassification: string | null,
  outputPath?: string,
): GateResult {
  return {
    id: `gate_${randomUUID()}`,
    runId: input.runId,
    nodeId: input.nodeId,
    gateType: input.gate.type,
    status,
    outputPath,
    durationMs: 0,
    retries: 0,
    failureClassification,
    createdAt: new Date().toISOString(),
  };
}
