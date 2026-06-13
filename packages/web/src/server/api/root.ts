import {
  createAuditLogger,
  createRepositories,
  openTekonDatabase,
} from '@tekon/core';

import {
  assertProjectDatabaseExists,
  createProjectContext,
  type ResolveProjectRootInput,
} from '../project-context.js';

import type { ServerContext, ApiCaller } from './context.js';
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
} from './routers/index.js';

export type { ApiCaller } from './context.js';
export { dispatchApiCall } from './dispatch.js';

export async function createApiCaller(
  input: ResolveProjectRootInput,
): Promise<ApiCaller> {
  const projectContext = createProjectContext(input);
  assertProjectDatabaseExists(projectContext);

  const db = openTekonDatabase({ filename: projectContext.dbPath });
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });

  const context: ServerContext = { db, repositories, audit, projectContext };

  return {
    demand: createDemandRouter(context),
    project: createProjectRouter(context),
    delivery: createDeliveryRouter(context),
    artifact: createArtifactRouter(context),
    gate: createGateRouter(context),
    audit: createAuditRouter(context),
    review: createReviewRouter(context),
    role: createRoleRouter(context),
    workflow: createWorkflowRouter(context),
    progress: createProgressRouter(context),
    async close() {
      db.close();
    },
  };
}
