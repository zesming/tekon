import { validateArtifactContent } from '../artifact/schemas.js';
import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import { readRepoTextFile } from '../repo/safe-path.js';
import type {
  Artifact,
  Demand,
  GateStatus,
  GateResult,
  WorkflowInstance,
} from '../types/domain.js';

export interface AcceptanceCriterionEvidence {
  criterionId: string;
  description: string;
  status: GateStatus | 'unknown';
  evidence: string[];
  artifactIds: string[];
  gateResultIds: string[];
  outputPaths: string[];
}

export interface SecurityScanEvidence {
  gateResultId: string;
  status: GateStatus;
  outputPath?: string | null;
  failureClassification?: string | null;
}

export interface DeliveryEvidencePackage {
  runId: string;
  workflowStatus: WorkflowInstance['status'];
  demand: Pick<Demand, 'id' | 'title' | 'body'>;
  artifacts: Artifact[];
  gates: GateResult[];
  audit: Awaited<ReturnType<AuditLogger['verify']>>;
  testOutputPaths: string[];
  riskGates: string[];
  rollbackPlanPresent: boolean;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  acceptanceEvidence: AcceptanceCriterionEvidence[];
  securityScans: SecurityScanEvidence[];
}

export async function createDeliveryEvidencePackage(input: {
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath?: string;
  testOutputPaths?: string[];
  riskGates?: string[];
}): Promise<DeliveryEvidencePackage> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const demand = await input.repositories.getDemand(workflow.demandId);
  if (!demand) {
    throw new Error(`demand not found: ${workflow.demandId}`);
  }
  const artifacts = await input.repositories.listArtifacts(input.runId);
  const gates = await input.repositories.listGateResults(input.runId);
  const audit = await input.audit.verify(input.runId);
  const project = await input.repositories.getProject(workflow.projectId);
  const repoPath = input.repoPath ?? project?.repoPath;
  const semanticEvidence = repoPath
    ? collectSemanticEvidence(repoPath, artifacts, gates)
    : {
        acceptanceCriteria: [],
        acceptanceEvidence: [],
        securityScans: [],
      };

  return {
    runId: input.runId,
    workflowStatus: workflow.status,
    demand: {
      id: demand.id,
      title: demand.title,
      body: demand.body,
    },
    artifacts,
    gates,
    audit,
    testOutputPaths: input.testOutputPaths ?? [],
    riskGates: input.riskGates ?? [],
    rollbackPlanPresent: artifacts.some(
      (artifact) => artifact.type === 'rollback-plan',
    ),
    ...semanticEvidence,
  };
}

function collectSemanticEvidence(
  repoPath: string,
  artifacts: Artifact[],
  gates: GateResult[],
) {
  const criteria = new Map<string, { id: string; description: string }>();
  const evidenceByCriterion = new Map<string, AcceptanceCriterionEvidence>();

  for (const artifact of artifacts) {
    const payload = readPayload(repoPath, artifact);
    if (!payload) {
      continue;
    }

    for (const criterion of payload.acceptanceCriteria ?? []) {
      criteria.set(criterion.id, {
        id: criterion.id,
        description: criterion.description,
      });
      const existing = evidenceByCriterion.get(criterion.id);
      evidenceByCriterion.set(criterion.id, {
        criterionId: criterion.id,
        description: criterion.description,
        status: existing?.status ?? 'unknown',
        evidence: existing?.evidence ?? [],
        artifactIds: existing?.artifactIds ?? [],
        gateResultIds: existing?.gateResultIds ?? [],
        outputPaths: existing?.outputPaths ?? [],
      });
    }

    for (const item of payload.criteriaEvidence ?? []) {
      const existing =
        evidenceByCriterion.get(item.criterionId) ??
        ({
          criterionId: item.criterionId,
          description:
            criteria.get(item.criterionId)?.description ?? item.criterionId,
          status: 'unknown',
          evidence: [],
          artifactIds: [],
          gateResultIds: [],
          outputPaths: [],
        } satisfies AcceptanceCriterionEvidence);
      existing.status = statusForCriteriaEvidence({
        requestedStatus: item.status,
        artifact,
        gates,
        gateResultIds: item.gateResultIds ?? [],
        currentStatus: existing.status,
      });
      existing.evidence.push(item.evidence);
      existing.artifactIds.push(artifact.id, ...(item.artifactIds ?? []));
      existing.gateResultIds.push(...(item.gateResultIds ?? []));
      existing.outputPaths.push(...(item.outputPaths ?? []));
      evidenceByCriterion.set(item.criterionId, dedupeEvidence(existing));
    }
  }

  const acceptanceCriteria = [...criteria.values()];
  const acceptanceEvidence: AcceptanceCriterionEvidence[] =
    acceptanceCriteria.map((criterion) => {
      const existing = evidenceByCriterion.get(criterion.id);
      if (existing) {
        return existing;
      }
      return {
        criterionId: criterion.id,
        description: criterion.description,
        status: 'unknown',
        evidence: [],
        artifactIds: [],
        gateResultIds: [],
        outputPaths: [],
      };
    });

  return {
    acceptanceCriteria,
    acceptanceEvidence,
    securityScans: latestGateResults(
      gates.filter((gate) => gate.gateType === 'security-scan'),
    ).map((gate) => ({
      gateResultId: gate.id,
      status: gate.status,
      outputPath: gate.outputPath,
      failureClassification: gate.failureClassification,
    })),
  };
}

