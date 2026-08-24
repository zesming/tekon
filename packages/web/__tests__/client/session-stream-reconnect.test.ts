import { describe, expect, it, vi } from 'vitest';

import { openSessionStream } from '../../src/client/lib/session-stream.js';

// Phase 3 3d: reconnect hardening. openSessionStream reconnects with backoff
// and resumes via Last-Event-ID (server stitches 0..k ∪ k..end). These tests
// drive it with a fake fetch that yields SSE frames then disconnects, and
// assert: (a) events surface, (b) reconnect sends Last-Event-ID = max seq seen,
// (c) the replay overlap does not duplicate events downstream.

/** Build a fake Response whose body streams the given SSE text then closes. */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function frame(seq: number, type = 'turn/start'): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type })}\n\n`;
}

describe('openSessionStream reconnect', () => {
  it('surfaces events and reconnects with Last-Event-ID after a disconnect', async () => {
    const seen: number[] = [];
    const states: string[] = [];
    const calls: Array<Record<string, string>> = [];

    // First connection yields seq 1,2 then closes; reconnect yields 2,3
    // (overlap at 2). Third call hangs so the test can settle.
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      calls.push((init?.headers as Record<string, string>) ?? {});
      if (call === 1) return sseResponse(frame(1) + frame(2));
      if (call === 2) return sseResponse(frame(2) + frame(3));
      // Keep later reconnects from looping forever in the test.
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const handle = openSessionStream({
      sessionId: 's1',
      token: 'tok',
      fetchImpl,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      onEvent: (e) => seen.push(e.seq),
      onStateChange: (s) => states.push(s),
    });

    // Wait for the first connection + a reconnect to happen.
    await vi.waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 });
    // Give the second connection's frames time to flush.
    await vi.waitFor(() => {
      expect(seen).toContain(3);
    }, { timeout: 2000 });

    handle.close();

    // The token header was sent on connect.
    expect(calls[0]['x-session-token']).toBe('tok');
    // The reconnect resumed from the max seq seen on the first connection (2).
    expect(calls[1]['Last-Event-ID']).toBe('2');
    // connState went live then reconnecting.
    expect(states).toContain('live');
    expect(states).toContain('reconnecting');
  });

  it('does not send Last-Event-ID on the very first connection', async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>) ?? {});
      return new Promise<Response>(() => {}); // hang; we only inspect the request
    }) as unknown as typeof fetch;

    const handle = openSessionStream({
      sessionId: 's1',
      token: null,
      fetchImpl,
      onEvent: () => {},
      onStateChange: () => {},
    });

    await vi.waitFor(() => {
      expect(calls.length).toBe(1);
    }, { timeout: 2000 });
    handle.close();

    expect(calls[0]['Last-Event-ID']).toBeUndefined();
    // No token → no auth header (the e2e monkeypatch/production AuthContext adds it).
    expect(calls[0]['x-session-token']).toBeUndefined();
  });
});
