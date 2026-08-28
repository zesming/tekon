import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
  type SessionEventStore,
} from '@tekon/core';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { createWebServer, type RunningWebServer } from '../../src/server/http.js';

// Phase 3 3a: session read-path RPC (session.list / session.get) + the M1
// token-wiring anti-false-green guard.
//
// The in-process createApiCaller bypasses HTTP auth, so it exercises the
// router logic (list/get shapes, server-side workspace resolution). The HTTP
// path exercises the x-session-token enforcement that the client's rpc-client
// must satisfy in production (M1) — deliberately NOT going through the e2e
// fetch monkeypatch, so a broken token wiring shows up as a real 401 here.

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

function openStore(projectRoot: string): {
  store: SessionEventStore;
  close(): void;
} {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  const writeQueue = createWriteQueue();
  const store = createSessionEventStore(db, writeQueue);
  return { store, close: () => db.close() };
}

/** POST an RPC call over real HTTP, optionally with a session token header. */
async function postRpc(
  server: RunningWebServer,
  path: string,
  input: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const u = new URL(server.url);
  const payload = JSON.stringify({ path, input });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    // Same-origin so assertRequestAllowed passes; auth is the token check.
    Origin: server.url,
  };
  if (token !== undefined) headers['x-session-token'] = token;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        method: 'POST',
        path: '/api/rpc',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('web session read API', () => {
  it('session.list resolves the default workspace server-side and lists sessions newest-first', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Seed two sessions directly in the store (fixture seeds runs, not sessions).
    const { store, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const first = await store.createSession({
      workspaceId: workspace.id,
      title: 'older',
      profile: 'human-web',
      runId: 'run_0',
    });
    const second = await store.createSession({
      workspaceId: workspace.id,
      title: 'newer',
      profile: 'human-web',
      runId: 'run_1',
    });

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.session.list();

    // Client has no workspaceId; the server resolves + returns it (M2).
    expect(result.workspaceId).toBe(workspace.id);
    expect(result.sessions.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(result.sessions[0]).toMatchObject({
      id: second.id,
      title: 'newer',
      status: 'active',
      runId: 'run_1',
    });
  });

  it('session.get returns metadata plus the composed runId', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await store.createSession({
      workspaceId: workspace.id,
      title: 'detail',
      profile: 'human-web',
      runId: 'run_1',
    });

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.session.get({ sessionId: session.id });
    expect(result.session).toMatchObject({
      id: session.id,
      title: 'detail',
      status: 'active',
      runId: 'run_1',
    });
  });

  it('session.get throws NOT_FOUND for an unknown session', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    await expect(
      api.session.get({ sessionId: 'sess_missing' }),
    ).rejects.toThrow(/not found/i);
  });

  // M1 anti-false-green: session.list is auth:'session'. Over real HTTP it must
  // 401 without the token and 200 with it. This test does NOT use the e2e fetch
  // monkeypatch, so if the client's token wiring regresses, production would
  // 401 and this test catches it (the e2e suite would not).
  it('enforces the session token over HTTP (401 without, 200 with)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
    });
    await server.listen();
    cleanupTasks.push(() => server.close());

    const missing = await postRpc(server, 'session.list', undefined);
    expect(missing.status).toBe(401);

    const wrong = await postRpc(server, 'session.list', undefined, 'nope');
    expect(wrong.status).toBe(401);

    const ok = await postRpc(
      server,
      'session.list',
      undefined,
      'fixture-session-token',
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { result: { sessions: unknown[] } }).result).toMatchObject(
      {
        sessions: expect.any(Array),
      },
    );
  });
});
