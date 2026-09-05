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
import { createScopedFixtureRun } from '../fixtures/session-run.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { createWebServer, type RunningWebServer } from '../../src/server/http.js';

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

describe('session.acknowledge & attention sorting (T3 / P1-UX-02)', () => {
  it('keeps list and get consistent before and after handling a failed session', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);

    const failed = await store.createSession({
      workspaceId: workspace.id,
      title: 'failed session',
      profile: 'human-web',
      runId: createScopedFixtureRun(db, 'run_failed'),
    });
    await store.updateSessionStatus(failed.id, 'failed');

    const active = await store.createSession({
      workspaceId: workspace.id,
      title: 'active session',
      profile: 'human-web',
      runId: createScopedFixtureRun(db, 'run_active'),
    });

    setSessionTime(db, failed.id, '2026-08-28T09:00:00.000Z');
    setSessionTime(db, active.id, '2026-08-28T10:00:00.000Z');

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const listBefore = await api.session.list();
    const failedBefore = listBefore.sessions.find((s) => s.id === failed.id);
    expect(failedBefore).toMatchObject({
      acknowledgedAt: null,
      needsAction: true,
      actionKind: 'failed',
    });
    expect(listBefore.sessions[0].id).toBe(failed.id);

    const getBefore = await api.session.get({ sessionId: failed.id });
    expect(getBefore.session).toMatchObject({
      acknowledgedAt: null,
      needsAction: true,
      actionKind: 'failed',
    });

    const ackResult = await api.session.acknowledge({ sessionId: failed.id });
    expect(typeof ackResult.acknowledgedAt).toBe('string');

    const listAfter = await api.session.list();
    const failedAfter = listAfter.sessions.find((s) => s.id === failed.id);
    expect(failedAfter).toMatchObject({
      acknowledgedAt: ackResult.acknowledgedAt,
      needsAction: false,
      actionKind: null,
    });
    expect(listAfter.sessions[0].id).toBe(active.id);

    const getAfter = await api.session.get({ sessionId: failed.id });
    expect(getAfter.session).toMatchObject({
      acknowledgedAt: ackResult.acknowledgedAt,
      needsAction: false,
      actionKind: null,
    });
  });

  it('reopens action when a previously handled session enters a later failure generation', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await store.createSession({
      workspaceId: workspace.id,
      title: 'retrying session',
      profile: 'human-web',
      runId: createScopedFixtureRun(db, 'run_retry'),
    });
    await store.updateSessionStatus(session.id, 'failed');

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());
    await api.session.acknowledge({ sessionId: session.id });

    await store.updateSessionStatus(session.id, 'active');
    await store.updateSessionStatus(session.id, 'failed');
    db.prepare('update sessions set updated_at = ? where id = ?').run(
      '2030-01-01T00:00:00.000Z',
      session.id,
    );

    const list = await api.session.list();
    const entry = list.sessions.find((item) => item.id === session.id);
    expect(entry).toMatchObject({
      acknowledgedAt: null,
      needsAction: true,
      actionKind: 'failed',
    });
  });

  it('rejects pre-acknowledgement of a session that is not currently failed', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const active = await store.createSession({
      workspaceId: workspace.id,
      title: 'active session',
      profile: 'human-web',
      runId: createScopedFixtureRun(db, 'run_active'),
    });

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.session.acknowledge({ sessionId: active.id }),
    ).rejects.toThrow(/currently failed/i);
  });

  it('legacy NULL acknowledged_at is treated as unacknowledged and stays pinned', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, db, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);

    const legacyFailed = await store.createSession({
      workspaceId: workspace.id,
      title: 'legacy failed session',
      profile: 'human-web',
      runId: createScopedFixtureRun(db, 'run_legacy'),
    });
    await store.updateSessionStatus(legacyFailed.id, 'failed');
    db.prepare('update sessions set acknowledged_at = null where id = ?').run(
      legacyFailed.id,
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const list = await api.session.list();
    const entry = list.sessions.find((s) => s.id === legacyFailed.id);
    expect(entry).toMatchObject({
      acknowledgedAt: null,
      needsAction: true,
      actionKind: 'failed',
    });
  });

  it('session.acknowledge throws NOT_FOUND for non-existent session', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.session.acknowledge({ sessionId: 'sess_non_existent' }),
    ).rejects.toThrow(/not found/i);
  });

  it('session.acknowledge enforces session token over HTTP', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const { store, close } = openStore(fixture.projectRoot);
    cleanupTasks.push(close);
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await store.createSession({
      workspaceId: workspace.id,
      title: 'http ack test',
      profile: 'human-web',
      runId: null,
    });
    await store.updateSessionStatus(session.id, 'failed');

    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
    });
    await server.listen();
    cleanupTasks.push(() => server.close());

    const unauth = await postRpc(server, 'session.acknowledge', {
      sessionId: session.id,
    });
    expect(unauth.status).toBe(401);

    const auth = await postRpc(
      server,
      'session.acknowledge',
      { sessionId: session.id },
      'fixture-session-token',
    );
    expect(auth.status).toBe(200);
    const body = auth.body as { result: { acknowledgedAt: string } };
    expect(body.result.acknowledgedAt).toBeDefined();
  });
});
