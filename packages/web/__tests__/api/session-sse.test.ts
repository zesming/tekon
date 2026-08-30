import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  createSessionEventBus,
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
  type SessionEventBus,
  type SessionEventStore,
} from '@tekon/core';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';
import { handleSessionEventsSse } from '../../src/server/sse.js';

// S8: SSE endpoint GET /api/sessions/:sessionId/events (design §3.1).
// HTTP-level tests cover auth (401/404), historical replay via sinceSeq, frame
// format, and internal-event filtering (C5). Unit-level tests drive
// handleSessionEventsSse directly against a real store+bus with a fake req/res
// to deterministically exercise the M6 replay→subscribe boundary (no loss, no
// duplication) and live push after replay — behavior the HTTP path cannot seed
// because the server owns its bus internally.
const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Shared store helpers
// ---------------------------------------------------------------------------

function openStore(projectRoot: string): {
  store: SessionEventStore;
  bus: SessionEventBus;
  close(): void;
} {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  const writeQueue = createWriteQueue();
  const store = createSessionEventStore(db, writeQueue);
  const bus = createSessionEventBus();
  return { store, bus, close: () => db.close() };
}

async function seedSession(
  store: SessionEventStore,
  projectRoot: string,
): Promise<string> {
  const workspace = await store.getOrCreateDefaultWorkspace(projectRoot);
  const session = await store.createSession({
    workspaceId: workspace.id,
    title: 'sse-test',
    profile: 'human-web',
    runId: null,
  });
  return session.id;
}

// ---------------------------------------------------------------------------
// HTTP-level SSE frame parsing + collection
// ---------------------------------------------------------------------------

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) {
      continue;
    }
    const frame: SseFrame = {};
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
    }
    frames.push(frame);
  }
  return frames;
}

function collectSse(
  baseUrl: string,
  path: string,
  options: {
    token?: string;
    extraHeaders?: Record<string, string>;
    stopWhen: (frames: SseFrame[]) => boolean;
    timeoutMs?: number;
  },
): Promise<{ status: number; frames: SseFrame[]; raw: string }> {
  const u = new URL(baseUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = { ...options.extraHeaders };
    if (options.token) headers['x-session-token'] = options.token;
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, method: 'GET', path, headers },
      (res) => {
        let raw = '';
        const status = res.statusCode ?? 0;
        const finish = () => {
          res.destroy();
          req.destroy();
          resolvePromise({ status, frames: parseFrames(raw), raw });
        };
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
          if (status === 200 && options.stopWhen(parseFrames(raw))) {
            finish();
          }
        });
        res.on('end', finish);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolvePromise({ status: 0, frames: [], raw: '__timeout__' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      rejectPromise(err);
    });
    req.end();
  });
}

async function startServer(projectRoot: string): Promise<RunningWebServer> {
  const server = await createWebServer({ projectRoot, port: 0, vite: false });
  await server.listen();
  return server;
}

// ---------------------------------------------------------------------------
// Fake IncomingMessage/ServerResponse for unit-level handler tests
// ---------------------------------------------------------------------------

/** Minimal req/res doubles capturing written SSE frames. */
function makeFakeReqRes(url: string): {
  request: IncomingMessage;
  response: ServerResponse;
  close(): void;
  frames(): SseFrame[];
  statusCode(): number;
} {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.headers = {};
  req.method = 'GET';

  let statusCode = 200;
  let body = '';
  let ended = false;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    get writableEnded() {
      return ended;
    },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      ended = true;
    },
  } as unknown as ServerResponse;

  return {
    request: req,
    response: res,
    close: () => req.emit('close'),
    frames: () => parseFrames(body),
    statusCode: () => statusCode,
  };
}

// ---------------------------------------------------------------------------
// HTTP-level tests
// ---------------------------------------------------------------------------

