import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { SessionEventBus } from './event-bus.js';
import type { DurableJobRunner } from './job-runner.js';
import type { JobRepository, SessionEventStore } from './session-store.js';
import { isWorkflowTerminalError } from '../workflow/errors.js';
import { writeWorkflowTerminal } from '../workflow/state-machine.js';
import type {
  WorkflowEngine,
  WorkflowEngineStartInput,
} from '../workflow/engine.js';
import type { WorkflowTemplate } from '../workflow/template.js';
import type { WorkflowInstance, WorkflowStatus } from '../types/domain.js';

/**
 * SessionService (phase 4a, design §2.1): the orchestration extracted
 * verbatim from the web project router's run/resume/cancel/pause handlers.
 *
 * Boundary (design §2.1 M-S6): this service ONLY orchestrates. It must not
 * contain token/scope checks, ApiError, redaction, mappers, project workflow
 * loading, draft-shape validation, or clean-base assertions — those stay in
 * the web router. Provider/adapter construction is encapsulated in the
 * injected `createEngine` factory; the service just calls it.
 *
 * Web-specific validation failures are reported as discriminated outcomes
 * (not thrown errors) so the web router keeps owning ApiError construction.
 */

/** Per-request knobs for the injected engine factory (opaque to the service). */
export type SessionServiceEngineInput = unknown;

export interface SessionServiceStartRunInput<TEngineInput = SessionServiceEngineInput> {
  demandText: string;
  /**
   * 4b: run kind. 'workflow' (default) runs a governed delivery workflow;
   * 'goal' runs the built-in single-node goal template. Orthogonal to the
   * engine's plan-source `mode` ('template'|'dynamic').
   */
  mode?: 'workflow' | 'goal';
  /** Used for prepareRun when no workflowSpec is given. */
  templateName?: string;
  /** Project workflow override; takes precedence over templateName for prepareRun. */
  workflowSpec?: WorkflowTemplate;
  /** Passed verbatim to deps.createEngine. */
  engine: TEngineInput;
  /**
   * 4d: per-run session profile override (human-web | autonomous-delivery |
   * review-only). Falls back to deps.sessionProfile when omitted. Autonomy is
   * never inferred — the caller (web project.run / CLI --profile) states it
   * explicitly, so a run only becomes autonomous when asked.
   */
  profile?: string;
  /**
   * Hook invoked after prepareRun (runId exists) and before createSession.
   * The web router uses it to append the `run.demand-shaped` governance
   * audit (P0-03 approval evidence), which is intentionally NOT mapped to a
   * session event. Rejections propagate — the audit chain must not be
   * silently swallowed.
   */
  onPrepared?: (runId: string) => Promise<void>;
}

export interface SessionServiceStartRunResult {
  runId: string;
  sessionId: string;
  jobId: string;
  /** The prepared workflow instance (web maps it via mapWorkflowFromDomain). */
  workflow: WorkflowInstance;
}

export type SessionServiceResumeResult =
  | { outcome: 'pending-decisions'; runId: string }
  | { outcome: 'terminal'; runId: string; status: WorkflowStatus }
  | { outcome: 'active-job'; runId: string }
  | {
      outcome: 'enqueued';
      runId: string;
      sessionId: string;
      jobId: string;
    };

export type SessionServicePauseResult =
  | {
      outcome: 'illegal-transition';
      runId: string;
      workflowStatus: string | null;
    }
  | {
      outcome: 'paused';
      runId: string;
      sessionId?: string;
      jobId?: string;
    };

export interface SessionServiceCancelResult {
  runId: string;
  /**
   * True when the run was already in a DIFFERENT terminal status
   * (writeWorkflowTerminal threw WorkflowTerminalError): no cancel side
   * effects ran, no sessionId/jobId are returned.
   */
  terminalConflict: boolean;
  sessionId?: string;
  jobId?: string;
}

export interface SessionService<TEngineInput = SessionServiceEngineInput> {
  startRun(
    input: SessionServiceStartRunInput<TEngineInput>,
  ): Promise<SessionServiceStartRunResult>;
  resumeRun(input: {
    runId: string;
    afterApproval?: boolean;
  }): Promise<SessionServiceResumeResult>;
  requestPause(input: { runId: string }): Promise<SessionServicePauseResult>;
  requestCancel(input: { runId: string }): Promise<SessionServiceCancelResult>;
}

