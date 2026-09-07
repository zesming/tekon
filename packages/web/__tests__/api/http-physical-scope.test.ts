import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openTekonDatabase } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer } from '../../src/server/http.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function setup(options: { historicalAliases?: boolean; foreignRows?: boolean; canonicalEntry?: boolean } = {}) {
  const fixture = await createWebFixtureProject();
  cleanup.push(fixture.cleanup);
  const aliasDir = mkdtempSync(join(tmpdir(), 'tekon-http-scope-'));
  cleanup.push(() => rmSync(aliasDir, { recursive: true, force: true }));
  const alias = join(aliasDir, 'repo-alias');
  const secondAlias = join(aliasDir, 'second-alias');
  symlinkSync(fixture.projectRoot, alias);
  symlinkSync(fixture.projectRoot, secondAlias);
  const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
  cleanup.push(() => { db.close(); });
  const timestamp = '2026-09-01T00:00:00.000Z';
  const addWorkspaceSession = (id: string, root: string, runId: string) => {
    db.prepare('insert into workspaces (id, root, created_at) values (?, ?, ?)').run(`ws_${id}`, root, timestamp);
    db.prepare(`insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
      values (?, ?, ?, 'human-web', 'failed', ?, ?, ?)`).run(`session_${id}`, `ws_${id}`, id, runId, timestamp, timestamp);
    db.prepare(`insert into session_events (session_id, seq, type, version, timestamp, payload)
      values (?, 1, 'user/message', 1, ?, ?)`).run(`session_${id}`, timestamp, JSON.stringify({ text: `${id} first message` }));
  };
  if (options.historicalAliases) {
    db.prepare('update projects set repo_path = ?').run(alias);
    addWorkspaceSession('legacy_one', alias, 'run_0');
    addWorkspaceSession('legacy_two', secondAlias, 'run_1');
  }
  if (options.foreignRows) {
    const outside = join(aliasDir, 'different-physical-repo');
    mkdirSync(outside);
    db.prepare('insert into projects (id, name, repo_path, created_at) values (?, ?, ?, ?)')
      .run('project_foreign', 'Foreign project', outside, timestamp);
    db.prepare(`insert into workflow_instances (id, project_id, demand_id, status, created_at, updated_at)
      values ('run_foreign', 'project_foreign', 'demand_0', 'failed', ?, ?)`).run(timestamp, timestamp);
    addWorkspaceSession('foreign', outside, 'run_foreign');
    db.prepare(`insert into run_admissions (request_id, envelope_version, envelope_hash, run_id, data_dir, files_state, created_at, updated_at)
      values ('foreign-request-01', 1, 'foreign-intent', 'run_foreign', '.tekon', 'ready', ?, ?)`).run(timestamp, timestamp);
  }
  const server = await createWebServer({ projectRoot: options.canonicalEntry ? fixture.projectRoot : alias, port: 0, vite: false });
  cleanup.push(() => server.close());
  await server.listen();
  async function rpc(path: string, input?: unknown) {
    const response = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-session-token': fixture.sessionToken },
      body: JSON.stringify({ path, input }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function sse(path: string) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5_000);
    const close = () => { clearTimeout(deadline); controller.abort(); };
    cleanup.push(close);
    const response = await fetch(`${server.url}${path}`, {
      headers: { 'sec-fetch-site': 'same-origin', 'x-session-token': fixture.sessionToken },
      signal: controller.signal,
    });
    return { response, close, async readUntil(marker: string) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`SSE ended before ${marker}`);
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text;
      } finally { reader.releaseLock(); }
    } };
  }
  return { fixture, alias, secondAlias, db, rpc, sse };
}

