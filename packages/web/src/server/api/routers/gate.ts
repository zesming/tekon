import {
  createHumanApprovalSummary,
  type TekonRepositories,
  type AuditLogger,
} from '@tekon/core';

import type { WebProjectContext } from '../../project-context.js';
import type { ServerContext, DecisionInput } from '../context.js';
import { ApiError } from '../errors.js';
import { assertSessionToken } from '../common.js';
import {
  assertRunCanResume,
  resumeWorkflowRun,
} from '../agents.js';
import {
  assertRunInScope,
  listGates,
  listHumanDecisions,
  mustGetRun,
  type TekonDatabase,
} from '../queries.js';
import type { HumanDecisionRow } from '../rows.js';
import { mapGate, mapHumanDecision, mapHumanDecisionRow } from '../mappers.js';
import { redactObject } from '../redaction.js';

export function createGateRouter(context: ServerContext) {
  return {
    async list(gateInput: { runId: string }) {
      assertRunInScope(context.db, context.projectContext, gateInput.runId);
      const pendingDecisions = listHumanDecisions(
        context.db,
        gateInput.runId,
      ).filter((decision) => decision.status === 'pending');
      const summaries = await Promise.all(
        pendingDecisions.map((decision) =>
          createHumanApprovalSummary({
            repoPath: context.projectContext.projectRoot,
            repositories: context.repositories,
            audit: context.audit,
            runId: gateInput.runId,
            decisionId: decision.id,
            maxContentChars: 1_200,
            commandDisplay: 'explicit',
          }),
        ),
      );
      return redactObject({
        gates: listGates(context.db, gateInput.runId).map(mapGate),
        pendingDecisions: pendingDecisions.map((decision, index) =>
          mapHumanDecision(context.db, decision, summaries[index] ?? null),
        ),
      }) as { gates: ReturnType<typeof mapGate>[]; pendingDecisions: ReturnType<typeof mapHumanDecision>[] };
    },

    async approve(decisionInput: DecisionInput) {
      return updateDecision({
        db: context.db,
        repositories: context.repositories,
        audit: context.audit,
        projectContext: context.projectContext,
        input: decisionInput,
        status: 'approved',
        gateStatus: 'passed',
        gateFailureClassification: null,
      });
    },

    async reject(decisionInput: DecisionInput) {
      return updateDecision({
        db: context.db,
        repositories: context.repositories,
        audit: context.audit,
        projectContext: context.projectContext,
        input: decisionInput,
        status: 'rejected',
        gateStatus: 'failed',
        gateFailureClassification: 'human-rejected',
      });
    },
  };
}

async function updateDecision(input: {
  db: TekonDatabase;
  repositories: TekonRepositories;
  audit: AuditLogger;
  projectContext: WebProjectContext;
  input: DecisionInput;
  status: 'approved' | 'rejected';
  gateStatus: 'passed' | 'failed';
  gateFailureClassification: string | null;
}): Promise<{ decision: ReturnType<typeof mapHumanDecision> }> {
  assertSessionToken(input.projectContext, input.input.token);
  assertRunInScope(input.db, input.projectContext, input.input.runId);
  const existing = input.db
    .prepare('select * from human_decisions where id = ? and run_id = ?')
    .get(input.input.decisionId, input.input.runId) as
    | HumanDecisionRow
    | undefined;
  if (!existing) {
    throw new ApiError(
      'NOT_FOUND',
      `Decision not found: ${input.input.decisionId}`,
    );
  }
  if (existing.status !== 'pending') {
    throw new ApiError(
      'BAD_REQUEST',
      `Decision is already ${existing.status}: ${input.input.decisionId}`,
    );
  }
  if (input.status === 'approved') {
    await assertRunCanResume({
      repositories: input.repositories,
      runId: existing.run_id,
    });
  }

  const decidedAt = new Date().toISOString();
  const decision = await input.repositories.updateHumanDecision(
    input.input.decisionId,
    {
      status: input.status,
      actor: input.input.actor,
      note: input.input.note ?? null,
      decidedAt,
    },
  );
  if (!decision) {
    throw new ApiError(
      'NOT_FOUND',
      `Decision not found: ${input.input.decisionId}`,
    );
  }

  if (existing.gate_result_id) {
    await input.repositories.updateGateResultStatus(existing.gate_result_id, {
      status: input.gateStatus,
      failureClassification: input.gateFailureClassification,
    });
  }

  if (input.status === 'approved') {
    await input.repositories.transitionNode(existing.node_id, 'running');
    await input.repositories.transitionNode(existing.node_id, 'awaiting-gate');
    await input.audit.append({
      runId: existing.run_id,
      type: 'human.gate.approved',
      payload: {
        decisionId: existing.id,
        nodeId: existing.node_id,
        actor: input.input.actor,
      },
    });
    await resumeWorkflowRun({
      context: input.projectContext,
      repositories: input.repositories,
      audit: input.audit,
      runId: existing.run_id,
    });
  } else {
    await input.repositories.transitionNode(existing.node_id, 'blocked');
    await input.repositories.updateWorkflowInstanceStatus(
      existing.run_id,
      'blocked',
      existing.node_id,
    );
    await input.audit.append({
      runId: existing.run_id,
      type: 'human.gate.rejected',
      payload: {
        decisionId: existing.id,
        nodeId: existing.node_id,
        actor: input.input.actor,
      },
    });
  }

  return { decision: redactObject(mapHumanDecisionRow(input.db, decision)) as ReturnType<typeof mapHumanDecision> };
}
