import { createAgentAdapterFromSnapshot } from '../runtime/agent-runtime.js';
import type { AgentEventSink } from '../runtime/agent-step-events.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import { createWorktreeManager } from '../runtime/worktree-manager.js';
import { redactSecrets } from '../security/secrets.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createGateEngine } from '../gate/engine.js';
import {
  isJobCancellationAbort,
  isJobOwnershipLostAbort,
  type JobExecutionContext,
  type JobExecutor,
} from './job-runner.js';
import type { SessionEventBus } from './event-bus.js';
import type { SessionEventStore } from './session-store.js';
import type { SubprocessRegistry } from './subprocess-registry.js';
import type { JobStatus } from '../types/session-contract.js';
import type { WorkflowInstance } from '../types/domain.js';
import { isWorkflowTerminalError } from '../workflow/errors.js';
import { writeWorkflowTerminal } from '../workflow/state-machine.js';
import { createWorkflowEngine } from '../workflow/engine.js';

/**
 * The project context fields the workflow job executor actually consumes.
 * Web's WebProjectContext extends this; CLI (4c) can supply its own.
 */
export interface RunProjectContext {
  projectRoot: string;
}

/**
 * The minimal workflow-engine surface the job executor drives. buildEngine
 * returns the full engine; this narrows it to what execute() consumes so the
 * engineFactory test seam can supply a lightweight fake.
 */
export interface WorkflowJobEngine {
  executePreparedRun(runId: string): Promise<WorkflowInstance>;
  resumeRun(runId: string): Promise<{ workflow: WorkflowInstance }>;
}

/**
 * Workflow JobExecutor (design §2.2, moved from web in 4a). Each background
 * job maps its session to a runId, builds the workflow engine from the run's
 * persisted provider snapshot, drives executePreparedRun / resumeRun with the
 * job's abort signal + pause predicate + checkpoint hook, then maps the
 * resulting workflow status to a job status and emits the session lifecycle
 * events.
 *
 * Every path is caught: the executor never throws out to the runner (the
 * runner's own catch-all would otherwise mark the job failed without emitting
 * turn/end). MF1: the signal-aborted path only idempotently sets the session to
 * cancelled — `agent/cancelled` is emitted once, by the cancel route.
 */
