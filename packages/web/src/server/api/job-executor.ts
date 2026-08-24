import {
  createAgentAdapterFromSnapshot,
  createCommandGateway,
  createGateEngine,
  createWorkflowEngine,
  createWorktreeManager,
  isWorkflowTerminalError,
  redactSecrets,
  writeWorkflowTerminal,
  type AgentEventSink,
  type AuditLogger,
  type JobExecutionContext,
  type JobExecutor,
  type JobStatus,
  type SessionEventBus,
  type SessionEventStore,
  type SubprocessRegistry,
  type TekonRepositories,
  type WorkflowInstance,
} from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';

/**
 * Web-side JobExecutor (design §2.5). Each background job maps its session to
 * a runId, builds the workflow engine from the run's persisted provider
 * snapshot, drives executePreparedRun / resumeRun with the job's abort signal +
 * pause predicate + checkpoint hook, then maps the resulting workflow status to
 * a job status and emits the session lifecycle events.
 *
 * Every path is caught: the executor never throws out to the runner (the
 * runner's own catch-all would otherwise mark the job failed without emitting
 * turn/end). MF1: the signal-aborted path only idempotently sets the session to
 * cancelled — `agent/cancelled` is emitted once, by the web cancel route.
 */
export function createWorkflowJobExecutor(deps: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  projectContext: WebProjectContext;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  registry: SubprocessRegistry;
  /** Phase 2 S3: best-effort agent-loop event sink (the dual-write bridge). */
  agentEventSink?: AgentEventSink;
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

  async function buildEngine(
    runId: string,
    ctx: JobExecutionContext,
  ) {
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
    const adapter = createAgentAdapterFromSnapshot({ snapshot, gateway });
    return createWorkflowEngine({
      repoPath: projectContext.projectRoot,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: adapter.adapter,
      agentProvider: adapter.provider,
      agentConfigSummary: adapter.configSummary,
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
        const engine = await buildEngine(runId, ctx);
        const workflow: WorkflowInstance =
          job.kind === 'workflow-resume'
            ? (await engine.resumeRun(runId)).workflow
            : await engine.executePreparedRun(runId);

        return await settleByWorkflowStatus(job.sessionId, runId, workflow, ctx);
      } catch (error) {
        if (ctx.signal.aborted) {
          // Abort raced the run to completion. Settle the workflow cancelled
          // (idempotent, M2) and the session cancelled — but do NOT emit
          // agent/cancelled (MF1: single emission from the web cancel route).
          await writeWorkflowTerminal(repositories, runId, 'cancelled', null).catch(
            () => {},
          );
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
    // Aborted mid-flight: engine returned a cancelled/paused workflow because
    // it hit the signal at a node boundary.
    if (ctx.signal.aborted || workflow.status === 'cancelled') {
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
        // running/pending should not be a terminal engine return; treat as done
        // to avoid a stuck job, but surface it via turn/end.
        await sessions.updateSessionStatus(sessionId, 'idle');
        await emit(sessionId, 'turn/end', { runId, status: workflow.status });
        return { status: 'done' };
      }
    }
  }
}
