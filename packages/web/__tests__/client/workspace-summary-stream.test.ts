import { describe, expect, it, vi } from 'vitest';
import {
  openWorkspaceSummaryStream,
  type WorkspaceSummaryEvent,
} from '../../src/client/lib/workspace-summary-stream.js';

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

function summaryFrame(sessionId: string, type = 'turn/start'): string {
  return `event: workspace/summary\ndata: ${JSON.stringify({
    workspaceId: 'ws_1',
    sessionId,
    type,
  })}\n\n`;
}

describe('openWorkspaceSummaryStream', () => {
  it('receives workspace summary events and passes session token', async () => {
    const seen: WorkspaceSummaryEvent[] = [];
    const states: string[] = [];
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return sseResponse(summaryFrame('sess_123', 'turn/start'));
    }) as unknown as typeof fetch;

    const handle = openWorkspaceSummaryStream({
      workspaceId: 'ws_1',
      token: 'test-token',
      fetchImpl,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      onEvent: (e) => seen.push(e),
      onStateChange: (s) => states.push(s),
    });

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    handle.close();

    expect(calls[0].url).toContain('/api/workspaces/ws_1/summary/events');
    expect(calls[0].headers['x-session-token']).toBe('test-token');
    expect(seen[0]).toEqual({
      workspaceId: 'ws_1',
      sessionId: 'sess_123',
      type: 'turn/start',
    });
  });

  it('stops on fatal 401 response without reconnecting', async () => {
    const states: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return { ok: false, status: 401, body: null } as unknown as Response;
    }) as unknown as typeof fetch;

    const handle = openWorkspaceSummaryStream({
      workspaceId: 'ws_1',
      token: 'bad-token',
      fetchImpl,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      onEvent: () => {},
      onStateChange: (s) => states.push(s),
    });

    await vi.waitFor(() => {
      expect(states).toContain('closed');
    }, { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 20));

    expect(call).toBe(1);
    expect(states).not.toContain('reconnecting');
    handle.close();
  });
});
