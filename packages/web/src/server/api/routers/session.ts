import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';

/**
 * Phase 3 3a: session read-path router. Powers the Session List UI (left rail)
 * and Session Detail metadata (event bodies come from the SSE endpoint, not
 * from here — design D2).
 *
 * session.list takes no client input: the client has no workspaceId, so the
 * server resolves the default workspace from projectRoot (the same pattern
 * project.run uses) and returns its id for the workspace picker (M2).
 */
export function createSessionRouter(context: ServerContext) {
  return {
    async list() {
      const workspace = await context.sessions.getOrCreateDefaultWorkspace(
        context.projectContext.projectRoot,
      );
      const sessions = await context.sessions.listSessions(workspace.id);
      return {
        workspaceId: workspace.id,
        sessions: sessions.map((session) => ({
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          profile: session.profile,
          status: session.status,
          runId: session.runId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })),
      };
    },

    async get(input: { sessionId: string }) {
      const session = await context.sessions.getSession(input.sessionId);
      if (!session) {
        throw new ApiError('NOT_FOUND', `Session not found: ${input.sessionId}`);
      }
      // Session schema has no runId (frozen contract); compose it (N3).
      const runId = await context.sessions.getRunIdBySessionId(input.sessionId);
      return {
        session: {
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          profile: session.profile,
          status: session.status,
          runId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      };
    },
  };
}
