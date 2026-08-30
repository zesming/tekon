import {
  presentEvent,
  type PresentedEvent,
  type SessionEvent,
} from '@tekon/core';

import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { SessionActionKind } from '../../../shared/rpc-contract.js';

/**
 * Phase 4 P1-04 / Phase 5 T3 (P1-UX-02): derive whether a session needs user
 * action and what kind from its current status and current-failure
 * acknowledgement. A failed session only stops needing action after that same
 * failure generation has been acknowledged.
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
 * `acknowledged_at` currently lives beside the frozen Session contract. The
 * acknowledge write assigns acknowledged_at and updated_at from one timestamp;
 * any later status transition changes updated_at and reopens the failure. This
 * makes the acknowledgement generation-scoped even before the storage layer
 * gains an explicit failure-generation column or clears stale values itself.
 */
export function currentFailureAcknowledgement(input: {
  status: string;
  acknowledgedAt?: string | null;
  updatedAt: string;
}): string | null {
  if (input.status !== 'failed' || !input.acknowledgedAt) return null;
  return input.acknowledgedAt === input.updatedAt ? input.acknowledgedAt : null;
}

/**
 * Human-attention order for the Session List:
 *   needs action -> actively running -> idle -> terminal history.
 * Within the same group, most recent activity stays first.
 */
function attentionRank(status: string, acknowledgedAt?: string | null): number {
  if (deriveSessionAction(status, acknowledgedAt).needsAction) return 0;
  if (status === 'active') return 1;
  if (status === 'idle') return 2;
  return 3;
}