function statusForCriteriaEvidence(input: {
  requestedStatus: GateStatus | 'unknown';
  artifact: Artifact;
  gates: GateResult[];
  gateResultIds: string[];
  currentStatus: GateStatus | 'unknown';
}): GateStatus | 'unknown' {
  if (input.requestedStatus === 'failed') {
    return 'failed';
  }
  if (input.requestedStatus !== 'passed') {
    return input.currentStatus;
  }

  if (hasPassedReferencedGate(input.gates, input.gateResultIds)) {
    return 'passed';
  }

  if (
    input.artifact.type === 'test-report' &&
    latestGateResults(
      input.gates.filter(
        (gate) =>
          gate.nodeId === input.artifact.nodeId &&
          ['build', 'test', 'lint', 'e2e-pass'].includes(gate.gateType),
      ),
    ).some((gate) => gate.status === 'passed')
  ) {
    return 'passed';
  }

  return input.currentStatus;
}

function hasPassedReferencedGate(
  gates: GateResult[],
  gateResultIds: string[],
): boolean {
  if (gateResultIds.length === 0) {
    return false;
  }
  const gatesById = new Map(gates.map((gate) => [gate.id, gate]));
  return gateResultIds.some((id) => gatesById.get(id)?.status === 'passed');
}

function latestGateResults<
  T extends { nodeId: string; gateType: string; createdAt: string },
>(gates: T[]): T[] {
  const latestByNodeAndType = new Map<string, T>();
  for (const gate of gates) {
    const key = `${gate.nodeId}:${gate.gateType}`;
    const existing = latestByNodeAndType.get(key);
    if (
      !existing ||
      Date.parse(gate.createdAt) >= Date.parse(existing.createdAt)
    ) {
      latestByNodeAndType.set(key, gate);
    }
  }
  return [...latestByNodeAndType.values()];
}

function readPayload(repoPath: string, artifact: Artifact) {
  try {
    const content = readRepoTextFile({
      repoPath,
      path: artifact.path,
      maxBytes: 2_000_000,
    });
    if (!content) {
      return null;
    }
    return validateArtifactContent(artifact.type, content);
  } catch {
    return null;
  }
}

function dedupeEvidence(
  evidence: AcceptanceCriterionEvidence,
): AcceptanceCriterionEvidence {
  return {
    ...evidence,
    evidence: [...new Set(evidence.evidence)],
    artifactIds: [...new Set(evidence.artifactIds)],
    gateResultIds: [...new Set(evidence.gateResultIds)],
    outputPaths: [...new Set(evidence.outputPaths)],
  };
}
