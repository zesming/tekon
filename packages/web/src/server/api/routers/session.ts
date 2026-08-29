import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { SessionActionKind } from '../../../shared/rpc-contract.js';

/**
 * Phase 4 P1-04 / Phase 5 T3 (P1-UX-02): derive whether a session needs user
 * action and what kind from its current status and acknowledgedAt timestamp.
 * A failed session only needs action when unacknowledged (acknowledgedAt is null/undefined).
 */
export function deriveSessionAction(
  status: string,
  acknowledgedAt?: string | null,
): {
  needsAction: boolean;
  actionKind: SessionActionKind | null;
} {
  switch (status) {
    case 'awaiting-approval':
      return { needsAction: true, actionKind: 'approval' };
    case 'awaiting-input':
      return { needsAction: true, actionKind: 'input' };
    case 'failed':
      if (acknowledgedAt == null) {
        return { needsAction: true, actionKind: 'failed' };
      }
      return { needsAction: false, actionKind: null };
    default:
      return { needsAction: false, actionKind: null };
  }
}

/** Return the newest valid ISO timestamp while preserving the original value. */
export function latestActivityTimestamp(
  first: string,
  ...rest: string[]
): string {
  return rest.reduce((latest, candidate) => {
    const latestMs = Date.parse(latest);
    const candidateMs = Date.parse(candidate);
    if (Number.isNaN(candidateMs)) return latest;
    if (Number.isNaN(latestMs)) return candidate;
    return candidateMs > latestMs ? candidate : latest;
  }, first);
}

/**
 * Human-attention order for the Session List:
 *   needs action -> actively running -> idle -> terminal history.
 * Within the same group, most recent activity stays first.
 */
function attentionRank(
  status: string,
  acknowledgedAt?: string | null,
): number {
  if (deriveSessionAction(status, acknowledgedAt).needsAction) return 0;
  if (status === 'active') return 1;
  if (status === 'idle') return 2;
  return 3;
}

export function compareSessionAttention(
  left: { status: string; lastActivityAt: string; acknowledgedAt?: string | null },
  right: { status: string; lastActivityAt: string; acknowledgedAt?: string | null },
): number {
  const rankDifference =
    attentionRank(left.status, left.acknowledgedAt) -
    attentionRank(right.status, right.acknowledgedAt);
  if (rankDifference !== 0) return rankDifference;

  const leftMs = Date.parse(left.lastActivityAt);
  const rightMs = Date.parse(right.lastActivityAt);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return 0;
}

/**
 * Phase 3 3a / Phase 4 P1-04 / Phase 5 T3: session read-path router. Powers
 * the Session List UI (left rail / SessionsPage) and Session Detail metadata.
 *
 * session.list takes no client input: the client has no workspaceId, so the
 * server resolves the default workspace from projectRoot and returns its id
 * for the workspace picker (M2).
 */
export function createSessionRouter(context: ServerContext) {
  return {
    async list() {
      const workspace = await context.sessions.getOrCreateDefaultWorkspace(
        context.projectContext.projectRoot,
      );
      const sessions = await context.sessions.listSessions(workspace.id);
      const projectedSessions = sessions.map((session) => {
        const action = deriveSessionAction(
          session.status,
          session.acknowledgedAt,
        );
        return {
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          profile: session.profile,
          status: session.status,
          runId: session.runId,
          acknowledgedAt: session.acknowledgedAt,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          // session-store projects the newest event; updatedAt remains the
          // authoritative fallback for status-only changes or a missing
          // best-effort event projection.
          lastActivityAt: latestActivityTimestamp(
            session.createdAt,
            session.lastActivityAt,
            session.updatedAt,
          ),
          needsAction: action.needsAction,
          actionKind: action.actionKind,
        };
      });
      projectedSessions.sort(compareSessionAttention);
      return {
        workspaceId: workspace.id,
        sessions: projectedSessions,
      };
    },

    async get(input: { sessionId: string }) {
      const session = await context.sessions.getSession(input.sessionId);
      if (!session) {
        throw new ApiError('NOT_FOUND', `Session not found: ${input.sessionId}`);
      }

      // Session schema has no runId (frozen contract); compose it (N3). Read
      // the current event tail as well so list/get expose one lastActivityAt
      // meaning instead of list=max(event) while get=updatedAt. The tail read
      // projects only timestamp (no full-event payload deserialization).
      const [runId, latestEventAt] = await Promise.all([
        context.sessions.getRunIdBySessionId(input.sessionId),
        context.sessions.getLatestEventTimestamp(input.sessionId),
      ]);
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
          lastActivityAt: latestActivityTimestamp(
            session.createdAt,
            session.updatedAt,
            ...(latestEventAt ? [latestEventAt] : []),
          ),
          needsAction: action.needsAction,
          actionKind: action.actionKind,
        },
      };
    },

    async acknowledge(input: { sessionId: string }) {
      const acknowledgedAt = await context.sessions.acknowledgeSession(
        input.sessionId,
      );
      if (!acknowledgedAt) {
        throw new ApiError('NOT_FOUND', `Session not found: ${input.sessionId}`);
      }
      return { acknowledgedAt };
    },
  };
}
