import { createHumanApprovalSummary } from '@tekon/core';

import type { ServerContext, DecisionInput } from '../context.js';
import { ApiError } from '../errors.js';
import { assertSessionToken } from '../common.js';
import { assertRunCanResume } from '../agents.js';
import {
  assertRunInScope,
  listGates,
  listHumanDecisions,
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

  // MF2/S1 (mirror project.resume): a run may have at most one active job.
  // Reclaim safe stale jobs (queued + stale-paused, S3), then reject if a live
  // job (running/cancelling/live-paused) still owns the run. This guards BOTH
  // branches: approve would enqueue a second resume job (double-drive); reject
  // must not flip the decision/node while a resume job is mid-flight, because
  // its run-level CAS (paused→blocked) would no-op against a `running` run and
  // return a misleading success with the run left non-blocked. Checked BEFORE
  // the decision flip so a loser 409s with no side effects.
  await context.jobs.cancelStaleActiveJobs(existing.run_id);
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

  if (existing.gate_result_id) {
    await repositories.updateGateResultStatus(existing.gate_result_id, {
      status: input.gateStatus,
      failureClassification: input.gateFailureClassification,
    });
  }

  const mappedDecision = { decision: redactObject(
    mapHumanDecisionRow(db, decision),
  ) as ReturnType<typeof mapHumanDecision> };

  if (input.status === 'approved') {
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
    // M9: resume runs asynchronously via the job runner (no blocking resume;
    // preserves P0-02 cancellability). The single-active-job guard + stale
    // reclaim already ran above (before the decision flip); here we just bind a
    // session and enqueue the workflow-resume job.
    let session = await context.sessions.findSessionByRunId(existing.run_id);
    if (!session) {
      const workspace = await context.sessions.getOrCreateDefaultWorkspace(
        projectContext.projectRoot,
      );
      session = await context.sessions.createSession({
        workspaceId: workspace.id,
        title: null,
        profile: 'human-web',
        runId: existing.run_id,
      });
    }
    // F5-P0-01: same atomic guard as SessionService.resumeRun. gate.approve is
    // a second concurrent-resume entry point (two approvals, or approval + a
    // `tekon resume`, could both enqueue a workflow-resume job for one run). The
    // atomic enqueue re-checks for an active job inside a BEGIN IMMEDIATE
    // transaction and rejects the loser, so the run is never double-executed.
    const enqueued = await context.jobRunner.enqueueIfNoActiveByRunId({
      runId: existing.run_id,
      sessionId: session.id,
      kind: 'workflow-resume',
    });
    return {
      ...mappedDecision,
      sessionId: session.id,
      jobId: enqueued.job.id,
    };
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
    if (
      current &&
      ['passed', 'failed', 'cancelled'].includes(current.status)
    ) {
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
