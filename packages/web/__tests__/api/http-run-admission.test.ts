import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openTekonDatabase } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer } from '../../src/server/http.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function setup() {
  const fixture = await createWebFixtureProject();
  cleanup.push(fixture.cleanup);
  const server = await createWebServer({
    projectRoot: fixture.projectRoot,
    port: 0,
    vite: false,
  });
  cleanup.push(() => server.close());
  await server.listen();
  const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
  cleanup.push(() => { db.close(); });
  async function rpc(path: string, input: unknown, token?: string) {
    const response = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        ...(token ? { 'x-session-token': token } : {}),
      },
      body: JSON.stringify({ path, input }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { fixture, db, rpc };
}

describe('真实 HTTP 的计划保密与幂等受理', () => {
  it('提交后数据库状态更新故障仍返回恢复身份且不泄露底层错误', async () => {
    const { fixture, db, rpc } = await setup();
    db.exec("create trigger fail_admission_state before update on run_admissions begin select raise(abort, 'PRIVATE_DB_SENTINEL'); end");
    const input = { token: fixture.sessionToken, mode: 'goal', agent: 'mock', allowDirtyBase: true, demandText: '提交后故障' };
    const failed = await rpc('project.run', input);
    expect(failed.status).toBe(500);
    const row = db.prepare('select request_id, run_id, session_id, job_id from run_admissions order by created_at desc limit 1').get() as Record<string, string>;
    expect(row).toBeTruthy();
    for (const value of Object.values(row)) expect(failed.body.error.message).toContain(value);
    expect(failed.body.error.message).toContain('recovery-required');
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE_DB_SENTINEL');
    db.exec('drop trigger fail_admission_state');
    const recovered = await rpc('project.run', { ...input, requestId: row.request_id });
    expect(recovered.status).toBe(200);
    expect(recovered.body.result.run.id).toBe(row.run_id);
    expect(recovered.body.result.replayed).toBe(true);
  });

  it('模板文件名与内部 id 不同仍保持同一确认摘要', async () => {
    const { fixture, db, rpc } = await setup();
    const path = join(fixture.projectRoot, '.tekon', 'workflows', 'project-feature.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('id: project-feature', 'id: inner-workflow'));
    const input = { template: 'project-feature', agent: 'mock', allowDirtyBase: true };
    const preview = await rpc('workflow.plan', input);
    expect(preview.status).toBe(200);
    const accepted = await rpc('project.run', { ...input, token: fixture.sessionToken,
      demandText: '别名仍绑定内部完整模板', planDigest: preview.body.result.digest, requestId: 'http-alias-01' });
    expect(accepted.status).toBe(200);
    const persisted = db.prepare('select plan_snapshot, plan_digest from workflow_instances where id=?').get(accepted.body.result.run.id) as
      { plan_snapshot: string; plan_digest: string };
    expect(persisted.plan_digest).toBe(preview.body.result.digest);
    expect(JSON.parse(persisted.plan_snapshot)).toMatchObject({ templateId: 'project-feature', template: { id: 'inner-workflow' } });
  });

  it('公开/已认证预览不含内联命令秘密，但其变化会改变确认摘要', async () => {
    const { fixture, rpc } = await setup();
    const templatePath = join(fixture.projectRoot, '.tekon', 'workflows', 'project-feature.yaml');
    const source = readFileSync(templatePath, 'utf8');
    const sentinel = 'PRIVATE_PLAN_SENTINEL_A';
    const withSecret = source.replace(
      '            commandRef: build',
      `            command:\n              tool: node\n              args: [${sentinel}]\n              env:\n                digest: ${sentinel}`,
    );
    expect(withSecret).not.toBe(source);
    writeFileSync(templatePath, withSecret);
    const input = { template: 'project-feature', agent: 'mock', allowDirtyBase: true };
    const anonymous = await rpc('workflow.plan', input);
    const authenticated = await rpc('workflow.plan', input, fixture.sessionToken);
    for (const response of [anonymous, authenticated]) {
      expect(response.status).toBe(200);
      expect(response.body.result.digestVersion).toBe(3);
      expect(response.body.result.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.result).not.toHaveProperty('template');
      expect(JSON.stringify(response.body)).not.toContain(sentinel);
    }
    writeFileSync(templatePath, withSecret.replaceAll(sentinel, 'PRIVATE_PLAN_SENTINEL_B'));
    const changed = await rpc('workflow.plan', input);
    expect(changed.status).toBe(200);
    expect(changed.body.result.digest).not.toBe(anonymous.body.result.digest);
  });

  it('旧模板摘要拒绝且零受理，刷新后接受；同 requestId 重放不重读模板', async () => {
    const { fixture, db, rpc } = await setup();
    const intent = {
      token: fixture.sessionToken,
      demandText: '验证原子受理',
      template: 'project-feature',
      agent: 'mock',
      allowDirtyBase: true,
      requestId: 'http-admission-retry-01',
    };
    const old = await rpc('workflow.plan', intent);
    expect(old.status).toBe(200);
    const templatePath = join(fixture.projectRoot, '.tekon', 'workflows', 'project-feature.yaml');
    writeFileSync(templatePath, readFileSync(templatePath, 'utf8').replace('commandRef: build', 'commandRef: test'));
    const before = db.prepare('select count(*) as count from workflow_instances').get() as { count: number };
    const rejected = await rpc('project.run', { ...intent, planDigest: old.body.result.digest });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('PLAN_DIGEST_MISMATCH');
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual(before);
    const fresh = await rpc('workflow.plan', intent);
    const payload = { ...intent, planDigest: fresh.body.result.digest };
    const accepted = await rpc('project.run', payload);
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.requestId).toBe(intent.requestId);
    expect(accepted.body.result.replayed).toBe(false);
    expect(accepted.body.result.admissionState).toBe('accepted');
    // 丢失 accepted 响应后，原请求仍可重放；当前模板即使已损坏也不参与重放。
    writeFileSync(templatePath, 'not a valid workflow');
    const replayed = await rpc('project.run', payload);
    expect(replayed.status).toBe(200);
    expect(replayed.body.result.replayed).toBe(true);
    for (const field of ['sessionId', 'jobId', 'requestId']) {
      expect(replayed.body.result[field]).toBe(accepted.body.result[field]);
    }
    expect(replayed.body.result.run.id).toBe(accepted.body.result.run.id);
    const conflict = await rpc('project.run', { ...payload, demandText: '另一个明确意图' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toContain('REQUEST_ID_CONFLICT');
    const opening = db.prepare("select type from session_events where session_id=? and type in ('session/created','workflow/started','user/message') order by seq").all(accepted.body.result.sessionId);
    expect(opening).toEqual([{ type: 'session/created' }, { type: 'workflow/started' }, { type: 'user/message' }]);
    const lookup = await rpc('project.admission', { token: fixture.sessionToken, requestId: intent.requestId });
    expect(lookup.status).toBe(200);
    expect(lookup.body.result.runId).toBe(accepted.body.result.run.id);
    const unauthorized = await rpc('project.admission', { token: 'wrong-token', requestId: intent.requestId });
    expect(unauthorized.status).toBe(401);
    expect(JSON.stringify(unauthorized.body)).not.toContain(accepted.body.result.run.id);
  });

  it('只读意图服务的 scope/hash 稳定、身份隔离且不创建 Run', async () => {
    const { fixture, db, rpc } = await setup();
    const before = db.prepare('select count(*) as count from workflow_instances').get();
    const run = { demandText: '待确认请求', mode: 'goal', agent: 'mock', allowDirtyBase: true };
    const input = { token: fixture.sessionToken, run };
    const first = await rpc('project.admissionIntent', input);
    const second = await rpc('project.admissionIntent', input);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.result.scope).toMatch(/^[a-f0-9]{64}$/);
    expect(second.body.result.scope).toBe(first.body.result.scope);
    expect(second.body.result.fingerprint).toBe(first.body.result.fingerprint);
    expect(second.body.result.requestId).not.toBe(first.body.result.requestId);
    expect(JSON.stringify(first.body)).not.toContain(fixture.sessionToken);
    expect(JSON.stringify(first.body)).not.toContain(fixture.projectRoot);
    const scopeOnly = await rpc('project.admissionIntent', { token: fixture.sessionToken });
    expect(scopeOnly.body.result).toEqual({ scope: first.body.result.scope });
    writeFileSync(join(fixture.projectRoot, '.tekon', 'web-session.json'), JSON.stringify({ token: 'rotated-fixture-token' }));
    const rotated = await rpc('project.admissionIntent', { token: 'rotated-fixture-token', run });
    expect(rotated.status).toBe(200);
    expect(rotated.body.result.scope).not.toBe(first.body.result.scope);
    expect(rotated.body.result.fingerprint).toBe(first.body.result.fingerprint);
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual(before);
  });

  it('目录失败保留身份并阻止 Job，修复目录后原请求恢复而不重建', async () => {
    const { fixture, db, rpc } = await setup();
    const runRoot = join(fixture.projectRoot, '.tekon', 'runs');
    const savedRoot = join(fixture.projectRoot, '.tekon', 'runs-fixture-backup');
    renameSync(runRoot, savedRoot);
    writeFileSync(runRoot, '故障注入：文件不能充当 Run 目录');
    const input = {
      token: fixture.sessionToken,
      requestId: 'http-directory-recovery-01',
      mode: 'goal', agent: 'mock', allowDirtyBase: true, demandText: '目录恢复测试',
    };
    const failed = await rpc('project.run', input);
    expect(failed.status).toBe(200);
    expect(failed.body.result.admissionState).toBe('recovery-required');
    const runId = failed.body.result.run.id;
    expect(db.prepare('select count(*) as count from role_runs where run_id=?').get(runId)).toEqual({ count: 0 });
    const lookup = await rpc('project.admission', { token: fixture.sessionToken, requestId: input.requestId });
    expect(lookup.body.result.state).toBe('recovery-required');
    const detail = await rpc('project.detail', { projectId: failed.body.result.run.projectId });
    expect(detail.body.result.runs.find((run: { id: string }) => run.id === runId).admissionState).toBe('recovery-required');
    const sessionList = await rpc('session.list', undefined, fixture.sessionToken);
    expect(sessionList.status).toBe(200);
    expect(sessionList.body.result.sessions.find((session: { id: string }) => session.id === failed.body.result.sessionId))
      .toMatchObject({ admissionState: 'recovery-required', filesState: 'recovery_required' });
    const sessionDetail = await rpc('session.get', { sessionId: failed.body.result.sessionId }, fixture.sessionToken);
    expect(sessionDetail.body.result.session).toMatchObject({ admissionState: 'recovery-required', filesState: 'recovery_required' });
    const review = await rpc('review.get', { runId }, fixture.sessionToken);
    expect(review.body.result).toMatchObject({ admissionState: 'recovery-required', filesState: 'recovery_required' });
    unlinkSync(runRoot);
    renameSync(savedRoot, runRoot);
    const recovered = await rpc('project.run', input);
    expect(recovered.status).toBe(200);
    expect(recovered.body.result.admissionState).toBe('accepted');
    expect(recovered.body.result.run.id).toBe(runId);
    expect(recovered.body.result.jobId).toBe(failed.body.result.jobId);
    expect(recovered.body.result.replayed).toBe(true);
    expect(db.prepare('select count(*) as count from sessions where run_id=?').get(runId)).toEqual({ count: 1 });
  });
});
