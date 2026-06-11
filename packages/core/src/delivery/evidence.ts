import { validateArtifactContent } from '../artifact/schemas.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
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

export interface CiStatusEvidence {
  artifactId: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped' | 'unknown';
  prUrl?: string;
  checkedAt?: string;
  checks: number;
}

export interface QaReleaseSignoffEvidence {
  artifactId: string;
  status: 'passed' | 'failed' | 'blocked';
  targetRef: string;
  validatedRef: string;
  expectedRef?: string;
  matchedRef: boolean;
  criteriaEvidence: number;
  coveredCriteriaIds: string[];
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
  ciStatuses: CiStatusEvidence[];
  qaReleaseSignoffs: QaReleaseSignoffEvidence[];
}

export async function createDeliveryEvidencePackage(input: {
  repositories: TekonRepositories;
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
  const auditEvents = await input.repositories.listAuditEvents(input.runId);
  const audit = await input.audit.verify(input.runId);
  const project = await input.repositories.getProject(workflow.projectId);
  const repoPath = input.repoPath ?? project?.repoPath;
  const semanticEvidence = repoPath
    ? collectSemanticEvidence(repoPath, artifacts, gates, auditEvents)
    : {
        acceptanceCriteria: [],
        acceptanceEvidence: [],
        securityScans: [],
        ciStatuses: [],
        qaReleaseSignoffs: [],
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
  auditEvents: Awaited<ReturnType<TekonRepositories['listAuditEvents']>>,
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
    ciStatuses: latestCiStatusEvidence(repoPath, artifacts, auditEvents),
    qaReleaseSignoffs: latestQaReleaseSignoffEvidence(
      repoPath,
      artifacts,
      auditEvents,
    ),
  };
}

function latestQaReleaseSignoffEvidence(
  repoPath: string,
  artifacts: Artifact[],
  auditEvents: Awaited<ReturnType<TekonRepositories['listAuditEvents']>>,
): QaReleaseSignoffEvidence[] {
  const expectedRef = latestQaValidationRef(auditEvents);
  const signoffs = artifacts
    .filter((artifact) => artifact.type === 'qa-release-signoff')
    .flatMap((artifact) => {
      const payload = readPayload(repoPath, artifact);
      if (
        !payload?.overallStatus ||
        !payload.targetRef ||
        !payload.validatedRef
      ) {
        return [];
      }
      return [
        {
          artifact,
          evidence: {
            artifactId: artifact.id,
            status: payload.overallStatus,
            targetRef: payload.targetRef,
            validatedRef: payload.validatedRef,
            ...(expectedRef ? { expectedRef } : {}),
            matchedRef:
              payload.targetRef === payload.validatedRef &&
              (!expectedRef || payload.targetRef === expectedRef),
            criteriaEvidence: payload.criteriaEvidence?.length ?? 0,
            coveredCriteriaIds: [
              ...new Set(
                (payload.criteriaEvidence ?? [])
                  .filter((item) => item.status === 'passed')
                  .map((item) => item.criterionId),
              ),
            ],
          } satisfies QaReleaseSignoffEvidence,
        },
      ];
    });

  const latest = signoffs.sort((left, right) => {
    const leftCreated = timestampOrZero(left.artifact.createdAt);
    const rightCreated = timestampOrZero(right.artifact.createdAt);
    if (leftCreated !== rightCreated) {
      return rightCreated - leftCreated;
    }
    return right.artifact.version - left.artifact.version;
  })[0];

  return latest ? [latest.evidence] : [];
}

function latestQaValidationRef(
  auditEvents: Awaited<ReturnType<TekonRepositories['listAuditEvents']>>,
): string | undefined {
  return auditEvents
    .filter((event) => event.type === 'qa.validation.ref')
    .map((event) =>
      typeof event.payload.ref === 'string' ? event.payload.ref : undefined,
    )
    .filter((ref): ref is string => Boolean(ref))
    .at(-1);
}

function latestCiStatusEvidence(
  repoPath: string,
  artifacts: Artifact[],
  auditEvents: Awaited<ReturnType<TekonRepositories['listAuditEvents']>>,
): CiStatusEvidence[] {
  const auditedArtifactIds = new Set(
    auditEvents
      .filter((event) => event.type === 'delivery.ci.checked')
      .map((event) => event.payload.artifactId)
      .filter(
        (artifactId): artifactId is string => typeof artifactId === 'string',
      ),
  );
  const statuses = artifacts
    .filter((artifact) => artifact.type === 'ci-status')
    .filter((artifact) => auditedArtifactIds.has(artifact.id))
    .flatMap((artifact) => {
      const payload = readPayload(repoPath, artifact);
      if (!payload?.ciStatus) {
        return [];
      }
      return [
        {
          artifact,
          evidence: {
            artifactId: artifact.id,
            status: payload.ciStatus,
            prUrl: payload.prUrl,
            checkedAt: payload.checkedAt,
            checks: payload.checks?.length ?? 0,
          } satisfies CiStatusEvidence,
        },
      ];
    });

  const latest = statuses.sort((left, right) => {
    const leftChecked = timestampOrZero(left.evidence.checkedAt);
    const rightChecked = timestampOrZero(right.evidence.checkedAt);
    if (leftChecked !== rightChecked) {
      return rightChecked - leftChecked;
    }
    const leftCreated = timestampOrZero(left.artifact.createdAt);
    const rightCreated = timestampOrZero(right.artifact.createdAt);
    if (leftCreated !== rightCreated) {
      return rightCreated - leftCreated;
    }
    return right.artifact.version - left.artifact.version;
  })[0];

  return latest ? [latest.evidence] : [];
}

function timestampOrZero(value?: string): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
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
  T extends {
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    createdAt: string;
  },
>(gates: T[]): T[] {
  const latestByNodeAndType = new Map<string, T>();
  for (const gate of gates) {
    const key = `${gate.nodeId}:${gate.gateKey ?? gate.gateType}`;
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
