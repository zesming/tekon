import {
  createAuditLogger,
  createCommandGateway,
  createDualWriteAuditLogger,
  createDualWriteRepositories,
  createGateEngine,
  createJobRepository,
  createRepositories,
  createSessionDualWriteBridge,
  createSessionEventBus,
  createSessionEventStore,
  createSessionService,
  createSubprocessRegistry,
  createWorkflowEngine,
  createWorkflowJobExecutor,
  createAutomationJobExecutor,
  createRoutingJobExecutor,
  canAutoPrepareDelivery,
  createWorktreeManager,
  createWriteQueue,
  createJobRunner,
  openTekonDatabase,
  migrateDatabase,
  runDshPreflight,
  DshHostNodeError,
  isHostNodeVersionCompatible,
  TESTED_DSH_VERSION,
  type AuditLogger,
  type RunPlan,
  type SubprocessRegistry,
  type TekonRepositories,
  type WorkflowEngine,
} from '@tekon/core';

import {
  assertProjectDatabaseExists,
  createProjectContext,
  type ResolveProjectRootInput,
  type WebProjectContext,
} from '../project-context.js';

import {
  createWebAgentRuntime,
  providerRuntimeFromRunInput,
} from './agents.js';
import type { ServerContext, ApiCaller, WebRunEngineInput } from './context.js';
import { createPlanPreviewSigner } from './plan-preview.js';
import { ApiError } from './errors.js';
import { createWebProjectScope, webProjectScope } from './queries.js';
import {
  createArtifactRouter,
  createAuditRouter,
  createDemandRouter,
  createDeliveryRouter,
  createGateRouter,
  createProjectRouter,
  createReviewRouter,
  createRoleRouter,
  createWorkflowRouter,
  createProgressRouter,
  createSessionRouter,
} from './routers/index.js';

export type { ApiCaller } from './context.js';
export { dispatchApiCall } from './dispatch.js';

type WebRunEngineWithPlan = WebRunEngineInput & {
  canonicalPlan?: RunPlan;
  planSnapshot?: string;
};

/**
 * 4a: the web run-engine factory injected into SessionService. It encapsulates
 * provider validation and construction before the engine is allowed to persist
 * a Run. DSH preflight is request-scoped here: no process-global mutable slot
 * can be overwritten by a concurrent start request.
 */
