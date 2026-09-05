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
import {
  handleWorkspaceSummarySse,
  MAX_PENDING_WORKSPACE_EVENTS,
} from '../../src/server/sse.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

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

describe('workspace summary SSE endpoint (T5 / P1-UX-01)', () => {
  it('rejects without a session token (401)', async () => {
    const fixture = await createWebFixtureProject();
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
    });
    await server.listen();
    cleanupTasks.push(async () => {
      await server.close();
      fixture.cleanup();
    });

    const result = await collectSse(
      server.url,
      `/api/workspaces/ws_default/summary/events`,
      { stopWhen: () => true, timeoutMs: 3_000 },
    );
    expect(result.status).toBe(401);
    expect(result.raw).toContain('UNAUTHORIZED');
  });

  it('broadcasts live summary event on local bus activity', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-test',
      profile: 'human-web',
      runId: null,
    });

    const fake = makeFakeReqRes(`/api/workspaces/${workspace.id}/summary/events`);
    const done = handleWorkspaceSummarySse({
      request: fake.request,
      response: fake.response,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });
    await done;

    // Publish event on bus
    const event = await s.store.appendEvent({
      sessionId: session.id,
      type: 'turn/start',
      payload: {},
    });
    s.bus.publish(event);

    const frames = fake.frames();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0].event).toBe('workspace/summary');
    const data = JSON.parse(frames[0].data!) as {
      workspaceId: string;
      sessionId: string;
      type: string;
    };
    expect(data.workspaceId).toBe(workspace.id);
    expect(data.sessionId).toBe(session.id);
    expect(data.type).toBe('turn/start');
    fake.close();
  });

  it('does not forward process-local events from another workspace', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const foreignWorkspace = await s.store.getOrCreateDefaultWorkspace(
      `${fixture.projectRoot}-foreign`,
    );
    const localSession = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'local session',
      profile: 'human-web',
      runId: null,
    });
    const foreignSession = await s.store.createSession({
      workspaceId: foreignWorkspace.id,
      title: 'foreign session',
      profile: 'human-web',
      runId: null,
    });

    const fake = makeFakeReqRes(`/api/workspaces/${workspace.id}/summary/events`);
    await handleWorkspaceSummarySse({
      request: fake.request,
      response: fake.response,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    const foreignEvent = await s.store.appendEvent({
      sessionId: foreignSession.id,
      type: 'turn/start',
      payload: {},
    });
    s.bus.publish(foreignEvent);
    expect(fake.frames()).toHaveLength(0);

    const localEvent = await s.store.appendEvent({
      sessionId: localSession.id,
      type: 'turn/start',
      payload: {},
    });
    s.bus.publish(localEvent);
    expect(fake.frames()).toHaveLength(1);
    const data = JSON.parse(fake.frames()[0].data!) as {
      workspaceId: string;
      sessionId: string;
    };
    expect(data).toMatchObject({
      workspaceId: workspace.id,
      sessionId: localSession.id,
    });
    fake.close();
  });

  it('catches up session activity when appended without process-local bus publish', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-catchup-test',
      profile: 'human-web',
      runId: null,
    });

    const fake = makeFakeReqRes(`/api/workspaces/${workspace.id}/summary/events`);
    await handleWorkspaceSummarySse({
      request: fake.request,
      response: fake.response,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 10,
    });

    // Wait 10ms to ensure distinct timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Append event without local bus publish (simulating external process)
    await s.store.appendEvent({
      sessionId: session.id,
      type: 'assistant/message',
      payload: { text: 'external process write' },
      modelVisible: true,
    });

    const deadline = Date.now() + 2_000;
    while (!fake.frames().some((frame) => frame.event === 'workspace/summary')) {
      if (Date.now() >= deadline) {
        throw new Error('cross-process workspace summary catch-up did not deliver event');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const frames = fake.frames();
    expect(frames.some((f) => f.event === 'workspace/summary')).toBe(true);
    fake.close();
  });

  it('unsubscribes and stops broadcasting after request close', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-close-test',
      profile: 'human-web',
      runId: null,
    });

    const fake = makeFakeReqRes(`/api/workspaces/${workspace.id}/summary/events`);
    await handleWorkspaceSummarySse({
      request: fake.request,
      response: fake.response,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
    });

    fake.close();

    const event = await s.store.appendEvent({
      sessionId: session.id,
      type: 'turn/end',
      payload: {},
    });
    s.bus.publish(event);

    expect(fake.frames().length).toBe(0);
  });

  // Tenth-review annotation 16.2: a stalled client must not grow server memory
  // without limit. While the socket is backpressured, summary frames buffer in
  // a bounded pending queue; on overflow the server closes the connection so
  // the client reconnects and the catch-up poll restores the latest snapshot.
  it('closes the connection when the backpressure pending buffer exceeds the event cap', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-backpressure-test',
      profile: 'human-web',
      runId: null,
    });

    const writtenFrames: string[] = [];
    const emitter = new EventEmitter();
    let drainListeners = 0;
    const req = new EventEmitter() as IncomingMessage;
    req.url = `/api/workspaces/${workspace.id}/summary/events`;
    req.headers = {};
    req.method = 'GET';

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
        return false; // permanently backpressured
      },
      once(event: string, cb: () => void) {
        if (event === 'drain') drainListeners += 1;
        emitter.once(event, cb);
      },
      on(event: string, cb: () => void) {
        emitter.on(event, cb);
      },
      end() {
        ended = true;
      },
    } as unknown as ServerResponse;

    const done = handleWorkspaceSummarySse({
      request: req,
      response: res,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 60_000,
    });
    await done;

    // Publish more live events than the cap while the socket stays backpressured.
    for (let i = 0; i < MAX_PENDING_WORKSPACE_EVENTS + 10; i++) {
      const event = await s.store.appendEvent({
        sessionId: session.id,
        type: 'turn/start',
        payload: { idx: i },
      });
      s.bus.publish(event);
    }

    expect(ended).toBe(true); // connection closed so the client reconnects

    req.emit('close');
    await done;
  });

  it('closes the connection when the backpressure pending buffer exceeds the byte cap', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-backpressure-bytes-test',
      profile: 'human-web',
      runId: null,
    });

    const writtenFrames: string[] = [];
    const req = new EventEmitter() as IncomingMessage;
    req.url = `/api/workspaces/${workspace.id}/summary/events`;
    req.headers = {};
    req.method = 'GET';

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
        return false; // permanently backpressured
      },
      once(event: string, cb: () => void) {
        req.once(event, cb);
      },
      on(event: string, cb: () => void) {
        req.on(event, cb);
      },
      end() {
        ended = true;
      },
    } as unknown as ServerResponse;

    // Inject a byte cap smaller than two frames so the byte dimension trips
    // well before the event-count cap (each frame is ~180 bytes).
    const done = handleWorkspaceSummarySse({
      request: req,
      response: res,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 60_000,
      maxPendingEvents: 10_000,
      maxPendingBytes: 256,
    });
    await done;

    for (let i = 0; i < 10; i++) {
      const event = await s.store.appendEvent({
        sessionId: session.id,
        type: 'turn/start',
        payload: { idx: i },
      });
      s.bus.publish(event);
    }

    expect(ended).toBe(true);
    // At most one frame can buffer under a 256-byte cap (~180 bytes per frame),
    // proving the byte dimension — not the event count — closed the stream.
    expect(writtenFrames.length).toBeLessThanOrEqual(2);

    req.emit('close');
    await done;
  });

  it('flushes buffered frames on drain and leaves no drain listener after close', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const workspace = await s.store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await s.store.createSession({
      workspaceId: workspace.id,
      title: 'ws-sse-drain-test',
      profile: 'human-web',
      runId: null,
    });

    const writtenFrames: string[] = [];
    const emitter = new EventEmitter();
    let backpressured = true;
    const req = new EventEmitter() as IncomingMessage;
    req.url = `/api/workspaces/${workspace.id}/summary/events`;
    req.headers = {};
    req.method = 'GET';

    const res = {
      statusCode: 200,
      get writableEnded() {
        return false;
      },
      setHeader() {},
      flushHeaders() {},
      write(chunk: string) {
        writtenFrames.push(chunk);
        return !backpressured;
      },
      once(event: string, cb: () => void) {
        emitter.once(event, cb);
      },
      on(event: string, cb: () => void) {
        emitter.on(event, cb);
      },
      removeAllListeners(event?: string) {
        emitter.removeAllListeners(event);
      },
      end() {},
    } as unknown as ServerResponse;

    const done = handleWorkspaceSummarySse({
      request: req,
      response: res,
      workspaceId: workspace.id,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 60_000,
    });
    await done;

    const first = await s.store.appendEvent({
      sessionId: session.id,
      type: 'turn/start',
      payload: {},
    });
    s.bus.publish(first);
    expect(writtenFrames.length).toBe(1); // first frame written, socket backed up

    const second = await s.store.appendEvent({
      sessionId: session.id,
      type: 'turn/end',
      payload: {},
    });
    s.bus.publish(second);
    expect(writtenFrames.length).toBe(1); // buffered, not written

    backpressured = false;
    emitter.emit('drain');
    expect(writtenFrames.length).toBe(2); // buffered frame flushed
    expect(writtenFrames[1]).toContain('turn/end');

    // While backpressured again, a drain listener stays mounted; closing the
    // request must remove it so no listener leaks past the stream lifetime.
    backpressured = true;
    const third = await s.store.appendEvent({
      sessionId: session.id,
      type: 'turn/start',
      payload: {},
    });
    s.bus.publish(third);
    expect(emitter.listenerCount('drain')).toBe(1);

    req.emit('close');
    await done;
    expect(emitter.listenerCount('drain')).toBe(0); // cleanup removed it
  });
});