export interface SessionServiceDeps<TEngineInput = SessionServiceEngineInput> {
  sessions: SessionEventStore;
  jobs: JobRepository;
  /**
   * The durable runner: enqueue/requestPause/requestCancel live on it (the
   * JobRepository's enqueue requires a fully-formed Job row, so using it
   * directly would duplicate the runner's id/timestamp generation).
   */
  jobRunner: DurableJobRunner;
  bus: SessionEventBus;
  repositories: TekonRepositories;
  /**
   * Reserved for service-emitted audit (4b/4c). In 4a the web demand-shaped
   * audit flows through the onPrepared hook, so the service itself does not
   * call it yet.
   */
  audit: AuditLogger;
  /** Workspace root for getOrCreateDefaultWorkspace. */
  projectRoot: string;
  /**
   * Engine factory injected by the composition root. Encapsulates the
   * provider/adapter/runtime construction (web: createWebAgentRuntime +
   * providerRuntimeFromRunInput + gate/worktree managers).
   */
  createEngine: (
    input: TEngineInput,
  ) => WorkflowEngine | Promise<WorkflowEngine>;
  /**
   * 4c: session profile label. Display-only (no behavior attached). Defaults
   * to 'human-web' so the web composition root is unchanged; CLI passes
   * 'cli' (design §8 decision 2).
   */
  sessionProfile?: string;
}

