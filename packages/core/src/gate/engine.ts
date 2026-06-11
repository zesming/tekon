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
import { resolveRepoReadableFile } from '../repo/safe-path.js';
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
          gateKey: input.gate.gateKey,
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
            gateKey: input.gate.gateKey,
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
    `${input.nodeId}-${gateLogName(input.gate)}.log`,
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
  const currentNode = await repositories.getNode(input.nodeId);
  if (!currentNode) {
    writeFileSync(outputPath, `node not found: ${input.nodeId}`, 'utf8');
    return makeGateResult(input, 'failed', 'missing-node', outputPath);
  }
  const reviewerRoleRun = await repositories.getLatestRoleRunForNode(
    input.runId,
    input.nodeId,
  );
  if (
    !reviewerRoleRun ||
    reviewerRoleRun.role !== currentNode.role ||
    reviewerRoleRun.status !== 'passed' ||
    !reviewerRoleRun.completedAt
  ) {
    writeFileSync(
      outputPath,
      `missing completed reviewer role run for ${input.nodeId}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'missing-reviewer-role-run',
      outputPath,
    );
  }
  const targetNode = await repositories.getNode(process.targetNodeId);
  if (!targetNode || targetNode.runId !== input.runId) {
    writeFileSync(
      outputPath,
      `review target node not found: ${process.targetNodeId}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'missing-review-target', outputPath);
  }
  if (process.targetRole !== targetNode.role) {
    writeFileSync(
      outputPath,
      `targetRole ${process.targetRole} does not match target node role ${targetNode.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'target-role-mismatch', outputPath);
  }
  if (process.reviewerRole !== currentNode.role) {
    writeFileSync(
      outputPath,
      `reviewerRole ${process.reviewerRole} does not match node role ${currentNode.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-mismatch', outputPath);
  }
  if (!isReviewTargetConnected(currentNode, targetNode.id)) {
    writeFileSync(
      outputPath,
      `review target ${targetNode.id} is not an upstream input or dependency of ${currentNode.id}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'review-target-out-of-flow',
      outputPath,
    );
  }
  const expectedTargetTypes =
    expectedReviewTargetTypesByArtifact[loaded.artifact.type as ArtifactType];
  if (
    expectedTargetTypes &&
    !targetNode.outputs.some((output) =>
      expectedTargetTypes.includes(output.type),
    )
  ) {
    writeFileSync(
      outputPath,
      `${loaded.artifact.type} target ${targetNode.id} must produce one of: ${expectedTargetTypes.join(', ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'review-target-artifact-mismatch',
      outputPath,
    );
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
  const allowedForArtifact =
    allowedReviewScopesByArtifact[loaded.artifact.type as ArtifactType];
  if (allowedForArtifact && !allowedForArtifact.includes(reviewScope)) {
    writeFileSync(
      outputPath,
      `${reviewScope} is not allowed for ${loaded.artifact.type}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'artifact-scope-violation',
      outputPath,
    );
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

const allowedReviewScopesByArtifact: Partial<Record<ArtifactType, string[]>> = {
  'code-review': ['code-change'],
  'demand-review': ['demand-quality'],
  'qa-release-signoff-review': ['release-signoff'],
  'requirement-interface-review': ['requirement-interface'],
  'technical-review': ['technical-design', 'implementation-risk'],
  'test-plan-review': ['test-plan', 'test-plan-intent'],
};

const expectedReviewTargetTypesByArtifact: Partial<
  Record<ArtifactType, ArtifactType[]>
> = {
  'code-review': ['code-changes'],
  'demand-review': ['demand-card', 'prd', 'demand-review'],
  'qa-release-signoff-review': ['qa-release-signoff'],
  'requirement-interface-review': ['demand-card', 'prd', 'demand-review'],
  'technical-review': ['implementation-plan'],
  'test-plan-review': ['test-plan'],
};

function isReviewTargetConnected(node: Node, targetNodeId: string): boolean {
  return (
    node.inputs.some((input) => input.fromNodeId === targetNodeId) ||
    node.dependencies.includes(targetNodeId)
  );
}

async function runAcceptanceEvidenceGate(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
): Promise<GateResult> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, repositories, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }
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

  const gateValidation = await validateEvidenceAnchors(
    input,
    repositories,
    loaded.payload.criteriaEvidence ?? [],
    outputPath,
  );
  if (gateValidation) {
    return gateValidation;
  }

  const passed = new Set(
    (loaded.payload.criteriaEvidence ?? [])
      .filter((evidence) => evidence.status === 'passed')
      .map((evidence) => evidence.criterionId),
  );
  const unknown = [...passed].filter((id) => !criteria.has(id));
  if (unknown.length > 0) {
    writeFileSync(
      outputPath,
      `unknown AC evidence: ${unknown.join(', ')}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'unknown-ac-evidence', outputPath);
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

async function validateEvidenceAnchors(
  input: GateEngineRunInput,
  repositories: TekonRepositories,
  criteriaEvidence: NonNullable<ArtifactPayload['criteriaEvidence']>,
  outputPath: string,
): Promise<GateResult | null> {
  const gateResults = new Map(
    (await repositories.listGateResults(input.runId)).map((gate) => [
      gate.id,
      gate,
    ]),
  );
  const artifacts = new Map(
    (await repositories.listArtifacts(input.runId)).map((artifact) => [
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
      writeFileSync(
        outputPath,
        `missing evidence anchor for ${evidence.criterionId}`,
        'utf8',
      );
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
        writeFileSync(
          outputPath,
          `missing evidence artifact: ${artifactId}`,
          'utf8',
        );
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
        writeFileSync(
          outputPath,
          `missing evidence gate result: ${gateResultId}`,
          'utf8',
        );
        return makeGateResult(
          input,
          'failed',
          'missing-evidence-gate',
          outputPath,
        );
      }
      if (!['passed', 'skipped'].includes(gate.status)) {
        writeFileSync(
          outputPath,
          `evidence gate result is not passed: ${gateResultId} ${gate.status}`,
          'utf8',
        );
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
        writeFileSync(outputPath, `missing evidence output: ${path}`, 'utf8');
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
  const expectedRef = await latestQaValidationRef(input.runId, repositories);
  if (!expectedRef) {
    writeFileSync(
      outputPath,
      'QA validation tested delivery ref is missing',
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'missing-qa-validation-ref',
      outputPath,
    );
  }
  if (expectedRef && loaded.payload.targetRef !== expectedRef) {
    writeFileSync(
      outputPath,
      `QA signoff ref does not match tested delivery ref: target=${loaded.payload.targetRef} expected=${expectedRef}`,
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
  const gateValidation = await validateEvidenceAnchors(
    input,
    repositories,
    criteriaEvidence,
    outputPath,
  );
  if (gateValidation) {
    return gateValidation;
  }
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
  const passed = new Set(criteriaEvidence.map((item) => item.criterionId));
  const missing = [...criteria.keys()].filter((id) => !passed.has(id));
  if (missing.length > 0) {
    writeFileSync(
      outputPath,
      `QA signoff missing passed AC evidence: ${missing.join(', ')}`,
      'utf8',
    );
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

async function latestQaValidationRef(
  runId: string,
  repositories: TekonRepositories,
): Promise<string | undefined> {
  const events = await repositories.listAuditEvents(runId);
  return events
    .filter((event) => event.type === 'qa.validation.ref')
    .map((event) =>
      typeof event.payload.ref === 'string' ? event.payload.ref : undefined,
    )
    .filter((ref): ref is string => Boolean(ref))
    .at(-1);
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
  const actualNodes = await repositories.listNodes(input.runId);
  const currentIndex = actualNodes.findIndex(
    (node) => node.id === input.nodeId,
  );
  if (currentIndex < 0) {
    writeFileSync(outputPath, `node not found: ${input.nodeId}`, 'utf8');
    return makeGateResult(input, 'failed', 'missing-node', outputPath);
  }
  const actualById = new Map(actualNodes.map((node) => [node.id, node]));
  const expectedPriorNodes = actualNodes.slice(0, currentIndex);
  const requiredById = new Map(
    requiredNodes.map((node) => [node.nodeId, node]),
  );
  const unknownRequired = requiredNodes.filter(
    (node) => !actualById.has(node.nodeId),
  );
  if (unknownRequired.length > 0) {
    writeFileSync(
      outputPath,
      `unknown process nodes: ${unknownRequired.map((node) => node.nodeId).join(', ')}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'process-incomplete', outputPath);
  }
  const missingRequired = expectedPriorNodes.filter(
    (node) => !requiredById.has(node.id),
  );
  const incomplete = expectedPriorNodes.filter(
    (node) =>
      !['passed', 'skipped'].includes(node.status) ||
      requiredById.get(node.id)?.status !== node.status,
  );
  const artifactEvidence = loaded.payload.artifactEvidence ?? [];
  const gateEvidence = loaded.payload.gateEvidence ?? [];
  const actualArtifacts = await repositories.listArtifacts(input.runId);
  const actualGates = await repositories.listGateResults(input.runId);
  const humanDecisions = await repositories.listHumanDecisions(input.runId);
  const artifactEvidenceKeys = new Set(
    artifactEvidence.map((item) => `${item.nodeId}:${item.type}`),
  );
  const missingArtifactEvidence = expectedPriorNodes.flatMap((node) =>
    node.outputs
      .filter(
        (output) =>
          !artifactEvidenceKeys.has(`${node.id}:${output.type}`) ||
          !actualArtifacts.some(
            (artifact) =>
              artifact.nodeId === node.id && artifact.type === output.type,
          ),
      )
      .map((output) => `${node.id}:${output.type}`),
  );
  const latestGates = latestGateResults(actualGates);
  const gateEvidenceKeys = new Set(
    gateEvidence.map((item) =>
      gateEvidenceKey({
        nodeId: item.nodeId,
        gateType: item.gateType,
        gateKey: item.gateKey,
        status: item.status,
      }),
    ),
  );
  const missingGateEvidence = expectedPriorNodes.flatMap((node) =>
    node.gates
      .filter((gate) => {
        const expectedKey = gateReferenceKey({
          nodeId: node.id,
          gateType: gate.type,
          gateKey: gate.gateKey,
        });
        const actual = latestGates.find(
          (gateResult) => gateResultReferenceKey(gateResult) === expectedKey,
        );
        return (
          !actual ||
          !['passed', 'skipped'].includes(actual.status) ||
          !gateEvidenceKeys.has(
            gateEvidenceKey({
              nodeId: node.id,
              gateType: gate.type,
              gateKey: gate.gateKey,
              status: actual.status,
            }),
          )
        );
      })
      .map((gate) =>
        gateReferenceKey({
          nodeId: node.id,
          gateType: gate.type,
          gateKey: gate.gateKey,
        }),
      ),
  );
  const pendingHumanDecisions = humanDecisions.filter(
    (decision) => decision.status === 'pending',
  );
  const missingInformation = loaded.payload.missingInformation ?? [];
  if (
    expectedPriorNodes.length > 0 &&
    (requiredNodes.length === 0 ||
      missingRequired.length > 0 ||
      incomplete.length > 0)
  ) {
    writeFileSync(
      outputPath,
      `incomplete process nodes: ${
        [
          ...missingRequired.map((node) => node.id),
          ...incomplete.map((node) => node.id),
        ].join(', ') || 'none listed'
      }`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'process-incomplete', outputPath);
  }
  if (missingArtifactEvidence.length > 0) {
    writeFileSync(
      outputPath,
      `missing process artifact evidence: ${missingArtifactEvidence.join(', ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'process-artifact-evidence-missing',
      outputPath,
    );
  }
  if (missingGateEvidence.length > 0) {
    writeFileSync(
      outputPath,
      `missing process gate evidence: ${missingGateEvidence.join(', ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'process-gate-evidence-missing',
      outputPath,
    );
  }
  if (
    pendingHumanDecisions.length > 0 ||
    loaded.payload.humanDecisionEvidence?.pending !==
      pendingHumanDecisions.length
  ) {
    writeFileSync(
      outputPath,
      `pending human decisions: actual=${pendingHumanDecisions.length} reported=${loaded.payload.humanDecisionEvidence?.pending ?? 'missing'}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'process-human-evidence-mismatch',
      outputPath,
    );
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

function latestGateResults(gates: GateResult[]): GateResult[] {
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

function semanticGateOutputPath(input: GateEngineRunInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  return join(
    input.outputDir,
    `${input.nodeId}-${gateLogName(input.gate)}.log`,
  );
}

function gateLogName(gate: Pick<GateConfig, 'type' | 'gateKey'>): string {
  return (gate.gateKey ?? gate.type).replace(/[^A-Za-z0-9._=-]+/gu, '-');
}

function gateResultReferenceKey(gate: GateResult): string {
  return gateReferenceKey({
    nodeId: gate.nodeId,
    gateType: gate.gateType,
    gateKey: gate.gateKey ?? undefined,
  });
}

function gateReferenceKey(input: {
  nodeId: string;
  gateType: string;
  gateKey?: string | null;
}): string {
  return `${input.nodeId}:${input.gateKey ?? input.gateType}`;
}

function gateEvidenceKey(input: {
  nodeId: string;
  gateType: string;
  gateKey?: string | null;
  status: string;
}): string {
  return `${gateReferenceKey(input)}:${input.status}`;
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
    gateKey: input.gate.gateKey,
    status,
    outputPath,
    durationMs: 0,
    retries: 0,
    failureClassification,
    createdAt: new Date().toISOString(),
  };
}
