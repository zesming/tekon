import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger, createJobRepository, createJobRunner, createMockAgentAdapter,
  createRepositories, createSessionEventBus, createSessionEventStore,
  createSessionService, createSubprocessRegistry, createWorkflowEngine, createWriteQueue,
  captureRunPlan, migrateDatabase, openTekonDatabase, parseWorkflowTemplate,
} from '../../src/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); });
function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'tekon-service-admission-'));
  cleanup.push(() => rmSync(projectRoot, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => { db.close(); });
  migrateDatabase(db);
  const queue = createWriteQueue();
  const repositories = createRepositories(db, queue);
  const audit = createAuditLogger({ repositories });
  const sessions = createSessionEventStore(db, queue);
  const jobs = createJobRepository(db, queue);
  const bus = createSessionEventBus();
  const runner = createJobRunner({ jobs, sessions, bus, registry: createSubprocessRegistry(), executor: { execute: async () => ({ status: 'done' }) } });
  const order: string[] = [];
  const factory = vi.fn((input: { runtime?: { timeoutMs?: number } }) => {
    order.push('factory');
    return createWorkflowEngine({ repoPath: projectRoot, dataDir: '.tekon', repositories, audit,
      adapter: createMockAgentAdapter(), agentProvider: 'mock',
      agentConfigSummary: { factoryResolved: true, timeoutMs: input.runtime?.timeoutMs ?? 30_000 } });
  });
  const preflight = vi.fn(async () => { order.push('preflight'); });
  const service = createSessionService({ repositories, audit, sessions, jobs, bus, jobRunner: runner, projectRoot,
    createEngine: factory, preflight });
  return { projectRoot, db, repositories, audit, sessions, jobs, bus, service, factory, preflight, order };
}

