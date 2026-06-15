import { writeFileSync } from 'node:fs';

import type { ArtifactType } from '../../types/domain.js';
import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import {
  type GateRunnerInput,
  makeGateResult,
  semanticGateOutputPath,
  latestArtifactPayload,
  collectAcceptanceCriteria,
  validateEvidenceAnchors,
  gateEvidenceKey,
  gateReferenceKey,
  gateResultReferenceKey,
  latestGateResults,
} from '../helpers.js';
import type { GateDefinition } from '../registry.js';

export function semanticGateDefinitions(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition[] {
  return [
    {
      type: 'ac-evidence',
      category: 'semantic',
      tags: ['acceptance', 'governance', 'evidence'],
      metadata: {
        commandLike: false,
        humanBlocking: false,
        supportsNotApplicable: false,
        requiredEvidence: ['demand-card', 'prd'],
        sideEffect: 'none',
        riskTags: ['quality', 'governance'],
      },
      runner: async (input: GateRunnerInput) =>
        runAcceptanceEvidenceGate(input, deps.repositories),
    },
    {
      type: 'qa-signoff',
      category: 'semantic',
      tags: ['qa', 'governance', 'release'],
      metadata: {
        commandLike: false,
        humanBlocking: false,
        supportsNotApplicable: false,
        requiredEvidence: ['qa-release-signoff-review'],
        sideEffect: 'none',
        riskTags: ['quality', 'governance'],
      },
      runner: async (input: GateRunnerInput) =>
        runQaSignoffGate(input, deps.repositories),
    },
    {
      type: 'process-completeness',
      category: 'semantic',
      tags: ['process', 'governance', 'completeness'],
      metadata: {
        commandLike: false,
        humanBlocking: false,
        supportsNotApplicable: false,
        requiredEvidence: ['process-completeness-review'],
        sideEffect: 'none',
        riskTags: ['quality', 'governance'],
      },
      runner: async (input: GateRunnerInput) =>
        runProcessCompletenessGate(input, deps.repositories),
    },
  ];
}

// ---------------------------------------------------------------------------
// AC evidence runner
// ---------------------------------------------------------------------------

async function runAcceptanceEvidenceGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, outputPath);
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

// ---------------------------------------------------------------------------
// QA signoff runner
// ---------------------------------------------------------------------------

async function runQaSignoffGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, outputPath);
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
  const unknown = [...passed].filter((id) => !criteria.has(id));
  if (unknown.length > 0) {
    writeFileSync(
      outputPath,
      `QA signoff unknown AC evidence: ${unknown.join(', ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'qa-signoff-ac-evidence',
      outputPath,
    );
  }
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

// ---------------------------------------------------------------------------
// Process completeness runner
// ---------------------------------------------------------------------------

async function runProcessCompletenessGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, outputPath);
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
  const latest = latestGateResults(actualGates);
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
        const actual = latest.find(
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