describe('web SSE endpoint — HTTP auth + replay (S8)', () => {
  it('rejects without a session token (401, no stream opened)', async () => {
    const fixture = await createWebFixtureProject();
    const server = await startServer(fixture.projectRoot);
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    const s = openStore(fixture.projectRoot);
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    s.close();

    const result = await collectSse(
      server.url,
      `/api/sessions/${sessionId}/events`,
      { stopWhen: () => true, timeoutMs: 3_000 },
    );
    expect(result.status).toBe(401);
    expect(result.raw).toContain('UNAUTHORIZED');
  });

  it('returns 404 for an unknown session', async () => {
    const fixture = await createWebFixtureProject();
    const server = await startServer(fixture.projectRoot);
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });

    const result = await collectSse(
      server.url,
      `/api/sessions/does-not-exist/events`,
      { token: fixture.sessionToken, stopWhen: () => true, timeoutMs: 3_000 },
    );
    expect(result.status).toBe(404);
    expect(result.raw).toContain('NOT_FOUND');
  });

  it('replays historical events from sinceSeq and formats frames', async () => {
    const fixture = await createWebFixtureProject();
    const server = await startServer(fixture.projectRoot);
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    const s = openStore(fixture.projectRoot);
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({
      sessionId,
      type: 'turn/start',
      payload: { runId: 'run_x' },
    });
    await s.store.appendEvent({
      sessionId,
      type: 'assistant/message',
      payload: { text: 'hello' },
      modelVisible: true,
    });
    s.close();

    const result = await collectSse(
      server.url,
      `/api/sessions/${sessionId}/events?sinceSeq=0`,
      { token: fixture.sessionToken, stopWhen: (f) => f.length >= 2 },
    );
    expect(result.status).toBe(200);
    expect(result.frames.map((f) => f.event)).toEqual([
      'turn/start',
      'assistant/message',
    ]);
    expect(result.frames.map((f) => f.id)).toEqual(['1', '2']);
    const first = JSON.parse(result.frames[0].data!) as {
      type: string;
      payload: { runId: string };
    };
    expect(first.type).toBe('turn/start');
    expect(first.payload.runId).toBe('run_x');
  });

  it('excludes events at or below sinceSeq and filters internal events (C5)', async () => {
    const fixture = await createWebFixtureProject();
    const server = await startServer(fixture.projectRoot);
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    const s = openStore(fixture.projectRoot);
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} }); // seq 1
    await s.store.appendEvent({
      sessionId,
      type: 'internal/checkpoint',
      payload: { secret: 'should-not-ship' },
      visibility: 'internal',
    }); // seq 2
    await s.store.appendEvent({ sessionId, type: 'turn/end', payload: {} }); // seq 3
    s.close();

    // sinceSeq=1 excludes seq 1; internal seq 2 is filtered; only seq 3 ships.
    const result = await collectSse(
      server.url,
      `/api/sessions/${sessionId}/events?sinceSeq=1`,
      { token: fixture.sessionToken, stopWhen: (f) => f.length >= 1 },
    );
    expect(result.status).toBe(200);
    expect(result.frames.map((f) => f.id)).toEqual(['3']);
    expect(result.frames.map((f) => f.event)).toEqual(['turn/end']);
    expect(result.raw).not.toContain('should-not-ship');
  });

  it('falls back to Last-Event-ID when sinceSeq is absent (reconnect)', async () => {
    const fixture = await createWebFixtureProject();
    const server = await startServer(fixture.projectRoot);
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    const s = openStore(fixture.projectRoot);
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} }); // seq 1
    await s.store.appendEvent({ sessionId, type: 'agent/status', payload: {} }); // seq 2
    await s.store.appendEvent({ sessionId, type: 'turn/end', payload: {} }); // seq 3
    s.close();

    // No sinceSeq query → Last-Event-ID: 2 governs the replay floor (only seq 3).
    const result = await collectSse(
      server.url,
      `/api/sessions/${sessionId}/events`,
      {
        token: fixture.sessionToken,
        extraHeaders: { 'Last-Event-ID': '2' },
        stopWhen: (f) => f.length >= 1,
      },
    );
    expect(result.status).toBe(200);
    expect(result.frames.map((f) => f.id)).toEqual(['3']);
    expect(result.frames.map((f) => f.event)).toEqual(['turn/end']);
  });
});

// ---------------------------------------------------------------------------
// Unit-level tests: live push + M6 boundary (deterministic)
// ---------------------------------------------------------------------------

