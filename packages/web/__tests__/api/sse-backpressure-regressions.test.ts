import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionEventBus,
  type SessionEvent,
  type SessionEventStore,
} from '@tekon/core';

import {
  handleSessionEventsSse,
  handleWorkspaceSummarySse,
} from '../../src/server/sse.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) cleanup();
});

function sessionEvent(seq: number, sessionId = 'sess_1'): SessionEvent {
  return {
    sessionId,
    seq,
    type: 'assistant/message',
    version: 1,
    timestamp: '2026-08-31T00:00:00.000Z',
    payload: { text: `event ${seq}` },
    visibility: 'model',
    modelVisible: true,
    sourceEventSeqs: [],
    correlationId: null,
  };
}

function makeRequest(url: string): {
  request: IncomingMessage;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const request = emitter as IncomingMessage;
  request.url = url;
  request.headers = {};
  request.method = 'GET';
  return { request, emitter };
}

function makeResponse(
  shouldBackpressure: (chunk: string, writeIndex: number) => boolean,
): {
  response: ServerResponse;
  emitter: EventEmitter;
  writes: string[];
  ended(): boolean;
} {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  let ended = false;

  const response = {
    statusCode: 200,
    get writableEnded() {
      return ended;
    },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      writes.push(String(chunk));
      return !shouldBackpressure(String(chunk), writes.length);
    },
    once: emitter.once.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    end() {
      ended = true;
    },
  } as unknown as ServerResponse;

  return { response, emitter, writes, ended: () => ended };
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeSessionStore(totalEvents: number, onPage?: () => void) {
  return {
    getSession: async () => ({
      id: 'sess_1',
      workspaceId: 'ws_1',
      title: 'test',
      profile: 'human-web',
      status: 'active',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    }),
    latestSeq: async () => totalEvents,
    listEventsPage: async (
      _sessionId: string,
      sinceSeq: number,
      limit: number,
    ) => {
      onPage?.();
      const count = Math.max(0, Math.min(limit, totalEvents - sinceSeq));
      const events = Array.from({ length: count }, (_, index) =>
        sessionEvent(sinceSeq + index + 1),
      );
      return {
        events,
        hasMore: sinceSeq + count < totalEvents,
      };
    },
    listEventsSince: async () => [],
  } as unknown as SessionEventStore;
}

describe('SSE combined backpressure regressions', () => {
  it('does not re-read the same paged catch-up range while the socket is blocked', async () => {
    let pageCalls = 0;
    const sessions = makeSessionStore(1_200, () => {
      pageCalls += 1;
    });
    const bus = createSessionEventBus();
    const request = makeRequest('/api/sessions/sess_1/events?sinceSeq=0');
    const response = makeResponse(
      (chunk, writeIndex) => writeIndex === 1 && chunk.includes('id: 1'),
    );

    await handleSessionEventsSse({
      request: request.request,
      response: response.response,
      sessionId: 'sess_1',
      sessions,
      bus,
      heartbeatMs: 60_000,
      catchUpMs: 5,
    });
    cleanupTasks.push(() => request.emitter.emit('close'));

    // The first page was accepted into the pending/socket buffers. While the
    // cursor cannot advance, a second DB page would overlap that same range and
    // double-count it against the reconnect budget.
    expect(pageCalls).toBe(1);
    expect(response.writes.join('')).not.toContain('replay-truncated');

    response.emitter.emit('drain');
    await waitUntil(
      () => response.writes.some((chunk) => chunk.includes('id: 1200\n')),
      'paged catch-up did not resume after drain',
    );

    expect(response.writes.join('')).not.toContain('replay-truncated');
    expect(pageCalls).toBeGreaterThan(1);
  });

  it('treats a blocked session heartbeat as socket backpressure', async () => {
    const sessions = makeSessionStore(0);
    const bus = createSessionEventBus();
    const request = makeRequest('/api/sessions/sess_1/events?sinceSeq=0');
    const response = makeResponse(
      (chunk, writeIndex) => writeIndex === 1 && chunk === ': ping\n\n',
    );

    await handleSessionEventsSse({
      request: request.request,
      response: response.response,
      sessionId: 'sess_1',
      sessions,
      bus,
      heartbeatMs: 5,
      catchUpMs: 60_000,
    });
    cleanupTasks.push(() => request.emitter.emit('close'));

    await waitUntil(
      () => response.writes.some((chunk) => chunk === ': ping\n\n'),
      'session heartbeat was not written',
    );

    bus.publish(sessionEvent(1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(response.writes.join('')).not.toContain('id: 1\n');

    response.emitter.emit('drain');
    await waitUntil(
      () => response.writes.join('').includes('id: 1\n'),
      'session event did not drain after heartbeat backpressure cleared',
    );
  });

  it('treats a blocked workspace heartbeat as socket backpressure', async () => {
    const sessions = {
      listSessions: async () => [
        {
          id: 'sess_1',
          workspaceId: 'ws_1',
          title: 'test',
          profile: 'human-web',
          status: 'active',
          runId: null,
          acknowledgedAt: null,
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
          lastActivityAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    } as unknown as SessionEventStore;
    const bus = createSessionEventBus();
    const request = makeRequest('/api/workspaces/ws_1/summary');
    const response = makeResponse(
      (chunk, writeIndex) => writeIndex === 1 && chunk === ': ping\n\n',
    );

    await handleWorkspaceSummarySse({
      request: request.request,
      response: response.response,
      workspaceId: 'ws_1',
      sessions,
      bus,
      heartbeatMs: 5,
      catchUpMs: 60_000,
    });
    cleanupTasks.push(() => request.emitter.emit('close'));

    await waitUntil(
      () => response.writes.some((chunk) => chunk === ': ping\n\n'),
      'workspace heartbeat was not written',
    );

    bus.publish(sessionEvent(1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(response.writes.join('')).not.toContain('"sessionId":"sess_1"');

    response.emitter.emit('drain');
    await waitUntil(
      () => response.writes.join('').includes('"sessionId":"sess_1"'),
      'workspace frame did not drain after heartbeat backpressure cleared',
    );
  });
});
