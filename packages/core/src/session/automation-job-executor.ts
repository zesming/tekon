import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createPullRequestPreparation } from '../delivery/pr-package.js';
import { evaluatePrePullRequestReadiness } from '../delivery/pre-pr-readiness.js';
import { redactSecrets } from '../security/secrets.js';
import type { JobStatus } from '../types/session-contract.js';
import type { SessionEventBus } from './event-bus.js';
import type { JobExecutionContext, JobExecutor } from './job-runner.js';
import type { SessionEventStore } from './session-store.js';

/**
 * Automation JobExecutor (design §1.2.2a, 4d/4e). Drives the non-workflow,
 * side-effect-light job kinds — delivery auto-prepare (4d) and readiness
 * evaluation (4e). Deliberately does NOT share the workflow executor's shape:
 *
 * - no `updateSessionStatus('active')` / `turn/start` / `buildEngine` / settle
 *   (those are workflow-run semantics);
 * - it NEVER touches workflow or session terminal state — a failure here must
 *   not flip an already-`passed` run's session to `failed` (M1). It self-
 *   catches every error, emits a best-effort `agent/error`, and returns a job
 *   status; it must never throw out to the runner (the runner catch-all would
 *   settle the job failed without the domain event).
 *
 * The job row itself still settles done/failed via the runner — only the
 * workflow/session state is off-limits.
 */
export function createAutomationJobExecutor(deps: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  projectRoot: string;
}): JobExecutor {
  const { repositories, audit, sessions, bus, projectRoot } = deps;

  async function emit(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const event = await sessions.appendEvent({ sessionId, type, payload });
      bus.publish(event);
    } catch {
      // Best-effort: the jobs/workflow tables are the source of truth (C1).
    }
  }

  async function runDeliveryAutoPrepare(
    runId: string,
    sessionId: string,
  ): Promise<{ status: JobStatus }> {
    // goal runs never get delivery (standard-delivery readiness is恒red for
    // them); short-circuit before touching the evidence package.
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow || workflow.kind === 'goal') {
      return { status: 'done' as JobStatus };
    }
    // Idempotent: a prepared/created delivery is not re-prepared.
    const existing = await repositories.getDeliveryPullRequest(runId);
    if (existing && existing.status !== 'failed') {
      return { status: 'done' as JobStatus };
    }
    const preparation = await createPullRequestPreparation({
      repoPath: projectRoot,
      repositories,
      audit,
      runId,
    });
    // createPullRequestPreparation does not touch the delivery_pull_requests
    // table (N7); the auto-prepare job owns the `prepared` row so the
    // idempotency check above (and the createPr guard) have state to key on.
    const now = new Date().toISOString();
    await repositories.upsertDeliveryPullRequest({
      id: existing?.id ?? `delivery_pr_${runId}`,
      runId,
      branch: preparation.branch,
      baseBranch: preparation.baseBranch,
      title: preparation.title,
      bodyPath: preparation.prBodyPath,
      remoteName: existing?.remoteName ?? null,
      remoteUrl: existing?.remoteUrl ?? null,
      status: 'prepared',
      prUrl: existing?.prUrl ?? null,
      // S2: preserve a prior human approval. This upsert also runs when a
      // previous delivery attempt is `failed` (existing.status === 'failed'
      // above), and a failed attempt may have carried a human approval
      // (approve → push/create failed). Nulling it would silently revoke that
      // approval; keep it (re-preparing is fail-safe, not an approval reset).
      approvedBy: existing?.approvedBy ?? null,
      approvedAt: existing?.approvedAt ?? null,
      branchPushedAt: existing?.branchPushedAt ?? null,
      prCreatedAt: existing?.prCreatedAt ?? null,
      failureStage: null,
      lastError: null,
      attemptCount: existing?.attemptCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await emit(sessionId, 'delivery/prepared', {
      runId,
      branch: preparation.branch,
      baseBranch: preparation.baseBranch,
      packagePath: preparation.packagePath,
      prBodyPath: preparation.prBodyPath,
      auto: true,
    });
    return { status: 'done' as JobStatus };
  }

  async function runReadinessEvaluate(
    runId: string,
    sessionId: string,
  ): Promise<{ status: JobStatus }> {
    const readiness = await evaluatePrePullRequestReadiness({
      repositories,
      audit,
      runId,
      repoPath: projectRoot,
    });
    await emit(sessionId, 'readiness/evaluated', {
      runId,
      ready: readiness.ready,
      checks: readiness.checks,
    });
    return { status: 'done' as JobStatus };
  }

  return {
    async execute(ctx: JobExecutionContext) {
      const { job } = ctx;
      let runId: string | null = null;
      try {
        runId = await sessions.getRunIdBySessionId(job.sessionId);
        if (!runId) {
          // No run bound — nothing to automate. Not a run/session failure.
          return { status: 'failed' as JobStatus };
        }
        switch (job.kind) {
          case 'delivery-auto-prepare':
            return await runDeliveryAutoPrepare(runId, job.sessionId);
          case 'readiness-evaluate':
            return await runReadinessEvaluate(runId, job.sessionId);
          default:
            throw new Error(`Unknown automation job kind: ${job.kind}`);
        }
      } catch (error) {
        // M1: automation failure is isolated — record + emit, but DO NOT touch
        // workflow/session terminal state. Only the job row settles failed.
        // getRunIdBySessionId is inside the try (S1) so even a store error emits
        // agent/error rather than throwing out to the runner (which would settle
        // the job failed without the domain event). runId may be null if the
        // store read itself failed.
        const message = redactSecrets(
          error instanceof Error ? error.message : String(error),
        ).content;
        await emit(job.sessionId, 'agent/error', { runId, message });
        return { status: 'failed' as JobStatus };
      }
    },
  };
}

/** Job kinds handled by the automation executor. */
export const AUTOMATION_JOB_KINDS = [
  'delivery-auto-prepare',
  'readiness-evaluate',
] as const;

/**
 * Route a job to the workflow executor or the automation executor by kind
 * (design §1.2.2a). Keeps `createJobRunner` unchanged (single executor
 * injected) while isolating automation kinds from the workflow executor's
 * active/turn-start/buildEngine/settle path. An unknown kind throws — the
 * fake-pass guard (§0.3) is preserved end-to-end.
 */
export function createRoutingJobExecutor(deps: {
  workflow: JobExecutor;
  automation: JobExecutor;
}): JobExecutor {
  const automationKinds = new Set<string>(AUTOMATION_JOB_KINDS);
  return {
    execute(ctx) {
      if (automationKinds.has(ctx.job.kind)) {
        return deps.automation.execute(ctx);
      }
      return deps.workflow.execute(ctx);
    },
  };
}
