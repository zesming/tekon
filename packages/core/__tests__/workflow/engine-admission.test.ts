import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger, createMockAgentAdapter, createRepositories,
  createWorkflowEngine, migrateDatabase, openTekonDatabase,
} from '../../src/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); });

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-admission-'));
  cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => { db.close(); });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const adapter = createMockAgentAdapter();
  const run = vi.spyOn(adapter, 'runAgent');
  const options = { repoPath, dataDir: '.tekon', repositories, audit, adapter, agentProvider: 'mock' as const, agentConfigSummary: { resolvedByFactory: true } };
  const engine = createWorkflowEngine(options);
  return { db, repoPath, repositories, audit, options, engine, run };
}

describe('直接 Engine 原子受理和请求身份', () => {
  it('纯准备固定实际Provider配置但不写目录/数据库', () => {
    const { engine, db, repoPath } = setup();
    const prepared = engine.buildPreparedRun({ demandText: 'pure', mode: 'template', templateName: 'goal', kind: 'goal' });
    expect(prepared.providerSnapshot).toEqual({ provider: 'mock', configSummary: { resolvedByFactory: true } });
    expect(JSON.parse(prepared.planSnapshot).template.id).toBe('goal');
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 0 });
    expect(readdirSync(repoPath)).toEqual([]);
  });

  it('prepare 的 Audit 失败使所有持久化回滚且无 Run 目录', async () => {
    const { engine, db, repoPath } = setup();
    db.exec("create trigger fail_start before insert on audit_events begin select raise(abort, 'injected audit failure'); end");
    let failure: unknown;
    try { await engine.prepareRun({ demandText: 'must rollback', mode: 'template', templateName: 'goal', kind: 'goal' }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ requestId: expect.any(String), admissionState: 'unknown', runId: undefined });
    for (const table of ['demands', 'projects', 'workflow_instances', 'run_provider_configs', 'phases', 'nodes', 'audit_events', 'run_admissions']) {
      expect(db.prepare(`select count(*) as count from ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(readdirSync(repoPath)).toEqual([]);
  });

  it('同 requestId 的并发 startRun 只有事务赢家执行一次', async () => {
    const { engine, run, db } = setup();
    const input = { demandText: '只执行一次', mode: 'template' as const, templateName: 'goal', kind: 'goal' as const, requestId: 'engine-single-run-01' };
    const [a, b] = await Promise.all([engine.startRun(input), engine.startRun(input)]);
    expect(a.runId).toBe(b.runId);
    expect(run).toHaveBeenCalledTimes(1);
    const replay = await engine.startRun(input);
    expect(replay.runId).toBe(a.runId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 1 });
  });

  it('同 requestId 改变实际Core配置即冲突，不被重放掩盖', async () => {
    const { engine, options } = setup();
    const input = { demandText: 'configuration identity', mode: 'template' as const, templateName: 'goal', kind: 'goal' as const, requestId: 'engine-options-01' };
    await engine.prepareRun(input);
    const changed = createWorkflowEngine({ ...options, baseRef: 'different-base' });
    await expect(changed.prepareRun(input)).rejects.toThrow(/REQUEST_ID_CONFLICT/);
  });

  it('提交后状态更新持续失败时异常保留默认生成的请求和持久Run身份', async () => {
    const { engine, db } = setup();
    db.exec("create trigger fail_admission_state before update on run_admissions begin select raise(abort, 'state update unavailable'); end");
    const input = { demandText: 'committed but update failed', mode: 'template' as const, kind: 'goal' as const };
    let failure: unknown;
    try { await engine.prepareRun(input); } catch (error) { failure = error; }
    const row = db.prepare('select request_id, run_id from run_admissions').get() as { request_id: string; run_id: string };
    expect(row).toBeTruthy();
    expect(failure).toMatchObject({ requestId: row.request_id, runId: row.run_id, admissionState: 'recovery-required' });
    db.exec('drop trigger fail_admission_state');
    const replay = await engine.prepareRun({ ...input, requestId: row.request_id });
    expect(replay.runId).toBe(row.run_id);
    expect(replay.replayed).toBe(true);
  });

  it('初查未命中后本次准备失败，仍返回已经持久化的并发赢家', async () => {
    const { engine, options, repositories, db } = setup();
    const input = { demandText: 'concurrent window', mode: 'template' as const, kind: 'goal' as const, requestId: 'engine-late-winner-01' };
    const store = repositories.admissionStore;
    const realGet = store.getAdmission.bind(store);
    let winnerId: string | undefined;
    vi.spyOn(store, 'getAdmission').mockImplementationOnce(async (id) => {
      const prior = await realGet(id);
      expect(prior).toBeNull();
      const winner = await createWorkflowEngine(options).prepareRun(input);
      winnerId = winner.runId;
      vi.spyOn(store, 'admitRun').mockRejectedValueOnce(new Error('candidate failed after initial lookup'));
      return prior;
    });
    const replay = await engine.prepareRun(input);
    expect(replay.runId).toBe(winnerId);
    expect(replay.replayed).toBe(true);
    expect(db.prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 1 });
  });

  it('准备成功后执行边界报错仍保留已受理身份', async () => {
    const { engine, repositories, db, run } = setup();
    vi.spyOn(repositories, 'getWorkflowInstance').mockRejectedValueOnce(new Error('execution read unavailable'));
    let failure: unknown;
    try { await engine.startRun({ demandText: 'execution boundary', mode: 'template', kind: 'goal' }); }
    catch (error) { failure = error; }
    const row = db.prepare('select request_id, run_id from run_admissions').get() as { request_id: string; run_id: string };
    expect(row).toBeTruthy();
    expect(failure).toMatchObject({ requestId: row.request_id, runId: row.run_id, admissionState: 'accepted' });
    expect(run).not.toHaveBeenCalled();
  });
});
