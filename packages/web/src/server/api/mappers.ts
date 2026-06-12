import {
  evaluateHumanApprovalSummary,
  type TekonDatabase,
  type WorkflowInstance,
} from '@tekon/core';

import type {
  ArtifactOutput,
  AuditEventOutput,
  GateOutput,
  HumanDecisionOutput,
  ProjectOutput,
  WorkflowOutput,
} from './context.js';
import type {
  ArtifactRow,
  GateRow,
  HumanDecisionRow,
  NodeRow,
  ProjectRow,
  WorkflowRow,
} from './rows.js';
import { getGate, getNode } from './queries.js';
import { redactObject } from './redaction.js';

export function mapProject(project: ProjectRow): ProjectOutput {
  return {
    id: project.id,
    name: project.name,
    repoPath: project.repo_path,
    createdAt: project.created_at,
  };
}

export function mapWorkflow(run: WorkflowRow): WorkflowOutput {
  return {
    id: run.id,
    projectId: run.project_id,
    demandId: run.demand_id,
    status: run.status,
    currentNodeId: run.current_node_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

export function mapWorkflowFromDomain(run: WorkflowInstance): WorkflowOutput {
  return {
    id: run.id,
    projectId: run.projectId,
    demandId: run.demandId,
    status: run.status,
    currentNodeId: run.currentNodeId ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function mapArtifact(artifact: ArtifactRow): ArtifactOutput {
  return redactObject({
    id: artifact.id,
    runId: artifact.run_id,
    nodeId: artifact.node_id,
    type: artifact.type,
    version: artifact.version,
    path: artifact.path,
    sha256: artifact.sha256,
    sizeBytes: artifact.size_bytes,
    summary: artifact.summary,
    createdAt: artifact.created_at,
  }) as ArtifactOutput;
}

export function mapGate(gate: GateRow): GateOutput {
  return {
    id: gate.id,
    runId: gate.run_id,
    nodeId: gate.node_id,
    gateType: gate.gate_type,
    status: gate.status,
    outputPath: gate.output_path,
    durationMs: gate.duration_ms,
    retries: gate.retries,
    fixAttemptId: gate.fix_attempt_id,
    failureClassification: gate.failure_classification,
    createdAt: gate.created_at,
  };
}

export function mapAuditEvent(
  event: {
    id: string;
    runId: string;
    type: string;
    payload: Record<string, unknown>;
    prevHash?: string | null;
    hash: string;
    createdAt: string;
  },
  nodeById: Map<string, NodeRow>,
): AuditEventOutput {
  const nodeId = stringValue(event.payload.nodeId);
  const gateId =
    stringValue(event.payload.gateResultId) ??
    stringValue(event.payload.gateId);
  const role =
    stringValue(event.payload.role) ??
    (nodeId ? (nodeById.get(nodeId)?.role ?? null) : null);
  return redactObject({
    id: event.id,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
    nodeId,
    gateId,
    role,
    prevHash: event.prevHash ?? null,
    hash: event.hash,
    createdAt: event.createdAt,
  }) as AuditEventOutput;
}

export function matchesAuditFilters(
  event: AuditEventOutput,
  filters: { nodeId?: string; gateId?: string; role?: string },
): boolean {
  if (filters.nodeId && event.nodeId !== filters.nodeId) {
    return false;
  }
  if (filters.gateId && event.gateId !== filters.gateId) {
    return false;
  }
  if (filters.role && event.role !== filters.role) {
    return false;
  }
  return true;
}

export function mapHumanDecision(
  db: TekonDatabase,
  decision: HumanDecisionRow,
  approvalSummary: Awaited<
    ReturnType<typeof import('@tekon/core').createHumanApprovalSummary>
  > | null = null,
): HumanDecisionOutput {
  const gate = getGate(db, decision.gate_result_id);
  const node = getNode(db, decision.node_id);
  return redactObject({
    id: decision.id,
    runId: decision.run_id,
    nodeId: decision.node_id,
    gateResultId: decision.gate_result_id,
    status: decision.status,
    actor: decision.actor,
    note: decision.note,
    createdAt: decision.created_at,
    decidedAt: decision.decided_at,
    context: {
      request: decision.note ?? 'No request context recorded.',
      exactCommand: extractExactCommand(decision.note),
      riskLabel: deriveRiskLabel(decision.note, gate),
      nodeRole: node?.role ?? null,
      approvalSummary,
      approvalEvaluation: approvalSummary
        ? evaluateHumanApprovalSummary(approvalSummary)
        : null,
      gate: gate
        ? {
            id: gate.id,
            type: gate.gate_type,
            status: gate.status,
            nodeId: gate.node_id,
            outputPath: gate.output_path,
            failureClassification: gate.failure_classification,
          }
        : null,
    },
  }) as HumanDecisionOutput;
}

export function mapHumanDecisionRow(
  db: TekonDatabase,
  decision: {
    id: string;
    runId: string;
    nodeId: string;
    gateResultId?: string | null;
    status: string;
    actor?: string | null;
    note?: string | null;
    createdAt: string;
    decidedAt?: string | null;
  },
): HumanDecisionOutput {
  return mapHumanDecision(db, {
    id: decision.id,
    run_id: decision.runId,
    node_id: decision.nodeId,
    gate_result_id: decision.gateResultId ?? null,
    status: decision.status,
    actor: decision.actor ?? null,
    note: decision.note ?? null,
    created_at: decision.createdAt,
    decided_at: decision.decidedAt ?? null,
  });
}

function extractExactCommand(note?: string | null): string {
  if (!note) {
    return 'not recorded';
  }
  const commandLine = /(?:exactCommand|command):\s*([^\n]+)/iu.exec(note);
  if (commandLine?.[1]) {
    return commandLine[1].trim();
  }
  const approvalLine = /Command requires approval:\s*([^\n]+)/iu.exec(note);
  if (approvalLine?.[1]) {
    return approvalLine[1].trim();
  }
  return 'not recorded';
}

function deriveRiskLabel(note: string | null, gate: GateRow | null): string {
  const riskLine = /risk:\s*([a-z-]+)/iu.exec(note ?? '');
  if (riskLine?.[1]) {
    return riskLine[1].toLowerCase();
  }
  if (gate?.gate_type === 'human') {
    return 'human-control';
  }
  if (gate?.failure_classification) {
    return gate.failure_classification;
  }
  return 'normal';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
