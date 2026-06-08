import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';

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
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
}): Promise<WorkReadinessEvaluation> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const artifacts = await input.repositories.listArtifacts(input.runId);
  const gates = await input.repositories.listGateResults(input.runId);
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const events = await input.repositories.listAuditEvents(input.runId);
  const audit = await input.audit.verify(input.runId);
  const validationGates = latestGateResults(
    gates.filter((gate) =>
      ['build', 'test', 'lint', 'e2e-pass'].includes(gate.gateType),
    ),
  );
  const passedValidationGates = validationGates.filter(
    (gate) => gate.status === 'passed',
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
        validationGates.length === passedValidationGates.length,
      evidence: `${passedValidationGates.length}/${validationGates.length} validation gates passed`,
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
