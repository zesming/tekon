import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import type { GateStatus, GateType, WorkflowStatus } from '../types/domain.js';

export interface GateTypeMetrics {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface RunMetrics {
  runId: string;
  workflowStatus: WorkflowStatus;
  demandTitle?: string;
  timeToLocalPackageMs: number | null;
  timeToPrMs: number | null;
  gatePassRate: number;
  gateByType: Record<string, GateTypeMetrics>;
  retryCount: number;
  humanInterventions: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    averageWaitMs: number | null;
  };
  artifactIntegrity: {
    total: number;
    existing: number;
    sha256Matched: number;
    missing: string[];
    mismatched: string[];
  };
  audit: {
    valid: boolean;
    eventCount: number;
    headHash?: string;
    brokenEventId?: string;
  };
  automationRatio: number;
  highRiskActionCount: number;
  worktreeLeases: {
    total: number;
    open: number;
  };
  prUrl: string | null;
}

export async function extractRunMetrics(input: {
  repoPath: string;
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  prUrl?: string | null;
}): Promise<RunMetrics> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const demand = await input.repositories.getDemand(workflow.demandId);
  const artifacts = await input.repositories.listArtifacts(input.runId);
  const gates = await input.repositories.listGateResults(input.runId);
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const events = await input.repositories.listAuditEvents(input.runId);
  const leases = await input.repositories.listWorktreeLeases(input.runId);
  const deliveryPr = await input.repositories.getDeliveryPullRequest(
    input.runId,
  );
  const auditVerification = await input.audit.verify(input.runId);
  const deliveryPackageExists = artifacts.some(
    (artifact) => artifact.type === 'delivery-package',
  );

  const completedGates = gates.filter((gate) =>
    ['passed', 'failed', 'blocked'].includes(gate.status),
  );
  const passedGates = completedGates.filter((gate) => gate.status === 'passed');
  const nonHumanCompleted = completedGates.filter(
    (gate) => gate.gateType !== 'human',
  ).length;
  const automationDenominator = nonHumanCompleted + decisions.length;

  return {
    runId: input.runId,
    workflowStatus: workflow.status,
    demandTitle: demand?.title,
    timeToLocalPackageMs:
      workflow.status === 'passed' && deliveryPackageExists
        ? Date.parse(workflow.updatedAt) - Date.parse(workflow.createdAt)
        : null,
    timeToPrMs: deliveryPr?.prCreatedAt
      ? Date.parse(deliveryPr.prCreatedAt) - Date.parse(workflow.createdAt)
      : null,
    gatePassRate:
      completedGates.length === 0
        ? 0
        : passedGates.length / completedGates.length,
    gateByType: summarizeGates(gates),
    retryCount:
      gates.reduce((total, gate) => total + gate.retries, 0) +
      events.filter((event) => event.type === 'gate.repair.created').length,
    humanInterventions: summarizeHumanDecisions(decisions),
    artifactIntegrity: verifyArtifacts(input.repoPath, artifacts),
    audit:
      auditVerification.valid === true
        ? {
            valid: true,
            eventCount: events.length,
            headHash: events.at(-1)?.hash,
          }
        : {
            valid: false,
            eventCount: events.length,
            brokenEventId: auditVerification.brokenEventId,
          },
    automationRatio:
      automationDenominator === 0
        ? 0
        : nonHumanCompleted / automationDenominator,
    highRiskActionCount: gates.filter((gate) =>
      ['human', 'security-scan'].includes(gate.gateType),
    ).length,
    worktreeLeases: {
      total: leases.length,
      open: leases.filter((lease) => !lease.releasedAt).length,
    },
    prUrl: deliveryPr?.prUrl ?? input.prUrl ?? null,
  };
}

function summarizeGates(
  gates: Array<{ gateType: GateType; status: GateStatus }>,
): Record<string, GateTypeMetrics> {
  const summary: Record<string, GateTypeMetrics> = {};
  for (const gate of gates) {
    summary[gate.gateType] ??= {
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
    };
    if (isCountedStatus(gate.status)) {
      summary[gate.gateType][gate.status] += 1;
    }
  }
  return summary;
}

function isCountedStatus(
  status: GateStatus,
): status is 'passed' | 'failed' | 'blocked' | 'skipped' {
  return ['passed', 'failed', 'blocked', 'skipped'].includes(status);
}

function summarizeHumanDecisions(
  decisions: Array<{
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    decidedAt?: string | null;
  }>,
): RunMetrics['humanInterventions'] {
  const waits = decisions
    .filter((decision) => decision.decidedAt)
    .map(
      (decision) =>
        Date.parse(decision.decidedAt!) - Date.parse(decision.createdAt),
    );
  return {
    total: decisions.length,
    pending: decisions.filter((decision) => decision.status === 'pending')
      .length,
    approved: decisions.filter((decision) => decision.status === 'approved')
      .length,
    rejected: decisions.filter((decision) => decision.status === 'rejected')
      .length,
    averageWaitMs:
      waits.length === 0
        ? null
        : waits.reduce((total, wait) => total + wait, 0) / waits.length,
  };
}

function verifyArtifacts(
  repoPath: string,
  artifacts: Array<{ path: string; sha256: string }>,
): RunMetrics['artifactIntegrity'] {
  let existing = 0;
  let sha256Matched = 0;
  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const artifact of artifacts) {
    const absolutePath = join(repoPath, artifact.path);
    if (!existsSync(absolutePath)) {
      missing.push(artifact.path);
      continue;
    }

    existing += 1;
    const actual = createHash('sha256')
      .update(readFileSync(absolutePath))
      .digest('hex');
    if (actual === artifact.sha256) {
      sha256Matched += 1;
    } else {
      mismatched.push(artifact.path);
    }
  }

  return {
    total: artifacts.length,
    existing,
    sha256Matched,
    missing,
    mismatched,
  };
}
