import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { SessionActionKind } from '../../../shared/rpc-contract.js';

type SessionActivityFields = {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

/**
 * Session events are a best-effort projection, while sessions.updated_at is a
 * durable row update. Activity must therefore use whichever timestamp is newer;
 * otherwise a status-only transition can remain buried when the matching event
 * projection is delayed or absent.
 */
export function effectiveLastActivityAt(
  session: Pick<SessionActivityFields, 'lastActivityAt' | 'updatedAt'>,
): string {
  return session.updatedAt > session.lastActivityAt
    ? session.updatedAt
    : session.lastActivityAt;
}

/** Return a new array ordered by effective activity with stable fallbacks. */
export function sortSessionsByActivity<T extends SessionActivityFields>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort((left, right) => {
    const activityOrder = effectiveLastActivityAt(right).localeCompare(
      effectiveLastActivityAt(left),
    );
    if (activityOrder !== 0) return activityOrder;

    const createdOrder = right.createdAt.localeCompare(left.createdAt);
    if (createdOrder !== 0) return createdOrder;

    return right.id.localeCompare(left.id);
  });
}

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
      const sessions = sortSessionsByActivity(
        await context.sessions.listSessions(workspace.id),
      );
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
            lastActivityAt: effectiveLastActivityAt(session),
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
          // The detail read currently has no latest-event projection. Keep the
          // durable row timestamp rather than fabricating event parity; the
          // list endpoint is the authoritative activity-ordering surface.
          lastActivityAt: session.updatedAt,
          needsAction: action.needsAction,
          actionKind: action.actionKind,
        },
      };
    },
  };
}
