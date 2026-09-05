import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  type AdmissionStore,
  type RunAdmissionEnvelope,
  hashAdmissionEnvelope,
  isValidRequestId,
} from '../db/admission-store.js';
import type { SessionEventBus } from './event-bus.js';
import type { DurableJobRunner } from './job-runner.js';
import type { JobRepository, SessionEventStore } from './session-store.js';
import { isWorkflowTerminalError } from '../workflow/errors.js';
import { RunAdmissionError } from '../workflow/admission-error.js';
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
  requestId?: string;
  /** Trusted composition-root envelope: original references, before file resolution. */
  requestEnvelope?: RunAdmissionEnvelope;
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
   * Governance evidence inserted in the same admission transaction.
   * Async onPrepared callbacks are not a valid atomic admission boundary.
   */
  admissionAudits?: Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;
  /**
   * Canonical plan digest computed by the caller (CLI) for audit binding.
   * Web validates it in the router before startRun; CLI computes and passes
   * it directly. Persisted to workflow_instances.plan_digest via the engine.
   */
  planDigest?: string;
}

export interface SessionServiceStartRunResult {
  runId: string;
  sessionId: string;
  jobId: string;
  /** The prepared workflow instance (web maps it via mapWorkflowFromDomain). */
  workflow: WorkflowInstance;
  requestId: string;
  replayed: boolean;
  admissionState: 'pending' | 'ready' | 'recovery_required';
  detail?: string;
}