export function createSessionService<TEngineInput = SessionServiceEngineInput>(
  deps: SessionServiceDeps<TEngineInput>,
): SessionService<TEngineInput> {
  const { sessions, jobs, jobRunner, bus, repositories, projectRoot } = deps;

  // 4a: web is the only consumer and always runs template-mode workflows.
  // 4c parameterizes the session profile (CLI passes 'cli'). 4b: `goal` mode
  // selects the built-in goal template and a distinct job kind so the run
  // reads as a goal end-to-end.
  const SESSION_PROFILE = deps.sessionProfile ?? 'human-web';
  const RUN_MODE = 'template' as const;
  const GOAL_TEMPLATE_NAME = 'goal';

  async function startRun(
    input: SessionServiceStartRunInput<TEngineInput>,
  ): Promise<SessionServiceStartRunResult> {
    const runKind = input.mode === 'goal' ? 'goal' : 'workflow';
    // 4d: per-run profile override (explicit autonomy only); falls back to the
    // composition root's default.
    const profile = input.profile ?? SESSION_PROFILE;
    const engine = await deps.createEngine(input.engine);
    // 4b: goal mode ignores any provided template/workflowSpec and uses the
    // built-in single-node goal template (design §3.3 precedence).
    const prepareInput: WorkflowEngineStartInput =
      runKind === 'goal'
        ? {
            demandText: input.demandText,
            mode: RUN_MODE,
            templateName: GOAL_TEMPLATE_NAME,
            kind: 'goal',
          }
        : {
            demandText: input.demandText,
            mode: RUN_MODE,
            kind: 'workflow',
            ...(input.workflowSpec
              ? { workflowSpec: input.workflowSpec }
              : { templateName: input.templateName }),
          };
    // prepareRun persists the run (ms-level) without running the agent.
    const prepared = await engine.prepareRun(prepareInput);
    const runId = prepared.runId;

    if (input.onPrepared) {
      await input.onPrepared(runId);
    }

    // Create the session, then explicitly append the opening events
    // (dual-write can't backfill them — no session existed at run.started).
    const workspace = await sessions.getOrCreateDefaultWorkspace(projectRoot);
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: input.demandText.slice(0, 80),
      profile,
      runId,
    });
    const created = await sessions.appendEvent({
      sessionId: session.id,
      type: 'session/created',
      payload: { runId, profile },
    });
    bus.publish(created);
    const started = await sessions.appendEvent({
      sessionId: session.id,
      type: 'workflow/started',
      payload: {
        runId,
        templateId:
          runKind === 'goal'
            ? GOAL_TEMPLATE_NAME
            : input.workflowSpec?.id ?? input.templateName,
        mode: RUN_MODE,
        kind: runKind,
      },
    });
    bus.publish(started);
    const userMessage = await sessions.appendEvent({
      sessionId: session.id,
      type: 'user/message',
      payload: { text: input.demandText },
      modelVisible: true,
    });
    bus.publish(userMessage);

    const job = await jobRunner.enqueue({
      sessionId: session.id,
      kind: runKind === 'goal' ? 'goal-run' : 'workflow-run',
    });

    return {
      runId,
      sessionId: session.id,
      jobId: job.id,
      workflow: prepared.workflow,
    };
  }

  async function resumeRun(input: {
    runId: string;
    afterApproval?: boolean;
  }): Promise<SessionServiceResumeResult> {
    // Terminal is the strictly stronger stop condition: a passed/failed/
    // cancelled run can never be resumed, regardless of any lingering pending
    // decision. Check it FIRST so a cancelled run with an orphaned pending
    // decision reports `terminal` (CLI → "终态" exit 1), not `pending-decisions`
    // (M5). A non-terminal run with pending decisions still falls through to
    // the pending-decisions guard below.
    const workflow = await repositories.getWorkflowInstance(input.runId);
    if (
      workflow &&
      ['passed', 'failed', 'cancelled'].includes(workflow.status)
    ) {
      return {
        outcome: 'terminal',
        runId: input.runId,
        status: workflow.status,
      };
    }
    // `afterApproval` mirrors web's gate.approve path: the caller has just
    // approved one decision and wants to drive the run forward. Web's
    // gate.approve enqueues resume WITHOUT a pending-decision guard — the engine
    // re-pauses at the next unresolved human gate. A bare resume (tekon resume /
    // project.resume) keeps the guard so it fails loudly instead of silently
    // no-op-advancing a run that is still waiting on a human.
    if (!input.afterApproval) {
      const pendingHuman = await repositories.listHumanDecisions(input.runId);
      if (pendingHuman.some((decision) => decision.status === 'pending')) {
        return { outcome: 'pending-decisions', runId: input.runId };
      }
    }
    // No two active jobs per run. Reclaim queued + stale-paused jobs first.
    await jobs.cancelStaleActiveJobs(input.runId);
    // Resolve (or create) the run's session before the atomic enqueue. For a
    // resumable (paused) run the session already exists from startRun; the
    // createSession branch only fires for the rare no-session case.
    let session = await sessions.findSessionByRunId(input.runId);
    if (!session) {
      const workspace = await sessions.getOrCreateDefaultWorkspace(projectRoot);
      session = await sessions.createSession({
        workspaceId: workspace.id,
        title: null,
        profile: SESSION_PROFILE,
        runId: input.runId,
      });
    }
    // F5-P0-01: the active-check + enqueue must be one cross-process critical
    // section. A bare `findActiveByRunId` then `enqueue` lets two concurrent
    // resumes (CLI + Web, separate connections) both see "no active job" and
    // both enqueue, so the same run is executed by two workers (double agent
    // spend + two worktrees promoted to one run branch). The atomic enqueue
    // re-checks inside a BEGIN IMMEDIATE transaction and rejects the loser.
    const result = await jobRunner.enqueueIfNoActiveByRunId({
      runId: input.runId,
      sessionId: session.id,
      kind: 'workflow-resume',
    });
    if (result.outcome === 'active-job') {
      return { outcome: 'active-job', runId: input.runId };
    }
    return {
      outcome: 'enqueued',
      runId: input.runId,
      sessionId: session.id,
      jobId: result.job.id,
    };
  }

  async function requestPause(input: {
    runId: string;
  }): Promise<SessionServicePauseResult> {
    // CAS running→paused so a concurrent terminal/cancel write is not
    // clobbered. If the CAS does not apply and the run is not already
    // paused, it is an illegal transition (e.g. passed→paused).
    const cas = await repositories.casWorkflowInstanceStatus(
      input.runId,
      'running',
      'paused',
    );
    if (!cas.changed && cas.workflow && cas.workflow.status !== 'paused') {
      return {
        outcome: 'illegal-transition',
        runId: input.runId,
        workflowStatus: cas.workflow.status,
      };
    }
    const active = await jobs.findActiveByRunId(input.runId);
    if (active) {
      await jobRunner.requestPause(active.id);
    }
    const session = await sessions.findSessionByRunId(input.runId);
    return {
      outcome: 'paused',
      runId: input.runId,
      ...(session ? { sessionId: session.id } : {}),
      ...(active ? { jobId: active.id } : {}),
    };
  }

  async function requestCancel(input: {
    runId: string;
  }): Promise<SessionServiceCancelResult> {
    // The web cancel route is the single emission point for
    // agent/cancel-requested + agent/cancelled. writeWorkflowTerminal is
    // idempotent — a repeat cancel returns written=false and re-emits
    // nothing. It is also the CAS guard against false "passed": an external
    // cancel lands the workflow terminal state FIRST, so a racing engine
    // completion's passed write throws WorkflowTerminalError.
    let written = false;
    try {
      const result = await writeWorkflowTerminal(
        repositories,
        input.runId,
        'cancelled',
      );
      written = result.written;
    } catch (error) {
      if (isWorkflowTerminalError(error)) {
        // Already in a different terminal status (passed/failed): nothing to
        // cancel, return the current run.
        return { runId: input.runId, terminalConflict: true };
      }
      throw error;
    }
    const session = await sessions.findSessionByRunId(input.runId);
    if (!written) {
      return {
        runId: input.runId,
        terminalConflict: false,
        ...(session ? { sessionId: session.id } : {}),
      };
    }
    if (session) {
      const requested = await sessions.appendEvent({
        sessionId: session.id,
        type: 'agent/cancel-requested',
        payload: { runId: input.runId },
      });
      bus.publish(requested);
    }
    const active = await jobs.findActiveByRunId(input.runId);
    if (active) {
      await jobRunner.requestCancel(active.id, 'web cancel');
    }
    if (session) {
      await sessions.updateSessionStatus(session.id, 'cancelled');
      const cancelled = await sessions.appendEvent({
        sessionId: session.id,
        type: 'agent/cancelled',
        payload: { runId: input.runId },
      });
      bus.publish(cancelled);
    }
    return {
      runId: input.runId,
      terminalConflict: false,
      ...(session ? { sessionId: session.id } : {}),
      ...(active ? { jobId: active.id } : {}),
    };
  }

  return { startRun, resumeRun, requestPause, requestCancel };
}