export function createWorkflowJobExecutor(deps: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  projectContext: RunProjectContext;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  registry: SubprocessRegistry;
  /** Phase 2 S3: best-effort agent-loop event sink (the dual-write bridge). */
  agentEventSink?: AgentEventSink;
  /**
   * Test seam: override how the workflow engine is built for a run. Defaults to
   * the production buildEngine (provider snapshot → real engine). Injecting a
   * fake engine lets tests drive settleByWorkflowStatus with a chosen workflow
   * status (e.g. a non-terminal status, to lock the §0.3 fake-pass guard)
   * without a full agent run.
   */
  engineFactory?: (
    runId: string,
    ctx: JobExecutionContext,
  ) => Promise<WorkflowJobEngine>;
}): JobExecutor {
  const { repositories, audit, projectContext, sessions, bus, registry } = deps;

  async function emit(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    options: { modelVisible?: boolean } = {},
  ): Promise<void> {
    try {
      const event = await sessions.appendEvent({
        sessionId,
        type,
        payload,
        modelVisible: options.modelVisible ?? false,
      });
      bus.publish(event);
    } catch {
      // Session events are best-effort; the jobs/workflow tables are the
      // source of truth (C1).
    }
  }

  async function buildEngine(runId: string, ctx: JobExecutionContext) {
    // Wrap the gateway so every subprocess it spawns (agent, gate commands,
    // worktree git) registers under runId and honors the job's abort signal.
    // This is the last hop of the cancel chain (D6): jobRunner.requestCancel →
    // registry.killAll(runId) can only kill children that were registered here.
    const base = createCommandGateway({ repositories });
    const gateway = {
      run: (input: Parameters<typeof base.run>[0]) =>
        base.run({
          ...input,
          registry,
          registryKey: runId,
          signal: input.signal ?? ctx.signal,
        }),
    };
    const snapshot = await repositories.getRunProviderConfig(runId);
    if (!snapshot) {
      throw new Error(
        `Run ${runId} has no provider snapshot; cannot execute job safely.`,
      );
    }
    // 4c: restore the run's lease policy. The engine is rebuilt fresh here
    // (not the prepareRun engine), so allow-dirty-base — persisted on the run
    // — must be read back and threaded, or a dirty-base run would fail lease
    // creation in the background job even though it was started with the flag.
    const instance = await repositories.getWorkflowInstance(runId);
    const adapter = createAgentAdapterFromSnapshot({ snapshot, gateway });
    return createWorkflowEngine({
      repoPath: projectContext.projectRoot,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: adapter.adapter,
      agentProvider: adapter.provider,
      agentConfigSummary: adapter.configSummary,
      allowDirtyBase: instance?.allowDirtyBase ?? false,
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
      registry,
      signal: ctx.signal,
      isPauseRequested: () => ctx.pauseRequested(),
      onNodeCheckpoint: (nodeId) => ctx.checkpoint(nodeId),
      agentEventSink: deps.agentEventSink,
    });
  }

  return {
    async execute(ctx) {
      const { job } = ctx;
      const runId = await sessions.getRunIdBySessionId(job.sessionId);
      if (!runId) {
        // No run bound to this session — nothing to execute.
        await sessions.updateSessionStatus(job.sessionId, 'failed');
        return { status: 'failed' as JobStatus };
      }

      await sessions.updateSessionStatus(job.sessionId, 'active');
      await emit(job.sessionId, 'turn/start', { runId, kind: job.kind });

      try {
        const engine = await (deps.engineFactory ?? buildEngine)(runId, ctx);
        // 4b: explicit kind dispatch. An unknown kind MUST throw here (→ caught
        // below → job failed), never fall through to executePreparedRun — a
        // fall-through on an unprepared/empty plan would settle run.passed and
        // produce a silent false pass (design §0.3 hard constraint).
        let workflow: WorkflowInstance;
        switch (job.kind) {
          case 'workflow-run':
          case 'goal-run':
            workflow = await engine.executePreparedRun(runId);
            break;
          case 'workflow-resume':
            workflow = (await engine.resumeRun(runId)).workflow;
            break;
          default:
            throw new Error(`Unknown job kind: ${job.kind}`);
        }

        return await settleByWorkflowStatus(
          job.sessionId,
          runId,
          workflow,
          ctx,
        );
      } catch (error) {
        // Lease/owner loss fences a stale executor. It must not write workflow
        // or session terminal state; the new owner is authoritative.
        if (isJobOwnershipLostAbort(ctx.signal)) {
          return { status: 'failed' as JobStatus };
        }
        if (isJobCancellationAbort(ctx.signal)) {
          // Abort raced the run to completion. Settle the workflow cancelled
          // (idempotent, M2) and the session cancelled — but do NOT emit
          // agent/cancelled (MF1: single emission from the cancel route).
          await writeWorkflowTerminal(
            repositories,
            runId,
            'cancelled',
            null,
          ).catch(() => {});
          await sessions.updateSessionStatus(job.sessionId, 'cancelled');
          await emit(job.sessionId, 'turn/end', { runId, status: 'cancelled' });
          return { status: 'cancelled' as JobStatus };
        }
        if (isWorkflowTerminalError(error)) {
          // The run was terminated by another path after enqueue. Not a
          // failure; leave the session's terminal status untouched.
          await emit(job.sessionId, 'turn/end', {
            runId,
            status: 'terminal',
          });
          return { status: 'cancelled' as JobStatus };
        }
        const message = redactSecrets(
          error instanceof Error ? error.message : String(error),
        ).content;
        await sessions.updateSessionStatus(job.sessionId, 'failed');
        await emit(job.sessionId, 'agent/error', { runId, message });
        await emit(job.sessionId, 'turn/end', { runId, status: 'failed' });
        return { status: 'failed' as JobStatus };
      }
    },
  };

  async function settleByWorkflowStatus(
    sessionId: string,
    runId: string,
    workflow: WorkflowInstance,
    ctx: JobExecutionContext,
  ): Promise<{ status: JobStatus; summary?: string }> {
    // Ownership loss is a silent fencing outcome for this stale executor.
    // The current owner will emit the authoritative lifecycle events.
    if (isJobOwnershipLostAbort(ctx.signal)) {
      return { status: 'failed' };
    }

    // User cancellation remains authoritative over an engine result.
    if (isJobCancellationAbort(ctx.signal) || workflow.status === 'cancelled') {
      await sessions.updateSessionStatus(sessionId, 'cancelled');
      await emit(sessionId, 'turn/end', { runId, status: 'cancelled' });
      return { status: 'cancelled' };
    }

    switch (workflow.status) {
      case 'passed': {
        await sessions.updateSessionStatus(sessionId, 'done');
        // D4 (phase 2 S3): the synthetic "Run passed." assistant/message is
        // removed — each executed node now emits a real (artifact-synthesized)
        // assistant/message via the step-event bridge. turn/end still marks the
        // run boundary.
        await emit(sessionId, 'turn/end', { runId, status: 'passed' });
        return { status: 'done' };
      }
      case 'paused': {
        const decisions = await repositories.listHumanDecisions(runId);
        const hasPending = decisions.some((d) => d.status === 'pending');
        await sessions.updateSessionStatus(
          sessionId,
          hasPending ? 'awaiting-approval' : 'idle',
        );
        await emit(sessionId, 'turn/end', { runId, status: 'paused' });
        return { status: 'done' };
      }
      case 'blocked': {
        await sessions.updateSessionStatus(sessionId, 'awaiting-input');
        await emit(sessionId, 'turn/end', { runId, status: 'blocked' });
        return { status: 'done' };
      }
      case 'interrupted': {
        await sessions.updateSessionStatus(sessionId, 'failed');
        await emit(sessionId, 'agent/error', { runId, status: 'interrupted' });
        await emit(sessionId, 'turn/end', { runId, status: 'interrupted' });
        return { status: 'failed' };
      }
      default: {
        // A background executor returning running/pending is a contract breach.
        // Never convert it to `done`: that creates a false-success job while the
        // workflow itself is still non-terminal. Fail loudly and preserve the
        // unexpected status in the durable event trail.
        const message = `Workflow engine returned non-terminal status: ${workflow.status}`;
        await sessions.updateSessionStatus(sessionId, 'failed');
        await emit(sessionId, 'agent/error', {
          runId,
          status: workflow.status,
          message,
        });
        await emit(sessionId, 'turn/end', { runId, status: 'failed' });
        return { status: 'failed' };
      }
    }
  }
}
