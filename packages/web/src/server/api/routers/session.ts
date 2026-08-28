import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { SessionActionKind } from '../../../shared/rpc-contract.js';

/**
 * Phase 4 P1-04: derive whether a session needs user action and what kind
 * from its current status.
 */
export function deriveSessionAction(status: string): {
  needsAction: boolean;
  actionKind: SessionActionKind | null;
} {
  switch (status) {
    case 'awaiting-approval':
      return { needsAction: true, actionKind: 'approval' };
    case 'awaiting-input':
      return { needsAction: true, actionKind: 'input' };
    case 'failed':
      return { needsAction: true, actionKind: 'failed' };
    default:
      return { needsAction: false, actionKind: null };
  }
}

/**
 * Phase 3 3a / Phase 4 P1-04: session read-path router. Powers the Session List
 * UI (left rail / SessionsPage) and Session Detail metadata (event bodies come
 * from the SSE endpoint, not from here — design D2).
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
        sessions: sessions.map((session) => {
          const action = deriveSessionAction(session.status);
          return {
            id: session.id,
            workspaceId: session.workspaceId,
            title: session.title,
            profile: session.profile,
            status: session.status,
            runId: session.runId,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastActivityAt: session.lastActivityAt,
            needsAction: action.needsAction,
            actionKind: action.actionKind,
          };
        }),
      };
    },

    async get(input: { sessionId: string }) {
      const session = await context.sessions.getSession(input.sessionId);
      if (!session) {
        throw new ApiError('NOT_FOUND', `Session not found: ${input.sessionId}`);
      }
      // Session schema has no runId (frozen contract); compose it (N3).
      const runId = await context.sessions.getRunIdBySessionId(input.sessionId);
      const action = deriveSessionAction(session.status);
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
          // get uses updatedAt as lastActivityAt (only status changes bump it);
          // list aggregates max(session_events.timestamp). No client consumes
          // get's lastActivityAt today — align the two if a detail view ever
          // renders activity time (P1-04 review note).
          lastActivityAt: session.updatedAt,
          needsAction: action.needsAction,
          actionKind: action.actionKind,
        },
      };
    },
  };
}
