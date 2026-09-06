import {
  createHumanApprovalSummary,
  readRunRecovery,
  type RunRecovery,
} from '@tekon/core';

import type { ServerContext, DecisionInput } from '../context.js';
import { ApiError } from '../errors.js';
import { assertSessionToken } from '../common.js';
import { assertRunCanResume } from '../agents.js';
import { assertRunInScope, listGates, listHumanDecisions } from '../queries.js';
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
      }) as {
        gates: ReturnType<typeof mapGate>[];
        pendingDecisions: ReturnType<typeof mapHumanDecision>[];
      };
    },

    async approve(decisionInput: DecisionInput) {
      return updateDecision({
        context,
        input: decisionInput,
        status: 'approved',
        gateStatus: 'passed',
        gateFailureClassification: null,
      });
    },

    async reject(decisionInput: DecisionInput) {
      return updateDecision({
        context,
        input: decisionInput,
        status: 'rejected',
        gateStatus: 'failed',
        gateFailureClassification: 'human-rejected',
      });
    },
  };
}

async function updateDecision(input: {
  context: ServerContext;
  input: DecisionInput;
  status: 'approved' | 'rejected';
  gateStatus: 'passed' | 'failed';
  gateFailureClassification: string | null;
}): Promise<{
  decision: ReturnType<typeof mapHumanDecision>;
  sessionId?: string;
  jobId?: string;
  resumeOutcome?: string;
  resumeMessage?: string;
  recovery?: RunRecovery;
}> {
  const { context } = input;
  const { repositories, audit, projectContext, db } = context;
  assertSessionToken(projectContext, input.input.token);
  assertRunInScope(db, projectContext, input.input.runId);
  const existing = db
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

  // M8/MF3: a terminal run cannot be revived by approve (resume) OR reject
  // (blocked → resume). The core rejectHumanGate is bypassed by this inline
  // implementation, so the terminal check must live here for both branches.
  const workflow = await repositories.getWorkflowInstance(existing.run_id);
  if (workflow && ['passed', 'failed', 'cancelled'].includes(workflow.status)) {
    throw new ApiError(
      'BAD_REQUEST',
      `Run is in terminal status: ${workflow.status}`,
    );
  }

  if (input.status === 'approved') {
    await assertRunCanResume({ repositories, runId: existing.run_id });
  }

  // Approval must not record a decision when the current exit uncertainty
  // can already be identified. Admission rechecks this snapshot in its write
  // transaction, so a racing generation can still refuse after approval.
  if (input.status === 'approved') {
    const recovery = readRunRecovery(db, existing.run_id).resumeRecovery;
    if (recovery && (recovery.requiresConfirmation || input.input.confirmStopped)) {
      if (!input.input.confirmStopped || input.input.previousJobId !== recovery.previousJobId) {
        throw new ApiError('CONFLICT', `旧进程退出未确认或确认已过期；确认已停止旧执行后重试，previousJobId=${recovery.previousJobId ?? 'null'}`);
      }
    }
  }

  const active = await context.jobs.findActiveByRunId(existing.run_id);
  if (active) {
    throw new ApiError(
      'CONFLICT',
      'Run already has an active job; cancel it or wait for it to finish.',
    );
  }

  const decidedAt = new Date().toISOString();
  // CAS on status='pending' (SHOULD): a concurrent approve/reject that already
  // flipped this decision makes changes=0 → null here → 409, so only one writer
  // proceeds to mutate gate/node/audit and enqueue. Prevents duplicate
  // human.gate.* audit events and double resume jobs under a double-submit.
  const decision = await repositories.updateHumanDecision(
    input.input.decisionId,
    {
      status: input.status,
      actor: input.input.actor,
      note: input.input.note ?? null,
      decidedAt,
    },
    'pending',
  );
  if (!decision) {
    throw new ApiError(
      'CONFLICT',
      `Decision was already decided concurrently: ${input.input.decisionId}`,
    );
  }

  const mappedDecision = {
    decision: redactObject(mapHumanDecisionRow(db, decision)) as ReturnType<
      typeof mapHumanDecision
    >,
  };

  if (input.status === 'approved') {
    try {
      if (existing.gate_result_id) {
        await repositories.updateGateResultStatus(existing.gate_result_id, {
          status: input.gateStatus,
          failureClassification: input.gateFailureClassification,
        });
      }
      await repositories.transitionNode(existing.node_id, 'running');
      await repositories.transitionNode(existing.node_id, 'awaiting-gate');
      await audit.append({
        runId: existing.run_id,
        type: 'human.gate.approved',
        payload: {
          decisionId: existing.id,
          nodeId: existing.node_id,
          actor: input.input.actor,
        },
      });
      const result = await context.sessionService.resumeRun({
        runId: existing.run_id,
        afterApproval: true,
        confirmStopped: input.input.confirmStopped,
        previousJobId: input.input.previousJobId,
      });
      if (result.outcome === 'enqueued') return {
        ...mappedDecision,
        resumeOutcome: result.outcome,
        sessionId: result.sessionId,
        jobId: result.jobId,
      };
      return {
        ...mappedDecision,
        resumeOutcome: result.outcome,
        resumeMessage: `审批已记录，运行尚未恢复（${result.outcome}）。请刷新后检查运行状态及旧执行退出情况。`,
        recovery: readRunRecovery(db, existing.run_id),
      };
    } catch (error) {
      // A recorded decision is durable even if recovery admission fails.
      return {
        ...mappedDecision,
        resumeOutcome: 'error',
        resumeMessage: `审批已记录，运行尚未恢复：${redactObject(error instanceof Error ? error.message : String(error))}`,
      };
    }
  }

  if (existing.gate_result_id) {
    await repositories.updateGateResultStatus(existing.gate_result_id, {
      status: input.gateStatus,
      failureClassification: input.gateFailureClassification,
    });
  }

  // reject: block the node synchronously; no resume (MF3 guard already applied).
  // A3: use a CAS (paused → blocked) as the second line of defense so a
  // concurrent cancel that already wrote a terminal status is NOT overwritten by
  // this unconditional block (which would re-open resume). At a human gate the
  // run is paused; if it is no longer paused (cancel won the race), the CAS
  // no-ops and the terminal status stands. The node transition still records the
  // reviewer's decision on the node.
  await repositories.transitionNode(existing.node_id, 'blocked');
  const blocked = await repositories.casWorkflowInstanceStatus(
    existing.run_id,
    'paused',
    'blocked',
    existing.node_id,
  );
  if (!blocked.changed) {
    // The run left paused underneath us (e.g. a concurrent cancel). Do not
    // resurrect a terminal run; the decision + node block still recorded above.
    const current = await repositories.getWorkflowInstance(existing.run_id);
    if (current && ['passed', 'failed', 'cancelled'].includes(current.status)) {
      throw new ApiError(
        'CONFLICT',
        `Run reached terminal status ${current.status} before the rejection was applied.`,
      );
    }
  }
  await audit.append({
    runId: existing.run_id,
    type: 'human.gate.rejected',
    payload: {
      decisionId: existing.id,
      nodeId: existing.node_id,
      actor: input.input.actor,
    },
  });
  return mappedDecision;
}