describe('真实 HTTP 的仓库物理作用域', () => {
  it('从symlink根启动的新Run在项目、受理、审阅和Session入口均可见', async () => {
    const { fixture, db, rpc } = await setup();
    const requestId = 'physical-root-run-01';
    const accepted = await rpc('project.run', {
      token: fixture.sessionToken, requestId, mode: 'goal', agent: 'mock', allowDirtyBase: true,
      demandText: '通过仓库别名启动并观察同一运行',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const { run, sessionId } = accepted.body.result;
    expect(db.prepare('select repo_path from projects where id = ?').get(run.projectId))
      .toEqual({ repo_path: realpathSync(fixture.projectRoot) });
    expect(db.prepare('select w.root from workspaces w join sessions s on s.workspace_id = w.id where s.id = ?').get(sessionId))
      .toEqual({ root: realpathSync(fixture.projectRoot) });

    const projects = await rpc('project.list');
    expect(projects.status).toBe(200);
    expect(projects.body.result.map((project: { id: string }) => project.id)).toContain(run.projectId);
    const detail = await rpc('project.detail', { projectId: run.projectId });
    expect(detail.status).toBe(200);
    expect(detail.body.result.runs.map((item: { id: string }) => item.id)).toContain(run.id);
    const admission = await rpc('project.admission', { token: fixture.sessionToken, requestId });
    expect(admission.status).toBe(200);
    expect(admission.body.result).toMatchObject({ requestId, runId: run.id, sessionId });
    const review = await rpc('review.get', { runId: run.id });
    expect(review.status).toBe(200);
    expect(review.body.result.runId).toBe(run.id);
    const sessions = await rpc('session.list');
    expect(sessions.status).toBe(200);
    expect(sessions.body.result.sessions.map((item: { id: string }) => item.id)).toContain(sessionId);
    const session = await rpc('session.get', { sessionId });
    expect(session.status).toBe(200);
    expect(session.body.result.session).toMatchObject({ id: sessionId, runId: run.id, admissionState: 'accepted' });
  });

  it('聚合历史alias Workspace并保留旧Session身份，读列表不新造Workspace', async () => {
    const { fixture, alias, secondAlias, db, rpc } = await setup({ historicalAliases: true });
    const initialWorkspaces = db.prepare('select id, root from workspaces order by id').all();
    const sessions = await rpc('session.list');
    expect(sessions.status).toBe(200);
    expect(sessions.body.result.sessions.map((session: { id: string }) => session.id).sort())
      .toEqual(['session_legacy_one', 'session_legacy_two']);
    expect(db.prepare('select id, root from workspaces order by id').all()).toEqual(initialWorkspaces);
    const projects = await rpc('project.list');
    expect(projects.status).toBe(200);
    expect(projects.body.result.map((project: { id: string }) => project.id)).toEqual(['project_0', 'project_1']);
    for (const [sessionId, runId, projectId] of [['session_legacy_one', 'run_0', 'project_0'], ['session_legacy_two', 'run_1', 'project_1']]) {
      expect((await rpc('session.get', { sessionId })).body.result.session).toMatchObject({ id: sessionId, runId });
      expect((await rpc('project.detail', { projectId })).status).toBe(200);
      expect((await rpc('review.get', { runId })).status).toBe(200);
    }
    const accepted = await rpc('project.run', { token: fixture.sessionToken, requestId: 'legacy-alias-new-run-01',
      mode: 'goal', agent: 'mock', allowDirtyBase: true, demandText: '旧别名历史与新运行同时可见' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const after = await rpc('session.list');
    expect(after.body.result.sessions.map((session: { id: string }) => session.id))
      .toEqual(expect.arrayContaining(['session_legacy_one', 'session_legacy_two', accepted.body.result.sessionId]));
    expect(db.prepare("select id, root from workspaces where id like 'ws_legacy_%' order by id").all())
      .toEqual([{ id: 'ws_legacy_one', root: alias }, { id: 'ws_legacy_two', root: secondAlias }]);
  });

  it('不同物理仓库的Project、Run、Admission与Session均不可访问', async () => {
    const { fixture, rpc } = await setup({ foreignRows: true });
    const projects = await rpc('project.list');
    expect(projects.status).toBe(200);
    expect(projects.body.result.map((project: { id: string }) => project.id)).not.toContain('project_foreign');
    const sessions = await rpc('session.list');
    expect(sessions.status).toBe(200);
    expect(sessions.body.result.sessions.map((session: { id: string }) => session.id)).not.toContain('session_foreign');
    for (const [path, input] of [
      ['project.detail', { projectId: 'project_foreign' }],
      ['review.get', { runId: 'run_foreign' }],
      ['project.admission', { token: fixture.sessionToken, requestId: 'foreign-request-01' }],
      ['session.get', { sessionId: 'session_foreign' }],
      ['session.events', { sessionId: 'session_foreign' }],
      ['session.acknowledge', { sessionId: 'session_foreign' }],
    ] as const) {
      const response = await rpc(path, input);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe('NOT_FOUND');
    }
  });

  it.each(['/api/sessions/session_foreign/events', '/api/workspaces/ws_foreign/summary/events'])(
    '不同物理仓库的SSE在打开流前拒绝：%s', async (path) => {
      const { sse } = await setup({ foreignRows: true });
      const stream = await sse(path);
      try {
        expect(stream.response.status).toBe(404);
        expect(stream.response.headers.get('content-type')).toContain('application/json');
        expect(await stream.response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      } finally { stream.close(); }
    },
  );

  it('canonical入口仍能读取旧alias Session的原始seq并观察同物理Workspace的更新', async () => {
    const { db, sse } = await setup({ historicalAliases: true, canonicalEntry: true });
    const sessionStream = await sse('/api/sessions/session_legacy_two/events?sinceSeq=0');
    expect(sessionStream.response.status).toBe(200);
    db.prepare(`insert into session_events (session_id, seq, type, version, timestamp, payload)
      values ('session_legacy_two', 2, 'user/message', 1, ?, ?)`).run('2026-09-01T00:00:01.000Z', JSON.stringify({ text: 'second-message-sentinel' }));
    const history = await sessionStream.readUntil('second-message-sentinel');
    expect(history).toContain('id: 1');
    expect(history).toContain('id: 2');
    sessionStream.close();

    const summary = await sse('/api/workspaces/ws_legacy_one/summary/events');
    expect(summary.response.status).toBe(200);
    db.prepare("update sessions set updated_at = ? where id = 'session_legacy_two'").run('2026-09-02T00:00:00.000Z');
    const update = await summary.readUntil('event: workspace/summary');
    expect(update).toContain('"workspaceId":"ws_legacy_one"');
    summary.close();
  }, 10_000);
});
