import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  presentEvent,
  type SessionEvent,
  type SessionEventBus,
  type SessionEventStore,
} from '@tekon/core';

export const REPLAY_WINDOW = 500;
export const CATCH_UP_CHUNK_LIMIT = 500;
export const RECONNECT_MAX_EVENTS = 2000;
export const RECONNECT_MAX_BYTES = 4_000_000;
// Slow-client backpressure cap (ninth-review annotation 16.4): while the socket
// is backpressured, live events buffer in `pending`. Bound that buffer in both
// event count and bytes so a stalled client cannot grow server memory without
// limit. On overflow we truncate to the tail window and close; the client
// reconnects (it already handles replay-truncated) and re-subscribes to a fresh
// tail. Sized above the replay window so normal bursts never trip it.
export const MAX_PENDING_EVENTS = 10_000;
export const MAX_PENDING_BYTES = 20_000_000;

/**
 * Stream one session's durable events. The process-local bus is a low-latency
 * hint; SQLite remains the cross-process source. A short catch-up poll reads
 * from the last contiguous seq, so events appended by a separate CLI process
 * reach an already-open Web stream without a reconnect.
 *
 * P1-UX-03: Bounded replay window on fresh connect (no Last-Event-ID / sinceSeq).
 * Reconnects with Last-Event-ID continue to catch up [k..end] chunk-by-chunk with
 * no loss and no duplication.
 */
