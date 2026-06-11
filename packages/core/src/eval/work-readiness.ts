import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createDeliveryEvidencePackage } from '../delivery/evidence.js';

export type WorkReadinessSeverity = 'required' | 'recommended';

export interface WorkReadinessCheck {
  id: string;
  severity: WorkReadinessSeverity;
  passed: boolean;
  evidence: string;
}

export interface WorkReadinessEvaluation {
  runId: string;
  ready: boolean;
  score: number;
  checks: WorkReadinessCheck[];
}

export async function evaluateWorkReadiness(input: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath?: string;
}): Promise<WorkReadinessEvaluation> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const artifacts = await input.repositories.listArtifacts(input.runId);
  const gates = await input.repositories.listGateResults(input.runId);
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const events = await input.repositories.listAuditEvents(input.runId);
  const deliveryPr = await input.repositories.getDeliveryPullRequest(
    input.runId,
  );
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
  const pendingHuman = decisions.filter(
    (decision) => decision.status === 'pending',
  );

  const checks: WorkReadinessCheck[] = [
    {
      id: 'workflow-passed',
      severity: 'required',
      passed: workflow.status === 'passed',
      evidence: `workflow status is ${workflow.status}`,
    },
    {
      id: 'audit-valid',
      severity: 'required',
      passed: audit.valid,
      evidence: audit.valid
        ? 'audit hash chain is valid'
        : `audit hash chain is broken at ${audit.brokenEventId}`,
    },
    {
      id: 'validation-gates-passed',
      severity: 'required',
      passed:
        validationGates.length > 0 &&
        validationGates.length === satisfiedValidationGates.length,
      evidence: `${satisfiedValidationGates.length}/${validationGates.length} validation gates passed or explicitly skipped`,
    },
    {
      id: 'delivery-package-present',
      severity: 'required',
      passed: artifacts.some(
        (artifact) => artifact.type === 'delivery-package',
      ),
      evidence: `${artifacts.filter((artifact) => artifact.type === 'delivery-package').length} delivery-package artifacts`,
    },
    {
      id: 'pr-prepared',
      severity: 'required',
      passed: events.some((event) => event.type === 'delivery.pr-prepared'),
      evidence: events.some((event) => event.type === 'delivery.pr-prepared')
        ? 'PR preparation event recorded'
        : 'PR preparation event missing',
    },
    {
      id: 'no-pending-human-gates',
      severity: 'required',
      passed: pendingHuman.length === 0,
      evidence: `${pendingHuman.length} pending human decisions`,
    },
    {
      id: 'acceptance-criteria-evidenced',
      severity: 'required',
      passed:
        deliveryEvidence.acceptanceEvidence.length > 0 &&
        deliveryEvidence.acceptanceEvidence.every(
          (item) => item.status === 'passed',
        ),
      evidence: `${deliveryEvidence.acceptanceEvidence.filter((item) => item.status === 'passed').length}/${deliveryEvidence.acceptanceEvidence.length} acceptance criteria evidenced`,
    },
    {
      id: 'qa-release-signoff-passed',
      severity: 'required',
      passed: deliveryEvidence.qaReleaseSignoffs.some(
        (signoff) =>
          signoff.status === 'passed' &&
          signoff.matchedRef &&
          signoff.criteriaEvidence > 0,
      ),
      evidence:
        deliveryEvidence.qaReleaseSignoffs.length > 0
          ? deliveryEvidence.qaReleaseSignoffs
              .map(
                (signoff) =>
                  `${signoff.status} matchedRef=${signoff.matchedRef} criteriaEvidence=${signoff.criteriaEvidence} artifact=${signoff.artifactId}`,
              )
              .join('; ')
          : 'QA release signoff missing',
    },
    {
      id: 'security-scans-passed',
      severity: 'required',
      passed:
        deliveryEvidence.securityScans.length > 0 &&
        deliveryEvidence.securityScans.every(
          (scan) => scan.status === 'passed',
        ),
      evidence: `${deliveryEvidence.securityScans.filter((scan) => scan.status === 'passed').length}/${deliveryEvidence.securityScans.length} security scans passed`,
    },
    {
      id: 'pr-created',
      severity: 'recommended',
      passed: deliveryPr?.status === 'created' && Boolean(deliveryPr.prUrl),
      evidence:
        deliveryPr?.status === 'created' && deliveryPr.prUrl
          ? `PR created: ${deliveryPr.prUrl}`
          : `PR status is ${deliveryPr?.status ?? 'not-created'}`,
    },
    {
      id: 'remote-ci-passed',
      severity: 'recommended',
      passed: deliveryEvidence.ciStatuses.some(
        (status) => status.status === 'passed',
      ),
      evidence:
        deliveryEvidence.ciStatuses.length > 0
          ? deliveryEvidence.ciStatuses
              .map(
                (status) =>
                  `${status.status} checks=${status.checks} artifact=${status.artifactId}`,
              )
              .join('; ')
          : 'remote CI status not checked',
    },
  ];
  const passed = checks.filter((check) => check.passed).length;
  const requiredChecks = checks.filter(
    (check) => check.severity === 'required',
  );

  return {
    runId: input.runId,
    ready: requiredChecks.every((check) => check.passed),
    score: checks.length === 0 ? 0 : passed / checks.length,
    checks,
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
