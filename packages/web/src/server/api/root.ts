import {
  createAuditLogger,
  createDualWriteAuditLogger,
  createDualWriteRepositories,
  createJobRepository,
  createRepositories,
  createSessionDualWriteBridge,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWriteQueue,
  createJobRunner,
  openTekonDatabase,
} from '@tekon/core';

import {
  assertProjectDatabaseExists,
  createProjectContext,
  type ResolveProjectRootInput,
} from '../project-context.js';

import type { ServerContext, ApiCaller } from './context.js';
import { createWorkflowJobExecutor } from './job-executor.js';
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
  const jobRunner = createJobRunner({ jobs, sessions, bus, registry, executor });
  jobRunner.start();

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
      // Stop the runner (waits up to 5s for in-flight jobs to settle) before
      // closing the db, so no job writes to a closed handle (R9).
      await jobRunner.stop();
      db.close();
    },
  };
}
