import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditLogger } from '../../src/audit/logger.js';
import { buildRunAdmissionEnvelope, hashAdmissionEnvelope } from '../../src/db/admission-store.js';
import { openTekonDatabase, type TekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { admissionData, parallelDatabaseProcesses } from './admission-fixture.js';

describe('atomic run admissions', () => {
  const directories: string[] = [];
  const databases: TekonDatabase[] = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'tekon-admission-'));
    directories.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const filename = join(root, 'db.sqlite');
    const db = openTekonDatabase({ filename });
    databases.push(db);
    migrateDatabase(db);
    const repositories = createRepositories(db);
    return { root, repo, filename, db, repositories, store: repositories.admissionStore! };
  }

  const writes = [
    ['demands', '1'], ['projects', '1'], ['workflow_instances', '1'],
    ['run_provider_configs', '1'], ['phases', '1'], ['nodes', '1'],
    ['audit_events', "new.type = 'run.started'"],
    ['audit_events', "new.type = 'run.policy-checked'"],
    ['workspaces', '1'], ['sessions', '1'], ['session_events', 'new.seq = 1'],
    ['session_events', 'new.seq = 2'], ['session_events', 'new.seq = 3'], ['jobs', '1'],
    ['run_admissions', '1'],
  ] as const;
  it.each(writes)('rolls back the entire write set when %s (%s) rejects', async (table, condition) => {
    const { db, repo, store } = fixture();
    db.exec(`create trigger fail_admission before insert on ${table} when ${condition}
      begin select raise(abort, 'injected failure'); end`);
    await expect(store.admitRun(admissionData(repo))).rejects.toThrow('injected failure');
    for (const name of new Set(writes.map(([name]) => name))) {
      expect(db.prepare(`select count(*) as n from ${name}`).get(), name).toEqual({ n: 0 });
    }
    expect(existsSync(join(repo, '.tekon'))).toBe(false);
  });

  it('returns persisted workflow and only the winner opening events, with one complete Session', async () => {
    const { db, repo, store, repositories } = fixture();
    const first = await store.admitRun(admissionData(repo));
    const replay = await store.admitRun(admissionData(repo, 'loser'));
    expect(first).toMatchObject({ outcome: 'admitted', workflow: { id: 'run_one' }, filesState: 'ready' });
    expect(first.openingEvents.map((event) => [event.seq, event.type])).toEqual([
      [1, 'session/created'], [2, 'workflow/started'], [3, 'user/message'],
    ]);
    expect(replay).toMatchObject({ outcome: 'already_admitted', runId: first.runId,
      sessionId: first.sessionId, jobId: first.jobId, workflow: first.workflow, openingEvents: [] });
    expect(db.prepare('select status from sessions').get()).toEqual({ status: 'active' });
    expect(db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
    expect(await createAuditLogger({ repositories }).verify(first.runId)).toEqual({ valid: true });
    await expect(store.admitRun({ ...admissionData(repo), envelopeHash: 'different' })).rejects.toThrow('REQUEST_ID_CONFLICT');
  });

  it('deduplicates two independent processes and returns the winning IDs and workflow', async () => {
    const { db, repo, filename } = fixture();
    const results = await parallelDatabaseProcesses(filename, ['alpha', 'beta'].map((suffix) =>
      `const result = await repositories.admissionStore.admitRun(${JSON.stringify(admissionData(repo, suffix))});
       process.send({ result });`));
    expect(results.map((result) => result.outcome).sort()).toEqual(['admitted', 'already_admitted']);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(results[0].workflow).toEqual(results[1].workflow);
    expect(results.map((result) => result.openingEvents.length).sort()).toEqual([0, 3]);
    for (const table of ['demands', 'projects', 'workflow_instances', 'workspaces', 'sessions', 'jobs', 'run_admissions']) {
      expect(db.prepare(`select count(*) as n from ${table}`).get(), table).toEqual({ n: 1 });
    }
    expect(db.prepare('select count(*) as n from session_events').get()).toEqual({ n: 3 });
  }, 20_000);

  it.each(['../outside', '/tmp/unsafe-admission', '.', '.tekon/../elsewhere', ''])('rejects unsafe dataDir %j before writes', async (dataDir) => {
    const { db, repo, store } = fixture();
    await expect(store.admitRun({ ...admissionData(repo), dataDir })).rejects.toThrow('INVALID_DATA_DIR');
    expect(db.prepare('select count(*) as n from demands').get()).toEqual({ n: 0 });
  });

  it.each(['.tekon', '.tekon/runs', '.tekon/runs/run_one'])('does not write through an escaping symlink at %s', async (link) => {
    const { root, repo, store } = fixture();
    const outside = join(root, 'repo-outside');
    mkdirSync(outside);
    const segments = link.split('/');
    mkdirSync(join(repo, ...segments.slice(0, -1)), { recursive: true });
    symlinkSync(outside, join(repo, link));
    const result = await store.admitRun(admissionData(repo));
    expect(result.filesState).toBe('recovery_required');
    expect(result.admission.lastError).toBe('ADMISSION_FILES_UNAVAILABLE');
    expect(existsSync(join(outside, 'runs'))).toBe(false);
    expect(existsSync(join(outside, 'run_one'))).toBe(false);
  });

  it('refuses a persisted repository root redirected outside before pending admission recovery', async () => {
    const { root, repo, db, store } = fixture();
    writeFileSync(join(repo, '.tekon'), 'block initial file preparation');
    const accepted = await store.admitRun(admissionData(repo));
    expect(accepted.filesState).toBe('recovery_required');
    db.prepare("update run_admissions set files_state = 'pending', last_error = null where request_id = ?").run(accepted.requestId);
    renameSync(repo, join(root, 'original-repo'));
    const outside = join(root, 'repo-outside');
    mkdirSync(outside);
    symlinkSync(outside, repo);

    const recovered = await store.recoverAdmissionFiles(accepted.requestId);
    expect(recovered).toMatchObject({ requestId: accepted.requestId, runId: accepted.runId,
      sessionId: accepted.sessionId, jobId: accepted.jobId, filesState: 'recovery_required',
      lastError: 'ADMISSION_FILES_UNAVAILABLE' });
    expect(readdirSync(outside)).toEqual([]);
    expect(db.prepare('select repo_path from projects').get()).toEqual({ repo_path: repo });
  });

  it('persists the initial canonical root and does not follow a later retargeted input alias', async () => {
    const { root, repo, db, store } = fixture();
    const alias = join(root, 'repo-alias');
    symlinkSync(repo, alias);
    writeFileSync(join(repo, '.tekon'), 'block initial file preparation');
    const accepted = await store.admitRun(admissionData(alias));
    expect(accepted.filesState).toBe('recovery_required');
    expect(db.prepare('select repo_path from projects').get()).toEqual({ repo_path: realpathSync(repo) });
    const outside = join(root, 'repo-outside');
    mkdirSync(outside);
    rmSync(alias);
    symlinkSync(outside, alias);
    rmSync(join(repo, '.tekon'));

    expect(await store.recoverAdmissionFiles(accepted.requestId)).toMatchObject({ runId: accepted.runId, filesState: 'ready' });
    expect(existsSync(join(repo, '.tekon', 'runs', accepted.runId))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('recovers the persisted location without duplicating or reviving cancelled records', async () => {
    const { repo, db, store } = fixture();
    writeFileSync(join(repo, '.tekon'), 'not a directory: secret sentinel');
    const first = await store.admitRun(admissionData(repo));
    expect(first.filesState).toBe('recovery_required');
    expect(first.admission.lastError).toBe('ADMISSION_FILES_UNAVAILABLE');
    db.exec("update workflow_instances set status = 'cancelled'; update jobs set status = 'cancelled'");
    rmSync(join(repo, '.tekon'));
    const replay = await store.admitRun({ ...admissionData(repo, 'ignored'), dataDir: 'ignored' });
    expect(replay.filesState).toBe('ready');
    expect(replay.workflow.status).toBe('cancelled');
    expect(existsSync(join(repo, '.tekon', 'runs', first.runId))).toBe(true);
    expect(existsSync(join(repo, 'ignored'))).toBe(false);
    expect(db.prepare('select status from jobs').get()).toEqual({ status: 'cancelled' });
    expect(db.prepare('select count(*) as n from session_events').get()).toEqual({ n: 3 });
  });

  it('returns latest recovery rows, errors on missing requests, and never downgrades ready', async () => {
    const { repo, store } = fixture();
    const accepted = await store.admitRun(admissionData(repo));
    rmSync(join(repo, '.tekon'), { recursive: true });
    writeFileSync(join(repo, '.tekon'), 'late filesystem failure');
    expect(await store.recoverAdmissionFiles(accepted.requestId)).toMatchObject({ runId: accepted.runId, filesState: 'ready' });
    await expect(store.recoverAdmissionFiles('request_missing')).rejects.toThrow('ADMISSION_NOT_FOUND');
  });

  it('returns another connection\'s ready result when a stale recovery subsequently fails', async () => {
    const { repo, filename, db, store } = fixture();
    writeFileSync(join(repo, '.tekon'), 'blocked directory');
    const accepted = await store.admitRun(admissionData(repo));
    expect(accepted.filesState).toBe('recovery_required');
    const racingDb = openTekonDatabase({ filename });
    const originalPrepare = db.prepare.bind(db);
    const interleave = vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      const statement = originalPrepare(source);
      if (source.startsWith('select ra.*')) {
        const originalGet = statement.get.bind(statement);
        statement.get = ((...args: unknown[]) => {
          const staleRow = originalGet(...args);
          // Advance real SQLite state between recovery's read and its failed filesystem operation.
          racingDb.prepare("update run_admissions set files_state = 'ready', last_error = null where request_id = ?").run(accepted.requestId);
          return staleRow;
        }) as typeof statement.get;
      }
      return statement;
    });
    try {
      const latest = await store.recoverAdmissionFiles(accepted.requestId);
      expect(latest).toMatchObject({ filesState: 'ready', lastError: null });
      expect(await store.getAdmission(accepted.requestId)).toEqual(latest);
    } finally { interleave.mockRestore(); racingDb.close(); }
  });

  it('retains accepted IDs if the ready-state write fails, then scans the committed run on restart', async () => {
    const { repo, filename, db, store } = fixture();
    db.exec(`create trigger fail_ready before update on run_admissions
      when new.files_state = 'ready' begin select raise(abort, 'injected ready write failure'); end`);
    await expect(store.admitRun(admissionData(repo))).rejects.toThrow('injected ready write failure');
    const pending = await store.getAdmission('request_shared_123');
    expect(pending).toMatchObject({ filesState: 'pending', runId: 'run_one', sessionId: 'session_one', jobId: 'job_one' });
    expect(existsSync(join(repo, '.tekon', 'runs', 'run_one'))).toBe(true);
    db.exec('drop trigger fail_ready');
    const restartedDb = openTekonDatabase({ filename });
    try {
      migrateDatabase(restartedDb);
      const restarted = createRepositories(restartedDb).admissionStore;
      expect(await restarted.scanAndRecoverAdmissions()).toBe(1);
      expect(await restarted.scanAndRecoverAdmissions()).toBe(0);
      expect(await restarted.getAdmission('request_shared_123')).toMatchObject({ ...pending, filesState: 'ready', updatedAt: expect.any(String) });
      expect(restartedDb.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
      expect(restartedDb.prepare('select count(*) as n from audit_events').get()).toEqual({ n: 2 });
    } finally { restartedDb.close(); }
  });

  it('recovers a commit-before-files crash and returns the same Session identity after restart', async () => {
    const { repo, filename, store } = fixture();
    const [committed] = await parallelDatabaseProcesses(filename, [`
      // Simulate termination immediately after the first queue task commits.
      const enqueue = writeQueue.enqueue.bind(writeQueue);
      let tasks = 0;
      writeQueue.enqueue = (operation) => {
        if (++tasks === 2) {
          process.send({ result: true }, () => process.exit(0));
          return new Promise(() => {});
        }
        return enqueue(operation);
      };
      await repositories.admissionStore.admitRun(${JSON.stringify(admissionData(repo))});
    `]);
    expect(committed).toBe(true);
    expect(await store.getAdmission('request_shared_123')).toMatchObject({ filesState: 'pending' });
    expect(existsSync(join(repo, '.tekon'))).toBe(false);
    const replay = await store.admitRun(admissionData(repo, 'late'));
    expect(replay).toMatchObject({ outcome: 'already_admitted', runId: 'run_one', sessionId: 'session_one', jobId: 'job_one', filesState: 'ready', openingEvents: [] });
  }, 20_000);

  it('rolls back all rows when the process exits before transaction commit', async () => {
    const { repo, filename, db, store } = fixture();
    await parallelDatabaseProcesses(filename, [`
      db.function('terminate_admission_process', () => process.exit(0));
      db.exec("create trigger exit_mid_admission before insert on run_admissions begin select terminate_admission_process(); end");
      await repositories.admissionStore.admitRun(${JSON.stringify(admissionData(repo))});
    `]);
    expect(await store.getAdmission('request_shared_123')).toBeNull();
    for (const name of new Set(writes.map(([name]) => name))) {
      expect(db.prepare(`select count(*) as n from ${name}`).get(), name).toEqual({ n: 0 });
    }
    expect(existsSync(join(repo, '.tekon'))).toBe(false);
  }, 20_000);

  it('supports direct Core admissions without creating Session, Job, or opening events', async () => {
    const { db, repo, store } = fixture();
    const accepted = await store.admitRun({ ...admissionData(repo), sessionData: undefined, providerSnapshot: undefined });
    expect(accepted).toMatchObject({ filesState: 'ready', openingEvents: [], admission: { sessionId: null, jobId: null } });
    for (const table of ['sessions', 'workspaces', 'jobs', 'session_events']) {
      expect(db.prepare(`select count(*) as n from ${table}`).get(), table).toEqual({ n: 0 });
    }
  });

  it('requires the complete Provider snapshot for Session admissions', async () => {
    const { db, repo, store } = fixture();
    await expect(store.admitRun({ ...admissionData(repo), providerSnapshot: undefined })).rejects.toThrow('PROVIDER_SNAPSHOT_REQUIRED');
    expect(db.prepare('select count(*) as n from demands').get()).toEqual({ n: 0 });
  });

  it('enforces files-state and paired Session/Job constraints and preserves request identity on delete', async () => {
    const { repo, db, store } = fixture();
    await store.admitRun(admissionData(repo));
    expect(() => db.exec("update run_admissions set files_state = 'unknown'")).toThrow();
    expect(() => db.exec('update run_admissions set session_id = null')).toThrow();
    expect(() => db.exec('update run_admissions set job_id = null')).toThrow();
    for (const table of ['jobs', 'sessions', 'workflow_instances']) {
      expect(() => db.exec(`delete from ${table}`), table).toThrow();
    }
    expect(await store.getAdmission('request_shared_123')).not.toBeNull();
  });
});

describe('admission envelope identity', () => {
  const envelope = { version: 1, scope: '/repo', demandTextOrRef: 'build', mode: 'workflow' as const };
  it('binds every explicit JSON field and keeps nested digest keys', () => {
    const first = { ...envelope, options: { config: { digest: 'one' }, dataDir: '.tekon' } };
    const second = { ...envelope, options: { config: { digest: 'two' }, dataDir: '.tekon' } };
    expect(hashAdmissionEnvelope(first)).not.toBe(hashAdmissionEnvelope(second));
    expect(hashAdmissionEnvelope(first)).toBe(hashAdmissionEnvelope({ ...envelope, options: { dataDir: '.tekon', config: { digest: 'one' } } }));
    expect(buildRunAdmissionEnvelope({ ...envelope, options: first.options })).toMatchObject({ options: first.options });
  });
  it.each([() => {}, Symbol('bad'), BigInt(1), NaN, Infinity, new Date()])('rejects non-JSON execution input %s', (bad) => {
    expect(() => hashAdmissionEnvelope({ ...envelope, options: { bad } })).toThrow('INVALID_ADMISSION_ENVELOPE');
  });

  it('rejects an overridden array map before canonicalization can discard its values', () => {
    const map = vi.fn(() => []);
    const values = Object.assign([1], { map });
    expect(() => hashAdmissionEnvelope({ ...envelope, options: { values } })).toThrow('INVALID_ADMISSION_ENVELOPE');
    expect(map).not.toHaveBeenCalled();
  });

  it('rejects array index accessors without evaluating their getters', () => {
    const getter = vi.fn(() => 1);
    const values = Object.defineProperty([1], '0', { get: getter, enumerable: true });
    expect(() => hashAdmissionEnvelope({ ...envelope, options: { values } })).toThrow('INVALID_ADMISSION_ENVELOPE');
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['custom prototype', () => Object.setPrototypeOf([1], Object.create(Array.prototype))],
    ['extra data property', () => Object.assign([1], { extra: 2 })],
    ['non-enumerable property', () => Object.defineProperty([1], 'extra', { value: 2 })],
    ['sparse indices', () => new Array(2)],
  ] as const)('rejects arrays with %s', (_name, makeValues) => {
    expect(() => hashAdmissionEnvelope({ ...envelope, options: { values: makeValues() } })).toThrow('INVALID_ADMISSION_ENVELOPE');
  });

  it('accepts ordinary dense and frozen JSON arrays while binding their contents', () => {
    const values = [1, { digest: 'nested' }, null, ['text']];
    const frozenValues = Object.freeze([1, { digest: 'nested' }, null, ['text']]);
    expect(hashAdmissionEnvelope({ ...envelope, options: { values } })).toBe(
      hashAdmissionEnvelope({ ...envelope, options: { values: frozenValues } }),
    );
    expect(hashAdmissionEnvelope({ ...envelope, options: { values } })).not.toBe(
      hashAdmissionEnvelope({ ...envelope, options: { values: [] } }),
    );
  });
});
