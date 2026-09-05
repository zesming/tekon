import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  createSessionEventBus,
  type SessionEvent,
  type SessionEventStore,
} from '@tekon/core';

import {
  handleSessionEventsSse,
  RECONNECT_MAX_EVENTS,
} from '../../src/server/sse.js';

function event(sessionId: string, seq: number): SessionEvent {
  return {
    sessionId,
    seq,
    type: 'assistant/message',
    version: 1,
    timestamp: '2026-08-31T00:00:00.000Z',
    payload: { text: `event ${seq}` },
    visibility: 'ui-only',
    modelVisible: false,
    sourceEventSeqs: [],
    correlationId: null,
  };
}

describe('session SSE reconnect replay budget', () => {
  it('does not keep charging normal cross-process catch-up after the initial reconnect backlog drains', async () => {
    const sessionId = 'sess_reconnect_budget';
    const lastSeq = RECONNECT_MAX_EVENTS + 6;
    let phase: 'initial' | 'steady' = 'initial';

    const sessions = {
      async getSession() {
        return { id: sessionId };
      },
      async latestSeq() {
        return phase === 'initial' ? 1 : lastSeq;
      },
      async listEventsPage(
        _sessionId: string,
        cursor: number,
        limit: number,
      ) {
        if (phase === 'initial') {
          return cursor < 1
            ? { events: [event(sessionId, 1)], hasMore: false }
            : { events: [], hasMore: false };
        }

        if (cursor >= lastSeq) {
          return { events: [], hasMore: false };
        }
        const start = cursor + 1;
        const end = Math.min(lastSeq, start + limit - 1);
        return {
          events: Array.from({ length: end - start + 1 }, (_, index) =>
            event(sessionId, start + index),
          ),
          hasMore: end < lastSeq,
        };
      },
      async listEventsSince() {
        return [];
      },
    } as unknown as SessionEventStore;

    const request = new EventEmitter() as IncomingMessage;
    request.url = `/api/sessions/${sessionId}/events?sinceSeq=0`;
    request.headers = {};
    request.method = 'GET';

    const chunks: string[] = [];
    let ended = false;
    const responseEvents = new EventEmitter();
    const response = {
      statusCode: 200,
      get writableEnded() {
        return ended;
      },
      setHeader() {},
      flushHeaders() {},
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      once(eventName: string, listener: () => void) {
        responseEvents.once(eventName, listener);
      },
      end() {
        ended = true;
      },
    } as unknown as ServerResponse;

    await handleSessionEventsSse({
      request,
      response,
      sessionId,
      sessions,
      bus: createSessionEventBus(),
      heartbeatMs: 60_000,
      catchUpMs: 5,
    });

    // The reconnect-owned backlog is now drained. More than the reconnect
    // allowance then arrives through SQLite catch-up as normal live traffic.
    phase = 'steady';

    await vi.waitFor(
      () => {
        expect(chunks.some((chunk) => chunk.includes(`id: ${lastSeq}\n`))).toBe(
          true,
        );
      },
      { timeout: 5_000 },
    );

    expect(
      chunks.some((chunk) => chunk.includes('event: replay-truncated')),
    ).toBe(false);
    expect(ended).toBe(false);

    request.emit('close');
  });
});
