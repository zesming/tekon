import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  presentEvent,
  type SessionEvent,
  type SessionEventBus,
  type SessionEventStore,
} from '@tekon/core';

/**
 * Stream one session's durable events. The process-local bus is a low-latency
 * hint; SQLite remains the cross-process source. A short catch-up poll reads
 * from the last contiguous seq, so events appended by a separate CLI process
 * reach an already-open Web stream without a reconnect.
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
  if (sinceParam != null && /^\d+$/.test(sinceParam)) {
    cursor = Number(sinceParam);
  } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    cursor = Number(lastEventId);
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

  const writeFrame = (event: SessionEvent): void => {
    if (closed || response.writableEnded) return;
    const presented = presentEvent(event);
    if (!presented) return;
    const safeType = presented.type.replace(/[\r\n]/g, ' ');
    response.write(
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
  const drain = (): void => {
    for (;;) {
      const next = pending.get(cursor + 1);
      if (!next) break;
      pending.delete(next.seq);
      cursor = next.seq;
      writeFrame(next);
    }
  };
  const enqueue = (event: SessionEvent): void => {
    if (event.seq <= cursor || pending.has(event.seq)) return;
    pending.set(event.seq, event);
    drain();
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

  const catchUp = async (): Promise<void> => {
    if (closed || response.writableEnded || catchUpInFlight) return;
    catchUpInFlight = true;
    try {
      const events = await sessions.listEventsSince(sessionId, cursor);
      for (const event of events) enqueue(event);
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

  const catchUpMs = input.catchUpMs ?? 750;
  catchUpTimer = setInterval(() => {
    void catchUp();
  }, catchUpMs);
  catchUpTimer.unref?.();
}