describe('SessionService 使用真实 Engine 原子受理', () => {
  it('Provider/preflight的await期间profile变化，拒绝旧确认且无新受理', async () => {
    const env = setup();
    mkdirSync(join(env.projectRoot, '.tekon'));
    const path = join(env.projectRoot, '.tekon/repo-profile.yaml');
    writeFileSync(path, JSON.stringify({ commands: { build: { tool: 'npm', args: ['run', 'confirmed'] } } }));
    const template = parseWorkflowTemplate({ id: 'await-facts', governance: 'none', phases: [{ id: 'dev', nodes: [{ id: 'rd', role: 'rd', gates: [{ type: 'build', commandRef: 'build' }] }] }] });
    const confirmed = captureRunPlan(env.projectRoot, template, { agent: 'mock', profile: 'human-web' });
    env.preflight.mockImplementationOnce(async () => {
      await Promise.resolve();
      writeFileSync(path, JSON.stringify({ commands: { build: { notApplicable: true, reason: 'changed after provider await' } } }));
    });
    await expect(env.service.startRun({ requestId: 'service-command-await-01', demandText: 'preflight drift', workflowSpec: template, engine: {}, planDigest: confirmed.digest })).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
    expect(env.preflight).toHaveBeenCalledOnce();
    for (const table of ['run_admissions', 'workflow_instances', 'sessions', 'jobs', 'gate_results']) {
      expect(env.db.prepare(`select count(*) as count from ${table}`).get()).toEqual({ count: 0 });
    }
    expect(existsSync(join(env.projectRoot, '.tekon/runs'))).toBe(false);
  });

  it('持久化factory解析出的配置，治理Audit与opening prefix各一次；重放不再预检', async () => {
    const { service, db, factory, preflight, order, audit } = setup();
    const input = { requestId: 'service-factory-01', demandText: 'factory truth', mode: 'goal' as const,
      engine: { runtime: { timeoutMs: 1234 } }, admissionAudits: [{ type: 'run.network-acknowledged', payload: { accepted: true } }] };
    const first = await service.startRun(input);
    expect(order).toEqual(['factory', 'preflight']);
    const config = db.prepare('select config_summary from run_provider_configs where run_id=?').get(first.runId) as { config_summary: string };
    expect(JSON.parse(config.config_summary)).toEqual({ factoryResolved: true, timeoutMs: 1234 });
    await expect(audit.verify(first.runId)).resolves.toEqual({ valid: true });
    const replayed = await service.startRun(input);
    expect(replayed.runId).toBe(first.runId);
    expect(replayed.sessionId).toBe(first.sessionId);
    expect(replayed.jobId).toBe(first.jobId);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(db.prepare('select type from session_events where session_id=? order by seq').all(first.sessionId)).toEqual([
      { type: 'session/created' }, { type: 'workflow/started' }, { type: 'user/message' },
    ]);
  });

  it('相同请求并发的所有返回值都来自持久化赢家', async () => {
    const { service, db } = setup();
    const input = { requestId: 'service-concurrent-01', demandText: 'same request', mode: 'goal' as const, engine: {} };
    const [a, b] = await Promise.all([service.startRun(input), service.startRun(input)]);
    expect(a.workflow).toBeTruthy();
    expect(b.workflow).toBeTruthy();
    for (const key of ['runId', 'sessionId', 'jobId'] as const) expect(a[key]).toBe(b[key]);
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 1 });
  });

  it('治理Audit失败完整回滚，Bus失败则保留受理结果', async () => {
    const { service, db, bus } = setup();
    db.exec("create trigger fail_governance before insert on audit_events when new.type='run.network-acknowledged' begin select raise(abort, 'governance failure'); end");
    await expect(service.startRun({ requestId: 'service-audit-fail-01', demandText: 'rollback', mode: 'goal', engine: {},
      admissionAudits: [{ type: 'run.network-acknowledged', payload: {} }] })).rejects.toThrow();
    for (const table of ['workflow_instances', 'demands', 'sessions', 'session_events', 'jobs', 'run_admissions']) {
      expect(db.prepare(`select count(*) as count from ${table}`).get()).toEqual({ count: 0 });
    }
    db.exec('drop trigger fail_governance');
    vi.spyOn(bus, 'publish').mockImplementation(() => { throw new Error('UI transport failure'); });
    const accepted = await service.startRun({ requestId: 'service-bus-fail-01', demandText: 'persisted', mode: 'goal', engine: {} });
    expect(accepted.workflow.id).toBe(accepted.runId);
    expect(db.prepare('select count(*) as count from session_events where session_id=?').get(accepted.sessionId)).toEqual({ count: 3 });
  });

  it('重启后的初始 queued Job 即使超过 stale 阈值也不被 resume 替换', async () => {
    const { service, db } = setup();
    const first = await service.startRun({ requestId: 'service-old-queue-01', demandText: 'queued remains', mode: 'goal', engine: {} });
    db.prepare("update jobs set created_at='2000-01-01T00:00:00.000Z' where id=?").run(first.jobId);
    const resumed = await service.resumeRun({ runId: first.runId });
    expect(resumed).toMatchObject({ outcome: 'enqueued', runId: first.runId, sessionId: first.sessionId, jobId: first.jobId });
    expect(db.prepare('select count(*) as count from jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('select status from jobs where id=?').get(first.jobId)).toEqual({ status: 'queued' });
  });

  it('提交后异常仍向直接Session调用方暴露自动requestId及持久Session/Job', async () => {
    const { service, db } = setup();
    db.exec("create trigger fail_state before update on run_admissions begin select raise(abort, 'state update unavailable'); end");
    const input = { demandText: 'default request identity', mode: 'goal' as const, engine: {} };
    let failure: unknown;
    try { await service.startRun(input); } catch (error) { failure = error; }
    const row = db.prepare('select request_id, run_id, session_id, job_id from run_admissions').get() as
      { request_id: string; run_id: string; session_id: string; job_id: string };
    expect(row).toBeTruthy();
    expect(failure).toMatchObject({ requestId: row.request_id, runId: row.run_id,
      sessionId: row.session_id, jobId: row.job_id, admissionState: 'recovery-required' });
    db.exec('drop trigger fail_state');
    const replay = await service.startRun({ ...input, requestId: row.request_id });
    expect(replay.runId).toBe(row.run_id);
  });
});