export type SessionServiceResumeResult =
  | { outcome: 'pending-decisions'; runId: string }
  | { outcome: 'terminal'; runId: string; status: WorkflowStatus }
  | { outcome: 'active-job'; runId: string }
  | { outcome: 'recovery-required'; runId: string; lastError?: string | null }
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
  lookupRun(input: {
    requestId: string;
    requestEnvelope: RunAdmissionEnvelope;
  }): Promise<SessionServiceStartRunResult | null>;
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
   * Lifecycle audit. Admission governance events use admissionAudits inside
   * the database transaction, never an asynchronous onPrepared callback.
   */
  audit: AuditLogger;
  /** Workspace root for getOrCreateDefaultWorkspace. */
  projectRoot: string;
  admissionStore?: AdmissionStore;
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
  preflight?: () => Promise<void>;
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

  const admissionStore = deps.admissionStore ?? repositories.admissionStore;

  async function lookupRun(input: {
    requestId: string;
    requestEnvelope: RunAdmissionEnvelope;
  }): Promise<SessionServiceStartRunResult | null> {
    if (!isValidRequestId(input.requestId)) throw new Error('REQUEST_ID_INVALID');
    if (input.requestEnvelope.scope !== realpathSync(projectRoot)) throw new Error('REQUEST_SCOPE_MISMATCH');
    const existing = await admissionStore.getAdmission(input.requestId);
    if (!existing) return null;
    if (existing.envelopeHash !== hashAdmissionEnvelope(input.requestEnvelope)) {
      throw new Error('REQUEST_ID_CONFLICT');
    }
    const workflow = await repositories.getWorkflowInstance(existing.runId);
    const project = workflow ? await repositories.getProject(workflow.projectId) : null;
    if (!workflow || project?.repoPath !== realpathSync(projectRoot)) throw new Error('REQUEST_SCOPE_MISMATCH');
    if (!existing.sessionId || !existing.jobId) throw new Error('ADMISSION_SESSION_MISSING');
    let admission;
    try {
      admission = existing.filesState === 'ready' ? existing
        : await admissionStore.recoverAdmissionFiles(existing.requestId);
    } catch (error) {
      throw new RunAdmissionError(input.requestId, error, existing);
    }
    return {
      requestId: admission.requestId,
      runId: admission.runId,
      sessionId: existing.sessionId,
      jobId: existing.jobId,
      workflow,
      replayed: true,
      admissionState: admission.filesState,
      ...(admission.lastError ? { detail: admission.lastError } : {}),
    };
  }

  async function startRun(
    rawInput: SessionServiceStartRunInput<TEngineInput>,
  ): Promise<SessionServiceStartRunResult> {
    const requestId = rawInput.requestId ?? randomUUID();
    if (!isValidRequestId(requestId)) throw new Error('REQUEST_ID_INVALID');
    try {
      return await startRunWithIdentity({ ...rawInput, requestId });
    } catch (error) {
      if (error instanceof RunAdmissionError) throw error;
      throw new RunAdmissionError(requestId, error);
    }
  }

  async function startRunWithIdentity(
    rawInput: SessionServiceStartRunInput<TEngineInput> & { requestId: string },
  ): Promise<SessionServiceStartRunResult> {
    if ((rawInput as { onPrepared?: unknown }).onPrepared !== undefined) {
      throw new Error('ADMISSION_HOOK_UNSUPPORTED: use admissionAudits');
    }
    // Freeze the submitted intent before factory/preflight or any queue wait.
    const input = structuredClone(rawInput);
    const requestId = input.requestId;
    const runKind = input.mode === 'goal' ? 'goal' : 'workflow';
    const profile = input.profile ?? SESSION_PROFILE;
    const { requestId: _requestId, requestEnvelope: _envelope, ...explicitIntent } = input;
    const requestEnvelope = input.requestEnvelope ?? {
      version: 1,
      scope: realpathSync(projectRoot),
      demandTextOrRef: input.demandText,
      mode: runKind,
      surface: 'session',
      intent: { ...explicitIntent, mode: runKind, profile },
    };
    const lookupInput = { requestId, requestEnvelope };
    try {
      const existing = await lookupRun(lookupInput);
      if (existing) return existing;
      const engine = await deps.createEngine(input.engine);
      // The legacy CLI preflight consumes the provider selected by its factory.
      await deps.preflight?.();
      const prepareInput: WorkflowEngineStartInput = {
        requestId,
        demandText: input.demandText,
        mode: RUN_MODE,
        kind: runKind,
        profile,
        ...(runKind === 'goal' ? { templateName: GOAL_TEMPLATE_NAME }
          : input.workflowSpec ? { workflowSpec: input.workflowSpec,
              ...(input.templateName ? { templateName: input.templateName } : {}) }
            : { templateName: input.templateName }),
        ...(input.planDigest !== undefined
          ? { planDigest: input.planDigest } : {}),
      };
      const prepared = engine.buildPreparedRun(prepareInput);
      if (!prepared.providerSnapshot) throw new Error('ADMISSION_PROVIDER_REQUIRED');
      const outcome = await admissionStore.admitRun({
        ...prepared,
        requestId,
        envelopeVersion: requestEnvelope.version,
        envelopeHash: hashAdmissionEnvelope(requestEnvelope),
        admissionAudits: input.admissionAudits ?? [],
        sessionData: {
          workspaceRoot: realpathSync(projectRoot),
          profile,
          sessionId: `sess_${randomUUID()}`,
          jobId: `job_${randomUUID()}`,
          jobKind: runKind === 'goal' ? 'goal-run' : 'workflow-run',
        },
      });
      if (!outcome.sessionId || !outcome.jobId) throw new Error('ADMISSION_SESSION_MISSING');
      // Persistent events are authoritative for this opening prefix. A failed
      // notification cannot turn a committed admission into a fresh request.
      for (const event of outcome.openingEvents) {
        try { bus.publish(event); } catch { /* recover via persisted events */ }
      }
      return {
        requestId: outcome.requestId,
        runId: outcome.runId,
        sessionId: outcome.sessionId,
        jobId: outcome.jobId,
        workflow: outcome.workflow,
        replayed: outcome.outcome === 'already_admitted',
        admissionState: outcome.filesState,
        ...(outcome.admission.lastError ? { detail: outcome.admission.lastError } : {}),
      };
    } catch (error) {
      // Another process may have won after our initial read while our own
      // environment validation/transaction failed. Never return a loser ID.
      try {
        const winner = await lookupRun(lookupInput);
        if (winner) return winner;
      } catch (lookupError) {
        if (lookupError instanceof Error && lookupError.message === 'REQUEST_ID_CONFLICT') {
          throw new RunAdmissionError(requestId, lookupError);
        }
        if (lookupError instanceof RunAdmissionError && lookupError.runId) throw lookupError;
        // Unreadable database: the caller retains requestId and must query or
        // retry it, rather than interpret this as proof that no Run exists.
      }
      if (error instanceof RunAdmissionError) throw error;
      throw new RunAdmissionError(requestId, error);
    }
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

    const resolvedAdmissionStore = admissionStore;

    if (resolvedAdmissionStore) {
      const admission = await resolvedAdmissionStore.getAdmissionByRunId(input.runId);
      if (admission && admission.filesState !== 'ready') {
        const state = await resolvedAdmissionStore.recoverAdmissionFiles(admission.requestId);
        if (state.filesState !== 'ready') {
          return {
            outcome: 'recovery-required',
            runId: input.runId,
            lastError: admission.lastError,
          };
        }
      }
      if (admission?.jobId && admission.sessionId) {
        const initialJob = await jobs.get(admission.jobId);
        if (initialJob?.status === 'queued') {
          // This is the original durable admission, not an abandoned resume.
          // Return its queued identity so CLI can start its runner and wait;
          // never cancel/re-enqueue it just because the server was offline.
          return { outcome: 'enqueued', runId: input.runId,
            sessionId: admission.sessionId, jobId: admission.jobId };
        }
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

  return { lookupRun, startRun, resumeRun, requestPause, requestCancel };
}