describe('handleSessionEventsSse — live + M6 boundary (S8)', () => {
  it('pushes live events after replay completes', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} }); // seq 1

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    const done = handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });
    await done; // replay + flush completed; now purely live.

    // A live event appended + published after replay must be written.
    const live = await s.store.appendEvent({
      sessionId,
      type: 'assistant/message',
      payload: { text: 'live' },
    }); // seq 2
    s.bus.publish(live);

    const frames = fake.frames();
    expect(frames.map((f) => f.event)).toEqual([
      'turn/start',
      'assistant/message',
    ]);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    fake.close();
  });

  it('M6: an event published during the replay window is delivered exactly once', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} }); // seq 1

    // Wrap listEventsSince so that, DURING the replay await window (after
    // subscribe is live), a new event is appended AND published. The handler
    // must buffer it (flushing=true) and flush it after replay — not drop it
    // (loss) and not double-send it (the boundary event is > maxReplayedSeq).
    const realPage = s.store.listEventsPage.bind(s.store);
    let injected = false;
    (
      s.store as { listEventsPage: SessionEventStore['listEventsPage'] }
    ).listEventsPage = async (sid: string, since: number, limit: number) => {
      const page = await realPage(sid, since, limit);
      if (!injected) {
        injected = true;
        const boundary = await s.store.appendEvent({
          sessionId,
          type: 'agent/status',
          payload: { at: 'boundary' },
        }); // seq 2, published while flushing=true
        s.bus.publish(boundary);
      }
      return page;
    };

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    const frames = fake.frames();
    // seq 1 (replayed) + seq 2 (buffered during window, flushed once).
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(frames.map((f) => f.event)).toEqual(['turn/start', 'agent/status']);
    // Exactly once: no duplicate seq 2.
    expect(frames.filter((f) => f.id === '2')).toHaveLength(1);
    fake.close();
  });

  it('M6: an event in BOTH the replay result and the live buffer is de-duplicated (seenSeqs)', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} }); // seq 1
    await s.store.appendEvent({ sessionId, type: 'agent/status', payload: {} }); // seq 2

    // Wrap listEventsSince so that AFTER the DB read (both seq 1+2 in the replay
    // result) but before the handler drains, seq 2 is ALSO published to the live
    // buffer. seenSeqs must suppress the buffered copy → seq 2 ships exactly once.
    const realList = s.store.listEventsSince.bind(s.store);
    let injected = false;
    (
      s.store as { listEventsSince: SessionEventStore['listEventsSince'] }
    ).listEventsSince = async (sid: string, since: number) => {
      const events = await realList(sid, since);
      if (!injected) {
        injected = true;
        const dup = events.find((e) => e.seq === 2);
        if (dup) s.bus.publish(dup); // republish an already-replayed event
      }
      return events;
    };

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    const frames = fake.frames();
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(frames.filter((f) => f.id === '2')).toHaveLength(1);
    fake.close();
  });

  it('does not leak the subscription when the client disconnects during replay (B2/R6)', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);
    await s.store.appendEvent({ sessionId, type: 'turn/start', payload: {} });

    // Fire the client 'close' DURING the replay await (before the handler
    // finishes). The close handler is registered before replay, so cleanup runs
    // and unsubscribes — a later publish must not be written.
    const realPage = s.store.listEventsPage.bind(s.store);
    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    (
      s.store as { listEventsPage: SessionEventStore['listEventsPage'] }
    ).listEventsPage = async (sid: string, since: number, limit: number) => {
      const page = await realPage(sid, since, limit);
      fake.close(); // client disconnects mid-replay
      return page;
    };

    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    // A post-disconnect publish must be ignored (unsubscribed, response ended).
    const after = await s.store.appendEvent({
      sessionId,
      type: 'turn/end',
      payload: {},
    });
    s.bus.publish(after);
    expect(fake.frames().map((f) => f.event)).not.toContain('turn/end');
  });

  it('unsubscribes and stops writing after the request closes', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    fake.close(); // request closed → unsubscribe

    const after = await s.store.appendEvent({
      sessionId,
      type: 'turn/end',
      payload: {},
    });
    s.bus.publish(after); // must be ignored (unsubscribed, response ended)

    expect(fake.frames().map((f) => f.event)).not.toContain('turn/end');
  });

  it('N2: a getSession failure propagates before the stream opens (route can 500)', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    // getSession throws (e.g. db locked/closed). The handler must let it
    // propagate WITHOUT switching the response to text/event-stream, so the
    // outer handleSseRoute can still set a 500 status (N2). If the stream had
    // opened first, headers would be committed and a 500 impossible.
    const headers: string[] = [];
    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    (
      fake.response as unknown as { setHeader(k: string, v: string): void }
    ).setHeader = (k: string) => {
      headers.push(k.toLowerCase());
    };
    const throwingStore = {
      ...s.store,
      getSession: async () => {
        throw new Error('db is locked');
      },
    } as unknown as SessionEventStore;

    await expect(
      handleSessionEventsSse({
        request: fake.request,
        response: fake.response,
        sessionId,
        sessions: throwingStore,
        bus: s.bus,
        heartbeatMs: 60_000,
      }),
    ).rejects.toThrow('db is locked');

    // No stream was opened: no event-stream content-type, no frames, and the
    // status was never forced to 200 by the handler itself.
    expect(headers).not.toContain('content-type');
    expect(fake.frames()).toHaveLength(0);
  });

  it('catches up an event committed without a process-local bus publish', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 5,
    });

    // Deliberately do not publish to the local bus: this models a separate CLI
    // process writing to the shared SQLite event store.
    await s.store.appendEvent({
      sessionId,
      type: 'assistant/message',
      payload: { text: 'written by another process' },
      modelVisible: true,
    });

    const deadline = Date.now() + 2_000;
    while (
      !fake.frames().some((frame) => frame.event === 'assistant/message')
    ) {
      if (Date.now() >= deadline) {
        throw new Error('cross-process SSE catch-up did not deliver the event');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.frames().filter((frame) => frame.id === '1')).toHaveLength(1);
    fake.close();
  });
});

