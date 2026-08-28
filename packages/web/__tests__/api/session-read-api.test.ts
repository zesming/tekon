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
  db: ReturnType<typeof openTekonDatabase>;
  close(): void;
} {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  const writeQueue = createWriteQueue();
  const store = createSessionEventStore(db, writeQueue);
  return { store, db, close: () => db.close() };
}

function setSessionTime(
  db: ReturnType<typeof openTekonDatabase>,
  sessionId: string,
  timestamp: string,
): void {
  db.prepare(
    'update sessions set created_at = ?, updated_at = ? where id = ?',
  ).run(timestamp, timestamp, sessionId);
}

function setSessionUpdatedAt(
  db: ReturnType<typeof openTekonDatabase>,
  sessionId: string,
  timestamp: string,
): void {
  db.prepare('update sessions set updated_at = ? where id = ?').run(
    timestamp,
    sessionId,
  );
}

function setLatestEventTime(
  db: ReturnType<typeof openTekonDatabase>,
  sessionId: string,
  timestamp: string,
): void {
  db.prepare(
    `update session_events
     set timestamp = ?
     where session_id = ?
       and seq = (select max(seq) from session_events where session_id = ?)`,
  ).run(timestamp, sessionId, sessionId);
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
  it('prioritizes sessions needing action, then orders each attention group by latest activity', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Seed sessions directly in the store (fixture seeds runs, not sessions).
    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const approval = await store.createSession({
      workspaceId: workspace.id,
      title: 'approval session',
      profile: 'human-web',
      runId: 'run_1',
    });
    await store.updateSessionStatus(approval.id, 'awaiting-approval');

    const failed = await store.createSession({
      workspaceId: workspace.id,
      title: 'failed session',
      profile: 'human-web',
      runId: 'run_2',
    });
    await store.updateSessionStatus(failed.id, 'failed');

    const active = await store.createSession({
      workspaceId: workspace.id,
      title: 'active session',
      profile: 'human-web',
      runId: 'run_3',
    });

    const input = await store.createSession({
      workspaceId: workspace.id,
      title: 'input session',
      profile: 'human-web',
      runId: 'run_4',
    });
    await store.updateSessionStatus(input.id, 'awaiting-input');

    // Fixed timestamps keep the test deterministic and prove two independent
    // semantics: action sessions outrank a newer active session, while
    // updated_at outranks an older best-effort event projection.
    setSessionTime(db, approval.id, '2026-08-28T08:00:00.000Z');
    setSessionUpdatedAt(db, approval.id, '2026-08-28T10:00:00.000Z');
    setSessionTime(db, failed.id, '2026-08-28T09:00:00.000Z');
    setSessionTime(db, input.id, '2026-08-28T09:30:00.000Z');
    setSessionTime(db, active.id, '2026-08-28T11:00:00.000Z');

    await store.appendEvent({
      sessionId: approval.id,
      type: 'approval/requested',
      payload: { text: 'needs human decision' },
    });
    setLatestEventTime(db, approval.id, '2026-08-28T08:30:00.000Z');

    await store.appendEvent({
      sessionId: active.id,
      type: 'workflow/node-started',
      payload: { nodeId: 'rd' },
    });
    setLatestEventTime(db, active.id, '2026-08-28T12:00:00.000Z');

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.session.list();

    // Client has no workspaceId; the server resolves + returns it (M2).
    expect(result.workspaceId).toBe(workspace.id);
    expect(result.sessions.map((session) => session.id)).toEqual([
      approval.id,
      input.id,
      failed.id,
      active.id,
    ]);

    expect(result.sessions[0]).toMatchObject({
      id: approval.id,
      title: 'approval session',
      status: 'awaiting-approval',
      runId: 'run_1',
      // Status-only updated_at is newer than the deliberately old event.
      lastActivityAt: '2026-08-28T10:00:00.000Z',
      needsAction: true,
      actionKind: 'approval',
    });

    const byId = new Map(result.sessions.map((session) => [session.id, session]));
    expect(byId.get(failed.id)).toMatchObject({
      status: 'failed',
      needsAction: true,
      actionKind: 'failed',
    });
    expect(byId.get(input.id)).toMatchObject({
      status: 'awaiting-input',
      needsAction: true,
      actionKind: 'input',
    });
    expect(byId.get(active.id)).toMatchObject({
      status: 'active',
      lastActivityAt: '2026-08-28T12:00:00.000Z',
      needsAction: false,
      actionKind: null,
    });
  });

  it('session.get uses the same latest-activity meaning as session.list', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await store.createSession({
      workspaceId: workspace.id,
      title: 'detail',
      profile: 'human-web',
      runId: 'run_1',
    });
    await store.updateSessionStatus(session.id, 'awaiting-approval');
    setSessionTime(db, session.id, '2026-08-28T09:00:00.000Z');
    setSessionUpdatedAt(db, session.id, '2026-08-28T10:00:00.000Z');
    await store.appendEvent({
      sessionId: session.id,
      type: 'approval/requested',
    });
    setLatestEventTime(db, session.id, '2026-08-28T11:00:00.000Z');

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.session.get({ sessionId: session.id });
    expect(result.session).toMatchObject({
      id: session.id,
      title: 'detail',
      status: 'awaiting-approval',
      runId: 'run_1',
      lastActivityAt: '2026-08-28T11:00:00.000Z',
      needsAction: true,
      actionKind: 'approval',
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