export async function handleSessionEventsSse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sessionId: string;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  heartbeatMs?: number;
  catchUpMs?: number;
}): Promise<void> {
  const { request, response, sessionId, sessions, bus } = input;

  // Validate before committing event-stream headers so the route can still
  // return a normal JSON 404/500.
  const session = await sessions.getSession(sessionId);
  if (!session) {
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: `Session not found: ${sessionId}`,
        },
      }),
    );
    return;
  }

  const url = new URL(request.url ?? '', 'http://localhost');
  const sinceParam = url.searchParams.get('sinceSeq');
  const lastEventId = request.headers['last-event-id'];
  let cursor = 0;
  let isFreshConnect = true;

  if (sinceParam != null && /^\d+$/.test(sinceParam)) {
    cursor = Number(sinceParam);
    isFreshConnect = false;
  } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    cursor = Number(lastEventId);
    isFreshConnect = false;
  }

  if (isFreshConnect) {
    const latest =
      typeof sessions.latestSeq === 'function'
        ? await sessions.latestSeq(sessionId)
        : 0;
    cursor = Math.max(0, latest - REPLAY_WINDOW);
  }

  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let catchUpTimer: ReturnType<typeof setInterval> | null = null;
  let catchUpInFlight = false;

  let isBackpressured = false;

  const writeFrame = (event: SessionEvent): boolean => {
    if (closed || response.writableEnded) return true;
    const presented = presentEvent(event);
    if (!presented) return true;
    const safeType = presented.type.replace(/[\r\n]/g, ' ');
    return response.write(
      `id: ${presented.seq}\n` +
        `event: ${safeType}\n` +
        `data: ${JSON.stringify(presented)}\n\n`,
    );
  };

  // Live events may arrive ahead of an event committed in another process.
  // Buffer by seq and only advance the cursor through a contiguous prefix.
  // Internal events still advance the cursor even though presentEvent filters
  // them from the client.
  const pending = new Map<number, SessionEvent>();
  let pendingBytes = 0;
  let backpressureTruncated = false;

  // Truncate to the tail window and close so the client reconnects to a fresh
  // tail instead of buffering without bound. Mirrors the catch-up truncation
  // frame so the client's existing replay-truncated handling applies.
  const truncateForBackpressure = (): void => {
    if (backpressureTruncated || closed || response.writableEnded) return;
    backpressureTruncated = true;
    pending.clear();
    pendingBytes = 0;
    void (async () => {
      try {
        const latest =
          typeof sessions.latestSeq === 'function'
            ? await sessions.latestSeq(sessionId)
            : 0;
        const tailCursor = Math.max(0, latest - REPLAY_WINDOW);
        cursor = tailCursor;
        if (!response.writableEnded) {
          response.write(
            `event: replay-truncated\n` +
              `data: ${JSON.stringify({
                cursor: tailCursor,
                reason:
                  'Slow-client backpressure buffer exceeded; truncated to tail window',
              })}\n\n`,
          );
        }
      } catch {
        // fall through to close
      } finally {
        cleanup();
      }
    })();
  };

  const drain = (): void => {
    if (isBackpressured) return;
    for (;;) {
      const next = pending.get(cursor + 1);
      if (!next) break;
      pending.delete(next.seq);
      pendingBytes -= Buffer.byteLength(JSON.stringify(next));
      if (pendingBytes < 0) pendingBytes = 0;
      cursor = next.seq;
      const ok = writeFrame(next);
      if (!ok) {
        isBackpressured = true;
        response.once('drain', () => {
          isBackpressured = false;
          drain();
        });
        break;
      }
    }
  };
  const enqueue = (event: SessionEvent): void => {
    if (event.seq <= cursor || pending.has(event.seq)) return;
    if (backpressureTruncated) return;
    pending.set(event.seq, event);
    pendingBytes += Buffer.byteLength(JSON.stringify(event));
    if (pending.size > MAX_PENDING_EVENTS || pendingBytes > MAX_PENDING_BYTES) {
      truncateForBackpressure();
      return;
    }
    if (!isBackpressured) {
      drain();
    }
  };

  // Subscribe before replay. The contiguous buffer removes replay/live races
  // and de-duplicates an event that appears in both paths.
  const unsubscribe = bus.subscribe(sessionId, enqueue);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (catchUpTimer) clearInterval(catchUpTimer);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  request.on('close', cleanup);

  let catchUpEventsCount = 0;
  let catchUpBytesCount = 0;
  // The reconnect budget protects only the backlog owned by the first catch-up
  // after a Last-Event-ID/sinceSeq connection. Once that backlog is drained,
  // later cross-process events are normal live traffic and must not accumulate
  // forever against the reconnect allowance.
  let reconnectReplayBudgetActive = !isFreshConnect;

  const catchUp = async (): Promise<void> => {
    if (closed || response.writableEnded || catchUpInFlight) return;
    catchUpInFlight = true;
    let replayTruncatedThisPass = false;
    try {
      for (;;) {
        if (closed || response.writableEnded) break;
        let events: SessionEvent[] = [];
        let hasMore = false;
        if (typeof (sessions as any).listEventsPage === 'function') {
          const pageResult = await (sessions as any).listEventsPage(
            sessionId,
            cursor,
            CATCH_UP_CHUNK_LIMIT,
          );
          events = Array.isArray(pageResult)
            ? pageResult
            : (pageResult.events ?? []);
          hasMore = Array.isArray(pageResult)
            ? events.length >= CATCH_UP_CHUNK_LIMIT
            : (pageResult.hasMore ?? false);
        } else {
          events = await sessions.listEventsSince(sessionId, cursor);
          hasMore = false;
        }

        let truncated = false;
        for (const event of events) {
          if (reconnectReplayBudgetActive) {
            catchUpEventsCount += 1;
            catchUpBytesCount += Buffer.byteLength(JSON.stringify(event));
            if (
              catchUpEventsCount > RECONNECT_MAX_EVENTS ||
              catchUpBytesCount > RECONNECT_MAX_BYTES
            ) {
              truncated = true;
              replayTruncatedThisPass = true;
              break;
            }
          }
          enqueue(event);
        }

        if (truncated) {
          const latest =
            typeof sessions.latestSeq === 'function'
              ? await sessions.latestSeq(sessionId)
              : 0;
          cursor = Math.max(0, latest - REPLAY_WINDOW);
          pending.clear();
          pendingBytes = 0;
          response.write(
            `event: replay-truncated\n` +
              `data: ${JSON.stringify({
                cursor,
                reason:
                  'Reconnection replay budget exceeded; truncated to tail window',
              })}\n\n`,
          );
          if (typeof (sessions as any).listEventsPage === 'function') {
            const tailResult = await (sessions as any).listEventsPage(
              sessionId,
              cursor,
              REPLAY_WINDOW,
            );
            const tailEvents: SessionEvent[] = Array.isArray(tailResult)
              ? tailResult
              : (tailResult.events ?? []);
            for (const tailEvent of tailEvents) {
              enqueue(tailEvent);
            }
          }
          break;
        }

        if (!hasMore || events.length === 0) break;
      }

      if (
        reconnectReplayBudgetActive &&
        !replayTruncatedThisPass &&
        !closed &&
        !response.writableEnded
      ) {
        reconnectReplayBudgetActive = false;
      }
    } catch {
      cleanup();
    } finally {
      catchUpInFlight = false;
    }
  };

  try {
    await catchUp();
  } catch {
    cleanup();
    return;
  }

  if (closed || response.writableEnded) {
    cleanup();
    return;
  }

  const heartbeatMs = input.heartbeatMs ?? 15_000;
  heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded && !isBackpressured) {
      response.write(': ping\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const catchUpMs = input.catchUpMs ?? 750;
  catchUpTimer = setInterval(() => {
    void catchUp();
  }, catchUpMs);
  catchUpTimer.unref?.();
}

function computeWorkspaceSignature(
  sessions: Array<{
    id: string;
    status: string;
    updatedAt: string;
    lastActivityAt: string;
    acknowledgedAt: string | null;
  }>,
): string {
  return sessions
    .map(
      (s) =>
        `${s.id}:${s.status}:${s.updatedAt}:${s.lastActivityAt}:${s.acknowledgedAt ?? ''}`,
    )
    .sort()
    .join('|');
}

/**
 * Phase 5 T5 (P1-UX-01): workspace-level summary SSE stream.
 * Broadcasts lightweight change frames whenever a session in this workspace
 * changes state or receives an event, allowing the client to invalidate
 * session.list without heavy polling.
 */
export async function handleWorkspaceSummarySse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  workspaceId: string;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  heartbeatMs?: number;
  catchUpMs?: number;
}): Promise<void> {
  const { request, response, workspaceId, sessions, bus } = input;

  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let catchUpTimer: ReturnType<typeof setInterval> | null = null;
  let catchUpInFlight = false;
  let lastSignature = '';
  let workspaceSessionIds = new Set<string>();

  const writeFrame = (data: {
    workspaceId: string;
    sessionId?: string;
    type?: string;
    timestamp?: string;
  }): void => {
    if (closed || response.writableEnded) return;
    response.write(
      `event: workspace/summary\n` + `data: ${JSON.stringify(data)}\n\n`,
    );
  };

  // 1. Process-local bus subscription. subscribeAll is repository-wide, so
  // filter against the latest durable workspace membership before forwarding.
  // New sessions that appear between polls are still caught by the signature
  // poll below; no foreign-workspace metadata is ever emitted meanwhile.
  const unsubscribe = bus.subscribeAll((event) => {
    if (
      closed ||
      response.writableEnded ||
      !workspaceSessionIds.has(event.sessionId)
    ) {
      return;
    }
    writeFrame({
      workspaceId,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
    });
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (catchUpTimer) clearInterval(catchUpTimer);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  request.on('close', cleanup);

  // 2. Cross-process catch-up poll: checks whether any session in the workspace
  // has newer activity than last seen, and refreshes the membership filter used
  // by the process-local bus path.
  const catchUp = async (): Promise<void> => {
    if (closed || response.writableEnded || catchUpInFlight) return;
    catchUpInFlight = true;
    try {
      const sessionList = await sessions.listSessions(workspaceId);
      workspaceSessionIds = new Set(sessionList.map((session) => session.id));
      const signature = computeWorkspaceSignature(sessionList);
      if (lastSignature && signature !== lastSignature) {
        writeFrame({ workspaceId, timestamp: new Date().toISOString() });
      }
      lastSignature = signature;
    } catch {
      cleanup();
    } finally {
      catchUpInFlight = false;
    }
  };

  try {
    await catchUp();
  } catch {
    cleanup();
    return;
  }

  if (closed || response.writableEnded) {
    cleanup();
    return;
  }

  const heartbeatMs = input.heartbeatMs ?? 15_000;
  heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) response.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  const catchUpMs = input.catchUpMs ?? 1_000;
  catchUpTimer = setInterval(() => {
    void catchUp();
  }, catchUpMs);
  catchUpTimer.unref?.();
}
