import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTekonDatabase } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer } from '../../src/server/http.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

async function setup() {
  const fixture = await createWebFixtureProject();
  cleanup.push(fixture.cleanup);
  const server = await createWebServer({ projectRoot: fixture.projectRoot, port: 0, vite: false });
  cleanup.push(() => server.close());
  await server.listen();
  const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
  cleanup.push(() => { db.close(); });
  const profilePath = join(fixture.projectRoot, '.tekon', 'repo-profile.yaml');
  async function rpc(path: string, input: unknown, authenticated = false) {
    const response = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
        ...(authenticated ? { 'x-session-token': fixture.sessionToken } : {}) },
      body: JSON.stringify({ path, input }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { fixture, db, profilePath, rpc };
}

describe('R24 真实 HTTP 的有效检查绑定', () => {
  it('新服务轮换显示scope但不改变受理digest，profile切换检测仍可比较', async () => {
    const { fixture, profilePath, rpc } = await setup();
    const input = { template: 'project-feature', agent: 'mock' };
    const first = await rpc('workflow.plan', input);
    const second = await createWebServer({ projectRoot: fixture.projectRoot, port: 0, vite: false });
    cleanup.push(() => second.close());
    await second.listen();
    const response = await fetch(`${second.url}/api/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'workflow.plan', input }),
    });
    expect(response.status).toBe(200);
    const next = (await response.json()).result;
    expect(next.digest).toBe(first.body.result.digest);
    expect(next.comparisonScope).not.toBe(first.body.result.comparisonScope);
    expect(next.gates[0].commandBinding.fingerprint).not.toBe(first.body.result.gates[0].commandBinding.fingerprint);
    unlinkSync(profilePath);
    writeFileSync(join(fixture.projectRoot, 'package.json'), JSON.stringify({ scripts: { build: 'echo PRIVATE_SCRIPT' } }));
    const detected = await rpc('workflow.plan', input);
    expect(detected.status).toBe(200);
    expect(detected.body.result.comparisonScope).toBe(first.body.result.comparisonScope);
    expect(detected.body.result.digest).not.toBe(first.body.result.digest);
    expect(detected.body.result.gates.find((g: { type: string }) => g.type === 'build').commandBinding.source).toBe('package-json-detection');
    expect(JSON.stringify(detected.body)).not.toContain('PRIVATE_SCRIPT');
  });

  it('公开逐Gate行为遵循配置N/A与security例外，未使用配置不扰动摘要', async () => {
    const { fixture, profilePath, rpc } = await setup();
    writeFileSync(join(fixture.projectRoot, '.tekon', 'workflows', 'binding-matrix.yaml'), JSON.stringify({
      id: 'binding-matrix', governance: 'none', phases: [{ id: 'dev', nodes: [{ id: 'rd', role: 'rd', gates: [
        { type: 'build', commandRef: 'build' },
        { type: 'lint', commandRef: 'lint' },
        { type: 'test', commandRef: 'test' },
        { type: 'security-scan', commandRef: 'security' },
        { type: 'security-scan', command: { tool: 'npm', args: ['run', 'PRIVATE_INLINE'], env: { PRIVATE_ENV: 'PRIVATE_VALUE' } } },
        { type: 'human' },
      ] }] }],
    }));
    const profile = 'version: 1\ncommands:\n  build:\n    tool: npm\n    args: [run, PRIVATE_BUILD]\n  lint:\n    notApplicable: true\n    reason: PRIVATE_NA\n  security:\n    notApplicable: true\n    reason: PRIVATE_SECURITY_NA\n';
    writeFileSync(profilePath, profile);
    const input = { template: 'binding-matrix', agent: 'mock' };
    const preview = await rpc('workflow.plan', input);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.result.gates.map((g: { commandBinding: { behavior: string } }) => g.commandBinding.behavior))
      .toEqual(['execute-command', 'skip', 'missing-command', 'builtin-security', 'builtin-security-and-command', 'not-command-gate']);
    for (const gate of preview.body.result.gates) expect(gate.commandBinding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(preview.body)).not.toContain('PRIVATE_');
    writeFileSync(profilePath, profile.replace('    args: [run, PRIVATE_BUILD]', '    args: [run, PRIVATE_BUILD]\n    description: PRIVATE_DESCRIPTION') + '  e2e:\n    tool: npm\n    args: [run, PRIVATE_UNUSED]\n');
    const unchanged = await rpc('workflow.plan', input);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.result).toEqual(preview.body.result);
  });

  it('公开/认证预览只给脱敏逐检查信息，同实例比较稳定且实际命令变化可定位', async () => {
    const { profilePath, rpc } = await setup();
    writeFileSync(profilePath, 'version: 1\ncommands:\n  build:\n    tool: npm\n    args: [run, PRIVATE_BUILD_A]\n  lint:\n    notApplicable: true\n    reason: PRIVATE_NA_REASON\n');
    const input = { template: 'project-feature', agent: 'mock', allowDirtyBase: true };
    const a = await rpc('workflow.plan', input);
    const b = await rpc('workflow.plan', input, true);
    for (const response of [a, b]) {
      expect(response.status).toBe(200);
      expect(response.body.result).toMatchObject({ digestVersion: 3, comparisonScope: expect.any(String) });
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_');
      expect(response.body.result).not.toHaveProperty('repoCommands');
      expect(response.body.result).not.toHaveProperty('template');
    }
    expect(a.body.result).toEqual(b.body.result);
    const gates = a.body.result.gates;
    expect(gates.find((g: { type: string }) => g.type === 'build').commandBinding)
      .toMatchObject({ status: 'resolved', source: 'repo-profile', behavior: 'execute-command', commandRef: 'build', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(gates.find((g: { type: string }) => g.type === 'lint').commandBinding)
      .toMatchObject({ status: 'not-applicable', behavior: 'skip' });
    writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace('PRIVATE_BUILD_A', 'PRIVATE_BUILD_B'));
    const changed = await rpc('workflow.plan', input);
    expect(changed.body.result.digest).not.toBe(a.body.result.digest);
    expect(changed.body.result.comparisonScope).toBe(a.body.result.comparisonScope);
    for (const gate of gates.filter((g: { commandBinding?: unknown }) => g.commandBinding)) {
      const current = changed.body.result.gates.find((g: { nodeId: string; gateIndex: number }) => g.nodeId === gate.nodeId && g.gateIndex === gate.gateIndex);
      if (gate.type === 'build') expect(current.commandBinding.fingerprint).not.toBe(gate.commandBinding.fingerprint);
      else expect(current.commandBinding.fingerprint).toBe(gate.commandBinding.fingerprint);
    }
  });

  it('预览后配置变化拒绝且零受理，原 requestId 受理后重放不依赖坏 profile', async () => {
    const { fixture, db, profilePath, rpc } = await setup();
    const intent = { token: fixture.sessionToken, requestId: 'r24-http-binding-01', template: 'project-feature',
      agent: 'mock', allowDirtyBase: true, demandText: '绑定后才执行' };
    const old = await rpc('workflow.plan', intent);
    writeFileSync(profilePath, 'version: 1\ncommands:\n  build:\n    notApplicable: true\n    reason: changed before admission\n');
    const rejected = await rpc('project.run', { ...intent, planDigest: old.body.result.digest });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('PLAN_DIGEST_MISMATCH');
    expect(db.prepare('select count(*) as count from run_admissions').get()).toEqual({ count: 0 });
    const fresh = await rpc('workflow.plan', intent);
    const payload = { ...intent, planDigest: fresh.body.result.digest };
    const accepted = await rpc('project.run', payload);
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.run.executionBinding).toBe('frozen');
    const runId = accepted.body.result.run.id;
    const persisted = db.prepare('select plan_snapshot from workflow_instances where id=?').get(runId) as { plan_snapshot: string };
    expect(JSON.parse(persisted.plan_snapshot)).toMatchObject({ digestVersion: 3, repoCommands: expect.any(Array) });
    const nodes = db.prepare('select gates from nodes where run_id=?').all(runId) as Array<{ gates: string }>;
    for (const node of nodes) for (const gate of JSON.parse(node.gates)) expect(gate).not.toHaveProperty('commandRef');
    writeFileSync(profilePath, '[PRIVATE_BROKEN_PROFILE');
    const replay = await rpc('project.run', payload);
    expect(replay.status).toBe(200);
    expect(replay.body.result.replayed).toBe(true);
    expect(replay.body.result.run.id).toBe(runId);
    expect(replay.body.result.jobId).toBe(accepted.body.result.jobId);
  });

  it('所需配置无法解析时给可修正的脱敏错误，不能当成成功缺配置预览', async () => {
    const { fixture, db, profilePath, rpc } = await setup();
    writeFileSync(profilePath, '[PRIVATE_BROKEN_PROFILE');
    const result = await rpc('workflow.plan', { template: 'project-feature', agent: 'mock' });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toMatch(/PLAN_.*(?:PROFILE|CONFIG)/);
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE_BROKEN_PROFILE');
    const rejected = await rpc('project.run', { token: fixture.sessionToken, template: 'project-feature', agent: 'mock',
      allowDirtyBase: true, demandText: '配置错误不受理', planDigest: 'stale-confirmation' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('PLAN_CONFIG_INVALID');
    expect(JSON.stringify(rejected.body)).not.toContain('PRIVATE_BROKEN_PROFILE');
    expect(db.prepare('select count(*) as count from run_admissions').get()).toEqual({ count: 0 });
    const goal = await rpc('workflow.plan', { mode: 'goal', agent: 'mock' });
    expect(goal.status).toBe(200);
    expect(goal.body.result.digestVersion).toBe(3);
  });

  it('历史与坏快照观察分类一致，不把缺损 admission 降级为历史', async () => {
    const { fixture, db, rpc } = await setup();
    const legacy = await rpc('review.get', { token: fixture.sessionToken, runId: 'run_1' }, true);
    expect(legacy.status).toBe(200);
    expect(legacy.body.result.executionBinding).toBe('legacy-unbound');
    const run = await rpc('project.run', { token: fixture.sessionToken, requestId: 'r24-http-invalid-01', mode: 'goal',
      agent: 'mock', allowDirtyBase: true, demandText: '观察分类' });
    expect(run.status).toBe(200);
    const runId = run.body.result.run.id;
    db.prepare('update workflow_instances set plan_snapshot=null, plan_digest=null where id=?').run(runId);
    const detail = await rpc('review.get', { token: fixture.sessionToken, runId }, true);
    expect(detail.body.result.executionBinding).toBe('invalid');
    const session = await rpc('session.get', { sessionId: run.body.result.sessionId }, true);
    expect(session.body.result.session.executionBinding).toBe('invalid');
    const project = await rpc('project.detail', { projectId: run.body.result.run.projectId });
    expect(project.body.result.runs.find((r: { id: string }) => r.id === runId).executionBinding).toBe('invalid');
  });
});
