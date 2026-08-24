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
  createWorktreeManager,
  createWriteQueue,
  createJobRunner,
  openTekonDatabase,
  type AuditLogger,
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

/**
 * 4a: the web run-engine factory injected into SessionService. It encapsulates
 * the web provider/adapter construction (moved verbatim from the project
 * router's run handler): command gateway → web agent runtime → workflow
 * engine with gate/worktree managers. The service only calls the factory;
 * web-specific validation errors (ApiError from createWebAgentRuntime /
 * providerRuntimeFromRunInput) propagate through it unchanged.
 */
function createWebRunEngineFactory(deps: {
  projectContext: WebProjectContext;
  repositories: TekonRepositories;
  audit: AuditLogger;
  registry: SubprocessRegistry;
}): (input: WebRunEngineInput) => WorkflowEngine {
  return (input) => {
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
      allowDirtyBase: input.allowDirtyBase,
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
  input: ResolveProjectRootInput,
): Promise<ApiCaller> {
  const projectContext = createProjectContext(input);
  assertProjectDatabaseExists(projectContext);

  const db = openTekonDatabase({ filename: projectContext.dbPath });

  // S6/S7a: one shared write queue serializes legacy tables, session_events,
  // jobs, and the audit hash chain. MF4: audit appends run directly on the
  // queue (no re-enqueue into repositories → no self-wait deadlock).
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
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
  jobRunner.start();

  // 4e: readiness projection. When a gate result lands, (re-)evaluate pre-PR
  // readiness off the event stream so the UI/delivery can react without
  // polling. Debounced per session (a node emits several gate results in a
  // burst); the enqueue is fire-and-forget — a projection failure must never
  // destabilize the publisher (the bus already isolates listener throws, but
  // the async enqueue is guarded too). Long-lived server only: the durable
  // runner keeps polling, so the enqueued job is always drained here.
  const readinessDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  bus.subscribeAll((event) => {
    if (event.type !== 'gate/result') return;
    const existing = readinessDebounce.get(event.sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      readinessDebounce.delete(event.sessionId);
      void jobRunner
        .enqueue({ sessionId: event.sessionId, kind: 'readiness-evaluate' })
        .catch((error) => {
          console.error('[readiness] enqueue failed:', error);
        });
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    readinessDebounce.set(event.sessionId, timer);
  });

  // 4a: SessionService owns the run/resume/cancel/pause orchestration; the
  // project router degrades to auth + input assembly + mapping.
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
    draftShape: demandRouter,
    /** @deprecated Use draftShape instead */
    demand: demandRouter,
    project: createProjectRouter(context),
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
      // Clear pending readiness debounce timers first so none fires an enqueue
      // against a closing db/runner (R9). Then stop the runner (waits up to 5s
      // for in-flight jobs) before closing the db.
      for (const timer of readinessDebounce.values()) clearTimeout(timer);
      readinessDebounce.clear();
      await jobRunner.stop();
      db.close();
    },
  };
}
