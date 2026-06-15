import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  createDeliveryEvidencePackage,
  type DeliveryEvidencePackage,
} from './evidence.js';

export interface PrePullRequestReadinessCheck {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface PrePullRequestReadiness {
  runId: string;
  ready: boolean;
  checks: PrePullRequestReadinessCheck[];
}

export async function evaluatePrePullRequestReadiness(input: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath: string;
}): Promise<PrePullRequestReadiness> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const gates = await input.repositories.listGateResults(input.runId);
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const events = await input.repositories.listAuditEvents(input.runId);
  const deliveryEvidence = await createDeliveryEvidencePackage({
    repositories: input.repositories,
    audit: input.audit,
    runId: input.runId,
    repoPath: input.repoPath,
  });
  const audit = await input.audit.verify(input.runId);
  const validationGates = latestGateResults(
    gates.filter((gate) =>
      ['build', 'test', 'lint', 'e2e-pass'].includes(gate.gateType),
    ),
  );
  const satisfiedValidationGates = validationGates.filter(
    isSatisfiedValidationGate,
  );
  const qaSignoffGates = latestGateResults(
    gates.filter((gate) => gate.gateType === 'qa-signoff'),
  );
  const hasPassedQaSignoffGate = qaSignoffGates.some(
    (gate) => gate.status === 'passed',
  );
  const pendingHuman = decisions.filter(
    (decision) => decision.status === 'pending',
  );
  const templateId = events
    .filter((event) => event.type === 'run.started')
    .map((event) =>
      typeof event.payload.templateId === 'string'
        ? event.payload.templateId
        : undefined,
    )
    .filter((value): value is string => Boolean(value))
    .at(-1);

  const checks: PrePullRequestReadinessCheck[] = [
    {
      id: 'standard-delivery-template',
      passed: templateId === 'standard-delivery',
      evidence: templateId
        ? `workflow template is ${templateId}`
        : 'workflow template evidence missing',
    },
    {
      id: 'workflow-passed',
      passed: workflow.status === 'passed',
      evidence: `workflow status is ${workflow.status}`,
    },
    {
      id: 'audit-valid',
      passed: audit.valid,
      evidence: audit.valid
        ? 'audit hash chain is valid'
        : `audit hash chain is broken at ${audit.brokenEventId}`,
    },
    {
      id: 'validation-gates-passed',
      passed:
        validationGates.length > 0 &&
        validationGates.length === satisfiedValidationGates.length,
      evidence: `${satisfiedValidationGates.length}/${validationGates.length} validation gates passed or explicitly skipped`,
    },
    {
      id: 'no-pending-human-gates',
      passed: pendingHuman.length === 0,
      evidence: `${pendingHuman.length} pending human decisions`,
    },
    {
      id: 'acceptance-criteria-evidenced',
      passed:
        deliveryEvidence.acceptanceEvidence.length > 0 &&
        deliveryEvidence.acceptanceEvidence.every(
          (item) => item.status === 'passed',
        ),
      evidence: `${deliveryEvidence.acceptanceEvidence.filter((item) => item.status === 'passed').length}/${deliveryEvidence.acceptanceEvidence.length} acceptance criteria evidenced`,
    },
    qaSignoffCheck(deliveryEvidence, hasPassedQaSignoffGate),
    governanceGatesCheck(gates),
    {
      id: 'security-scans-passed',
      passed:
        deliveryEvidence.securityScans.length > 0 &&
        deliveryEvidence.securityScans.every(
          (scan) => scan.status === 'passed',
        ),
      evidence: `${deliveryEvidence.securityScans.filter((scan) => scan.status === 'passed').length}/${deliveryEvidence.securityScans.length} security scans passed`,
    },
  ];

  return {
    runId: input.runId,
    ready: checks.every((check) => check.passed),
    checks,
  };
}

export async function assertPrePullRequestReady(input: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath: string;
}): Promise<PrePullRequestReadiness> {
  const readiness = await evaluatePrePullRequestReadiness(input);
  if (!readiness.ready) {
    const failed = readiness.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.id}: ${check.evidence}`)
      .join('; ');
    throw new Error(`run is not ready for PR creation: ${failed}`);
  }
  return readiness;
}

function qaSignoffCheck(
  deliveryEvidence: DeliveryEvidencePackage,
  hasPassedQaSignoffGate: boolean,
): PrePullRequestReadinessCheck {
  const matchingSignoff = deliveryEvidence.qaReleaseSignoffs.find(
    (signoff) =>
      signoff.status === 'passed' &&
      signoff.matchedRef &&
      Boolean(signoff.expectedRef) &&
      deliveryEvidence.acceptanceCriteria.length > 0 &&
      deliveryEvidence.acceptanceCriteria.every((criterion) =>
        signoff.coveredCriteriaIds.includes(criterion.id),
      ),
  );
  return {
    id: 'qa-release-signoff-passed',
    passed: hasPassedQaSignoffGate && Boolean(matchingSignoff),
    evidence:
      deliveryEvidence.qaReleaseSignoffs.length > 0
        ? [
            hasPassedQaSignoffGate
              ? 'qa-signoff gate passed'
              : 'qa-signoff gate missing',
            ...deliveryEvidence.qaReleaseSignoffs.map(
              (signoff) =>
                `${signoff.status} matchedRef=${signoff.matchedRef} expectedRef=${signoff.expectedRef ?? 'missing'} criteriaEvidence=${signoff.criteriaEvidence} artifact=${signoff.artifactId}`,
            ),
          ].join('; ')
        : 'QA release signoff missing',
  };
}

function governanceGatesCheck(
  gates: Array<{
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    status: string;
    failureClassification?: string | null;
    createdAt: string;
  }>,
): PrePullRequestReadinessCheck {
  const requiredGateTypes = [
    'independent-review',
    'role-scope',
    'ac-evidence',
    'qa-signoff',
    'process-completeness',
  ];
  const latest = latestGateResults(
    gates.filter((gate) => requiredGateTypes.includes(gate.gateType)),
  );
  const passedTypes = new Set(
    latest
      .filter((gate) => gate.status === 'passed')
      .map((gate) => gate.gateType),
  );
  const missing = requiredGateTypes.filter((type) => !passedTypes.has(type));
  return {
    id: 'standard-governance-gates-passed',
    passed: missing.length === 0,
    evidence:
      missing.length === 0
        ? `required governance gates passed: ${requiredGateTypes.join(', ')}`
        : `missing passed governance gates: ${missing.join(', ')}`,
  };
}

function isSatisfiedValidationGate(gate: {
  status: string;
  failureClassification?: string | null;
}) {
  return (
    gate.status === 'passed' ||
    (gate.status === 'skipped' &&
      gate.failureClassification === 'not-applicable')
  );
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