function createWebRunEngineFactory(deps: {
  projectContext: WebProjectContext;
  repositories: TekonRepositories;
  audit: AuditLogger;
  registry: SubprocessRegistry;
  preflight?: typeof runDshPreflight;
}): (input: WebRunEngineInput) => Promise<WorkflowEngine> {
  return async (input) => {
    if (input.agent === 'dsh-headless') {
      const preflight = deps.preflight ?? runDshPreflight;
      try {
        await preflight(undefined, {
          onWarn: (m) => console.warn('[dsh bridge]', m),
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        if (error instanceof DshHostNodeError) {
          throw new ApiError(
            'BAD_REQUEST',
            `dsh-headless 宿主 Node 不兼容: ${detail} (tested: ${TESTED_DSH_VERSION})`,
          );
        }
        throw new ApiError(
          'BAD_REQUEST',
          `dsh-headless 预检未通过: ${detail} (tested: ${TESTED_DSH_VERSION})`,
        );
      }
    }

    const plannedInput = input as WebRunEngineWithPlan;
    const gateway = createCommandGateway({
      repositories: deps.repositories,
    });
    const agentRuntime = createWebAgentRuntime({
      agent: input.agent,
      repoPath: deps.projectContext.projectRoot,
      gateway,
      runtime: providerRuntimeFromRunInput(input),
    });
    return createWorkflowEngine({
      repoPath: deps.projectContext.projectRoot,
      dataDir: '.tekon',
      repositories: deps.repositories,
      audit: deps.audit,
      adapter: agentRuntime.adapter,
      agentProvider: agentRuntime.provider,
      agentConfigSummary: agentRuntime.configSummary,
      profile: input.profile,
      timeoutMs: input.timeoutMs,
      noProgressTimeoutMs: input.noProgressTimeoutMs,
      progressHeartbeatMs: input.progressHeartbeatMs,
      allowDirtyBase: input.allowDirtyBase,
      canonicalPlan: plannedInput.canonicalPlan,
      planDigest: plannedInput.planDigest,
      planSnapshot: plannedInput.planSnapshot,
      registry: deps.registry,
      gateEngine: createGateEngine({
        repositories: deps.repositories,
        gateway,
      }),
      worktreeManager: createWorktreeManager({
        repositories: deps.repositories,
        gateway,
      }),
    });
  };
}

export async function createApiCaller(
  input: ResolveProjectRootInput & {
    providerProbe?: () => Promise<'available' | 'unavailable'>;
  },
): Promise<ApiCaller> {
  const projectContext = createProjectContext(input);
  assertProjectDatabaseExists(projectContext);

  const db = openTekonDatabase({ filename: projectContext.dbPath });
  migrateDatabase(db);

  // S6/S7a: one shared write queue serializes legacy tables, session_events,
  // jobs, and the audit hash chain. MF4: audit appends run directly on the
  // queue (no re-enqueue into repositories → no self-wait deadlock).
  const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus({
    // S3: safety net for an unexpected synchronous throw in a listener. Every
    // listener already self-catches, but a bug that escapes must surface to
    // stderr rather than be swallowed by the bus's per-listener isolation.
    onError: (error) => {
      console.error('[session bus] listener error:', error);
    },
  });
  const registry = createSubprocessRegistry();

  // Dual-write: wrap audit + repositories so engine/routers emit session
  // events transparently (best-effort; hash chain unchanged, C1/SHOULD5).
  const bridge = createSessionDualWriteBridge({
    sessions,
    bus,
    // best-effort projection stays best-effort (C1), but surface failures to
    // stderr rather than a silent black hole (review N4). Never throws.
    onError: (error) => {
      console.error('[session dual-write] event projection failed:', error);
    },
  });
  const dualRepositories = createDualWriteRepositories(repositories, bridge);
  const dualAudit = createDualWriteAuditLogger(audit, bridge);

  const executor = createWorkflowJobExecutor({
    repositories: dualRepositories,
    audit: dualAudit,
    projectContext,
    sessions,
    bus,
    registry,
    // Phase 2 S3: agent-loop step events flow through the same bridge as the
    // dual-write projections (best-effort; C1). node-executor/rework emit
    // step/start, tool/*, assistant/message, agent/error, step/end via it.
    agentEventSink: bridge,
  });
  // 4d/4e: automation kinds (delivery-auto-prepare, readiness-evaluate) run
  // through a separate lightweight executor that never touches workflow/session
  // terminal state (M1). The routing executor dispatches by job kind so the
  // durable runner stays single-executor.
  const automationExecutor = createAutomationJobExecutor({
    repositories: dualRepositories,
    audit: dualAudit,
    sessions,
    bus,
    projectRoot: projectContext.projectRoot,
  });
  const jobRunner = createJobRunner({
    jobs,
    sessions,
    bus,
    registry,
    executor: createRoutingJobExecutor({
      workflow: executor,
      automation: automationExecutor,
    }),
  });
  await repositories.admissionStore.scanAndRecoverAdmissions();
  jobRunner.start();

  // Automation listeners launch asynchronous work outside JobRunner. Track
  // every started task so close() cannot shut the database underneath a
  // callback that was already running when the listeners were detached.
  let closing = false;
  const automationTasks = new Set<Promise<unknown>>();
  const trackAutomationTask = <T,>(task: Promise<T>): void => {
    automationTasks.add(task);
    void task.then(
      () => automationTasks.delete(task),
      () => automationTasks.delete(task),
    );
  };

  // 4e: readiness projection. When a gate result lands OR a human decision is
  // decided, (re-)evaluate pre-PR readiness off the event stream so the UI/
  // delivery can react without polling. Both `gate/result` and `approval/
  // decided` feed it: a human approve/reject changes gate status
  // (updateGateResultStatus), which readiness reflects — subscribing to both
  // makes the report §10 "readiness/approval events" literal (an approval no
  // longer leaves the projection stale until the next gate/result). Debounced
  // per session (a node emits several gate results in a burst); the enqueue is
  // fire-and-forget — a projection failure must never destabilize the publisher
  // (the bus already isolates listener throws, but the async enqueue is guarded
  // too). Long-lived server only: the durable runner keeps polling, so the
  // enqueued job is always drained here.
  const readinessDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribeReadiness = bus.subscribeAll((event) => {
    if (closing) return;
    if (event.type !== 'gate/result' && event.type !== 'approval/decided') {
      return;
    }
    const existing = readinessDebounce.get(event.sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      readinessDebounce.delete(event.sessionId);
      if (closing) return;
      trackAutomationTask(
        jobRunner
          .enqueue({ sessionId: event.sessionId, kind: 'readiness-evaluate' })
          .catch((error) => {
            console.error('[readiness] enqueue failed:', error);
          }),
      );
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    readinessDebounce.set(event.sessionId, timer);
  });

  // 4d: autonomous-delivery auto-prepare. When a run passes (run.passed →
  // agent/status{status:passed}), if its session's profile is
  // autonomous-delivery, enqueue a delivery-auto-prepare job. The automation
  // executor packages evidence + writes the `prepared` row + emits
  // delivery/prepared — but NEVER creates a PR (governance red line). Long-
  // lived server only (web/headless): CLI is run-to-exit and does not wire this.
  const unsubscribeAutoPrepare = bus.subscribeAll((event) => {
    if (closing) return;
    if (event.type !== 'agent/status') return;
    if ((event.payload as { status?: string }).status !== 'passed') return;
    const task = (async () => {
      try {
        const session = await sessions.getSession(event.sessionId);
        if (closing) return;
        if (!session || !canAutoPrepareDelivery(session.profile)) return;
        await jobRunner.enqueue({
          sessionId: event.sessionId,
          kind: 'delivery-auto-prepare',
        });
      } catch (error) {
        console.error('[auto-prepare] enqueue failed:', error);
      }
    })();
    trackAutomationTask(task);
  });

  // 4a: SessionService owns the run/resume/cancel/pause orchestration; the
  // project router degrades to auth + input assembly + mapping. Provider
  // preflight now belongs to the request-scoped engine factory above.
  const sessionService = createSessionService<WebRunEngineInput>({
    sessions,
    jobs,
    jobRunner,
    bus,
    repositories: dualRepositories,
    audit: dualAudit,
    projectRoot: projectContext.projectRoot,
    createEngine: createWebRunEngineFactory({
      projectContext,
      repositories: dualRepositories,
      audit: dualAudit,
      registry,
    }),
  });

  const context: ServerContext = {
    planPreviewSigner: createPlanPreviewSigner(),
    db,
    repositories: dualRepositories,
    audit: dualAudit,
    projectContext,
    sessions,
    bus,
    jobs,
    jobRunner,
    registry,
    sessionService,
  };

  const demandRouter = createDemandRouter(context);
  return {
    [webProjectScope]: createWebProjectScope(db, projectContext, sessions),
    draftShape: demandRouter,
    project: createProjectRouter(context, {
      probeProvider: input.providerProbe,
    }),
    delivery: createDeliveryRouter(context),
    artifact: createArtifactRouter(context),
    gate: createGateRouter(context),
    audit: createAuditRouter(context),
    review: createReviewRouter(context),
    role: createRoleRouter(context),
    workflow: createWorkflowRouter(context),
    progress: createProgressRouter(context),
    session: createSessionRouter(context),
    sessions,
    bus,
    async close() {
      // Stop admitting automation work, detach listeners, clear timers, and
      // wait for callbacks that had already crossed the listener boundary.
      // Unsubscribe alone cannot cancel an async callback suspended in
      // getSession()/enqueue(); closing SQLite before it settles recreates the
      // exact late-write race this teardown is meant to prevent.
      closing = true;
      unsubscribeReadiness();
      unsubscribeAutoPrepare();
      for (const timer of readinessDebounce.values()) clearTimeout(timer);
      readinessDebounce.clear();
      await Promise.allSettled([...automationTasks]);
      await jobRunner.stop();
      // P0-ARCH-02 增量：hard deadline 后未结算的 executor 仍可能持有
      // repositories 引用。在关闭 SQLite 前置位 closed 栅栏，让迟到的
      // repository/db 写入快速失败，而不是静默 late write 到已关闭句柄。
      db.markClosed();
      db.close();
    },
  };
}