export function compareSessionAttention(
  left: {
    status: string;
    lastActivityAt: string;
    acknowledgedAt?: string | null;
  },
  right: {
    status: string;
    lastActivityAt: string;
    acknowledgedAt?: string | null;
  },
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
 * Backward-cursor read for "load earlier history" (ninth-review annotation
 * 16.3). Reads raw rows with seq < beforeSeq in DESCENDING order, filters to
 * visible events, and returns them in ascending order plus a continuation
 * cursor. The cursor is the smallest raw seq examined; the client uses it as
 * the next beforeSeq. Because the cursor comes from raw rows (not visible
 * ones), a page that is entirely internal events still advances the cursor, so
 * history paging never dead-ends on a long run of filtered events.
 *
 * nextBeforeSeq is null only when no older raw rows remain — the client's sole
 * "reached the start" signal. hasMore is relative to beforeSeq (older raw rows
 * exist), not to the global event stream.
 */
async function readEventsBackward(
  sessions: ServerContext['sessions'],
  sessionId: string,
  beforeSeq: number,
  targetLimit: number,
  latestSeq: number,
): Promise<{
  events: PresentedEvent[];
  hasMore: boolean;
  latestSeq: number;
  nextBeforeSeq: number | null;
}> {
  const RAW_CHUNK = Math.max(targetLimit, 200);
  // Bounded scan per call: enough to fill a visible page through sparse
  // internal-event regions, but never an unbounded history scan. The cursor
  // always advances, so the client can page further on the next call.
  const MAX_SCANS = 10;
  const collected: PresentedEvent[] = [];
  let cursor = beforeSeq;
  let reachedStart = false;

  for (let scan = 0; scan < MAX_SCANS; scan++) {
    const page = await sessions.listEventsBefore(sessionId, cursor, RAW_CHUNK);
    if (page.events.length === 0) {
      reachedStart = true;
      break;
    }
    // page.events is descending; the last element has the smallest seq.
    const smallestRawSeq = page.events[page.events.length - 1].seq;
    for (const rawEvent of page.events) {
      const presented = presentEvent(rawEvent);
      if (presented !== null) {
        collected.push(presented);
      }
    }
    cursor = smallestRawSeq;
    if (collected.length >= targetLimit) {
      break;
    }
    if (!page.hasMore) {
      reachedStart = true;
      break;
    }
  }

  // collected is descending; return the newest targetLimit visible events.
  const trimmed = collected.slice(0, targetLimit);
  trimmed.sort((a, b) => a.seq - b.seq);

  // The next cursor is the smallest seq we fully accounted for. When we
  // returned visible events it is the smallest returned seq (older visible
  // events are re-read on the next call and de-duped by the client). When the
  // whole scan was internal events it is the smallest raw seq examined, so the
  // client skips past the sparse region instead of dead-ending.
  const nextCursor = trimmed.length > 0 ? trimmed[0].seq : cursor;

  return {
    events: trimmed,
    hasMore: !reachedStart,
    latestSeq,
    nextBeforeSeq: reachedStart ? null : nextCursor,
  };
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
        const acknowledgedAt = currentFailureAcknowledgement({
          status: session.status,
          acknowledgedAt: session.acknowledgedAt,
          updatedAt: session.updatedAt,
        });
        const action = deriveSessionAction(session.status, acknowledgedAt);
        return {
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          profile: session.profile,
          status: session.status,
          runId: session.runId,
          acknowledgedAt,
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
        throw new ApiError(
          'NOT_FOUND',
          `Session not found: ${input.sessionId}`,
        );
      }

      // Session schema has no runId/acknowledgedAt (frozen contract); compose
      // both from the projection/store. Read the current event tail as well so
      // list/get expose one lastActivityAt and one needsAction meaning.
      const [runId, latestEventAt, workspaceSessions] = await Promise.all([
        context.sessions.getRunIdBySessionId(input.sessionId),
        context.sessions.getLatestEventTimestamp(input.sessionId),
        context.sessions.listSessions(session.workspaceId),
      ]);
      const projected = workspaceSessions.find(
        (candidate) => candidate.id === input.sessionId,
      );
      const acknowledgedAt = currentFailureAcknowledgement({
        status: session.status,
        acknowledgedAt: projected?.acknowledgedAt,
        updatedAt: session.updatedAt,
      });
      const action = deriveSessionAction(session.status, acknowledgedAt);
      return {
        session: {
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          profile: session.profile,
          status: session.status,
          runId,
          acknowledgedAt,
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

    async events(input: {
      sessionId: string;
      sinceSeq?: number;
      beforeSeq?: number;
      limit?: number;
    }) {
      const session = await context.sessions.getSession(input.sessionId);
      if (!session) {
        throw new ApiError(
          'NOT_FOUND',
          `Session not found: ${input.sessionId}`,
        );
      }

      const targetLimit = Math.min(Math.max(1, input.limit ?? 500), 1000);
      const latestSeq = await context.sessions.latestSeq(input.sessionId);

      // Backward cursor path ("load earlier history"): read raw rows with
      // seq < beforeSeq in descending order and return a continuation cursor
      // (nextBeforeSeq) even when a whole raw page is filtered out. This fixes
      // the old fixed-scan dead end where >5 consecutive internal-event pages
      // returned an empty visible page with hasMore=true but no cursor.
      if (typeof input.beforeSeq === 'number') {
        return readEventsBackward(
          context.sessions,
          input.sessionId,
          input.beforeSeq,
          targetLimit,
          latestSeq,
        );
      }

      // Forward path (initial tail / SSE catch-up): unchanged.
      let currentSinceSeq = input.sinceSeq ?? 0;
      const presentedEvents: PresentedEvent[] = [];
      let hasMore = false;
      const MAX_PAGE_SCANS = 5;

      for (let scan = 0; scan < MAX_PAGE_SCANS; scan++) {
        const remaining = targetLimit - presentedEvents.length;
        const rawChunkSize = Math.max(remaining, 100);
        const page = await context.sessions.listEventsPage(
          input.sessionId,
          currentSinceSeq,
          rawChunkSize,
        );
        const rawEvents = page.events;
        hasMore = page.hasMore;

        if (rawEvents.length === 0) {
          hasMore = false;
          break;
        }

        for (let i = 0; i < rawEvents.length; i++) {
          const rawEvent = rawEvents[i];
          currentSinceSeq = Math.max(currentSinceSeq, rawEvent.seq);
          const presented = presentEvent(rawEvent);
          if (presented !== null) {
            presentedEvents.push(presented);
            if (presentedEvents.length >= targetLimit) {
              if (i < rawEvents.length - 1 || page.hasMore) {
                hasMore = true;
              } else {
                hasMore = false;
              }
              break;
            }
          }
        }

        if (presentedEvents.length >= targetLimit) {
          break;
        }

        if (!page.hasMore) {
          hasMore = false;
          break;
        }
      }

      return {
        events: presentedEvents,
        hasMore,
        latestSeq,
      };
    },

    async acknowledge(input: { sessionId: string }) {
      const session = await context.sessions.getSession(input.sessionId);
      if (!session) {
        throw new ApiError(
          'NOT_FOUND',
          `Session not found: ${input.sessionId}`,
        );
      }
      if (session.status !== 'failed') {
        throw new ApiError(
          'BAD_REQUEST',
          'Only a currently failed session can be marked as handled',
        );
      }

      const acknowledgedAt = await context.sessions.acknowledgeSession(
        input.sessionId,
      );
      if (!acknowledgedAt) {
        throw new ApiError(
          'NOT_FOUND',
          `Session not found: ${input.sessionId}`,
        );
      }
      return { acknowledgedAt };
    },
  };
}
