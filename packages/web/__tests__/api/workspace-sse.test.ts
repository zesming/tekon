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
import { handleWorkspaceSummarySse } from '../../src/server/sse.js';

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
});