describe('SSE fresh connect bounded replay (P1-UX-03)', () => {
  it('fresh connect without sinceSeq / Last-Event-ID initializes cursor from latestSeq - REPLAY_WINDOW', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    for (let i = 1; i <= 6; i++) {
      await s.store.appendEvent({
        sessionId,
        type: 'assistant/message',
        payload: { text: `event ${i}` },
        modelVisible: true,
      });
    }

    // Connect with fresh request (no sinceSeq, no Last-Event-ID)
    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    const frames = fake.frames();
    // All 6 events are within REPLAY_WINDOW (500), so all 6 are delivered
    expect(frames.map((f) => f.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    fake.close();
  });
});

describe("SSE reconnect budget and backpressure (P1-SESSION-01)", () => {
  it("emits replay-truncated and truncates to tail window when reconnect exceeds max event budget", async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    (s.store as any).listEventsPage = async (sid: string, since: number, limit: number) => {
      const events = [];
      const start = since + 1;
      const count = Math.min(limit, 500);
      for (let i = 0; i < count; i++) {
        events.push({
          seq: start + i,
          sessionId: sid,
          type: "assistant/message",
          payload: { text: `bulk message ${start + i}` },
          visibility: "model",
          modelVisible: true,
          timestamp: "2026-08-30T00:00:00.000Z",
          correlationId: null,
        });
      }
      return {
        events,
        hasMore: start + count <= 2500,
        latestSeq: 2500,
      };
    };
    (s.store as any).latestSeq = async () => 2500;

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    const frames = fake.frames();
    const truncatedFrame = frames.find((f) => f.event === "replay-truncated");
    expect(truncatedFrame).toBeDefined();
    expect(JSON.parse(truncatedFrame!.data!).cursor).toBe(2000);
    fake.close();
  });

  it("pauses draining when write returns false and resumes upon drain event", async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    let writeShouldBlock = true;
    const writtenFrames: string[] = [];
    const emitter = new EventEmitter();

    const req = new EventEmitter() as IncomingMessage;
    req.url = `/api/sessions/${sessionId}/events?sinceSeq=0`;
    req.headers = {};
    req.method = "GET";

    let ended = false;
    const res = {
      statusCode: 200,
      get writableEnded() {
        return ended;
      },
      setHeader() {},
      flushHeaders() {},
      write(chunk: string) {
        writtenFrames.push(chunk);
        if (writeShouldBlock) {
          writeShouldBlock = false;
          return false;
        }
        return true;
      },
      once(event: string, cb: () => void) {
        emitter.once(event, cb);
      },
      on(event: string, cb: () => void) {
        emitter.on(event, cb);
      },
      end() {
        ended = true;
      },
    } as unknown as ServerResponse;

    await s.store.appendEvent({ sessionId, type: "turn/start", payload: {} });
    await s.store.appendEvent({ sessionId, type: "assistant/message", payload: {} });

    await handleSessionEventsSse({
      request: req,
      response: res,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    expect(writtenFrames.length).toBe(1);
    expect(writtenFrames[0]).toContain("turn/start");

    emitter.emit("drain");

    expect(writtenFrames.length).toBe(2);
    expect(writtenFrames[1]).toContain("assistant/message");
    req.emit("close");
  });
});
