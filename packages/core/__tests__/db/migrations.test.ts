import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateDatabase, openTekonDatabase } from '../../src/index.js';

describe('database migrations', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates all phase 1 persistence tables and configures sqlite pragmas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row: { name: string }) => row.name)
      .sort();

    expect(tables).toEqual(
      expect.arrayContaining([
        'demands',
        'projects',
        'workflow_instances',
        'phases',
        'nodes',
        'artifacts',
        'role_runs',
        'gate_results',
        'human_decisions',
        'audit_events',
        'schema_migrations',
        'run_locks',
        'worktree_leases',
        'delivery_pull_requests',
        'run_provider_configs',
        'workspaces',
        'sessions',
        'session_events',
        'jobs',
        'projection_checkpoints',
      ]),
    );
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    db.close();
  });

  it('creates the phase-1 event spine tables and indexes without touching legacy tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    // Legacy tables, the event spine, and the persistent admission ledger.
    // (sqlite_sequence is an internal bookkeeping table created by the
    // session_events autoincrement primary key, not a Tekon table.)
    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      .map((row: { name: string }) => row.name)
      .sort();
    expect(tables).toEqual([
      'artifacts',
      'audit_events',
      'delivery_pull_requests',
      'demands',
      'gate_results',
      'human_decisions',
      'jobs',
      'nodes',
      'phases',
      'projection_checkpoints',
      'projects',
      'role_runs',
      'run_admissions',
      'run_locks',
      'run_provider_configs',
      'schema_migrations',
      'session_events',
      'sessions',
      'workflow_instances',
      'workspaces',
      'worktree_leases',
    ]);

    const indexNames = db
      .prepare("select name from sqlite_master where type = 'index'")
      .all()
      .map((row: { name: string }) => row.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_sessions_run_id',
        'idx_session_events_session_seq',
        'idx_jobs_status_created',
      ]),
    );

    // Seed session records so FK constraint is satisfied for session_events
    db.exec(`
      insert into workspaces (id, root, created_at) values ('ws1', '/tmp', '2026-08-21T00:00:00.000Z');
      insert into sessions (id, workspace_id, profile, status, created_at, updated_at) values ('s1', 'ws1', 'human-web', 'active', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
      insert into sessions (id, workspace_id, profile, status, created_at, updated_at) values ('s2', 'ws1', 'human-web', 'active', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
    `);

    // session_events.seq is unique per session, but reusable across sessions.
    db.prepare(
      `insert into session_events (session_id, seq, type, version, timestamp)
       values ('s1', 1, 'turn/start', 1, '2026-08-21T00:00:00.000Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `insert into session_events (session_id, seq, type, version, timestamp)
           values ('s1', 1, 'turn/end', 1, '2026-08-21T00:00:01.000Z')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `insert into session_events (session_id, seq, type, version, timestamp)
           values ('s2', 1, 'turn/start', 1, '2026-08-21T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();

    const versions = db
      .prepare('select version from schema_migrations')
      .all() as Array<{ version: number }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(7);

    db.close();
  });

  it('is idempotent — running migration twice produces the same schema with no duplicate version records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    const tablesAfterFirst = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row: { name: string }) => row.name);

    // Second run must not throw
    migrateDatabase(db);

    const tablesAfterSecond = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row: { name: string }) => row.name);

    expect(tablesAfterSecond).toEqual(tablesAfterFirst);

    // insert or ignore prevents duplicate version records
    const versions = db
      .prepare('select version from schema_migrations')
      .all() as Array<{ version: number }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(7);

    db.close();
  });

  it('preserves existing data when migration runs on an already-migrated database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    // Insert sample data after first migration
    db.exec(`
      insert into demands (id, title, body, created_at)
        values ('d1', 'Test Demand', 'Body text', '2025-01-01T00:00:00Z');
      insert into projects (id, name, repo_path, created_at)
        values ('p1', 'Test Project', '/tmp/test-repo', '2025-01-01T00:00:00Z');
      insert into workflow_instances (id, project_id, demand_id, status, created_at, updated_at)
        values ('w1', 'p1', 'd1', 'running', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    `);

    // Run migration again — must not affect existing data
    migrateDatabase(db);

    const demands = db.prepare('select id, title, body from demands').all();
    expect(demands).toHaveLength(1);
    expect(demands[0]).toEqual({
      id: 'd1',
      title: 'Test Demand',
      body: 'Body text',
    });

    const projects = db.prepare('select id, name, repo_path from projects').all();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      id: 'p1',
      name: 'Test Project',
      repo_path: '/tmp/test-repo',
    });

    const instances = db
      .prepare('select id, project_id, demand_id, status from workflow_instances')
      .all();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toEqual({
      id: 'w1',
      project_id: 'p1',
      demand_id: 'd1',
      status: 'running',
    });

    db.close();
  });

  it('recovers from partial setup — creates missing tables when only dependency tables exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    // Simulate a partially-migrated state: only the root tables exist
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      );
      create table if not exists demands (
        id text primary key,
        title text not null,
        body text not null,
        created_at text not null
      );
      create table if not exists projects (
        id text primary key,
        name text not null,
        repo_path text not null,
        created_at text not null
      );
    `);

    // Insert minimal seed data so FK references in later tables are valid
    db.exec(`
      insert into demands (id, title, body, created_at)
        values ('d1', 'Demand', 'Body', '2025-01-01T00:00:00Z');
      insert into projects (id, name, repo_path, created_at)
        values ('p1', 'Project', '/tmp/repo', '2025-01-01T00:00:00Z');
    `);

    // Run migration — must create all remaining tables
    migrateDatabase(db);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row: { name: string }) => row.name)
      .sort();

    expect(tables).toEqual(
      expect.arrayContaining([
        'demands',
        'projects',
        'workflow_instances',
        'phases',
        'nodes',
        'artifacts',
        'role_runs',
        'gate_results',
        'human_decisions',
        'audit_events',
        'schema_migrations',
        'run_locks',
        'worktree_leases',
        'delivery_pull_requests',
        'run_provider_configs',
        'workspaces',
        'sessions',
        'session_events',
        'jobs',
        'projection_checkpoints',
      ]),
    );

    // Seed data must survive the migration
    const demandCount = db.prepare('select count(*) as cnt from demands').get() as {
      cnt: number;
    };
    expect(demandCount.cnt).toBe(1);

    const projectCount = db.prepare('select count(*) as cnt from projects').get() as {
      cnt: number;
    };
    expect(projectCount.cnt).toBe(1);

    // The schema version must be recorded
    const versions = db
      .prepare('select version from schema_migrations')
      .all() as Array<{ version: number }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(7);

    db.close();
  });

  it('adds missing columns to tables that were created under an older schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    // First create the full current schema
    migrateDatabase(db);

    // Confirm the columns added by addColumnIfMissing exist initially
    let cols = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'inputs')).toBe(true);
    expect(cols.some((c) => c.name === 'outputs')).toBe(true);

    let gateCols = db.pragma('table_info(gate_results)') as Array<{ name: string }>;
    expect(gateCols.some((c) => c.name === 'gate_key')).toBe(true);

    let wtCols = db.pragma('table_info(worktree_leases)') as Array<{ name: string }>;
    expect(wtCols.some((c) => c.name === 'base_head')).toBe(true);

    let wfCols = db.pragma('table_info(workflow_instances)') as Array<{ name: string }>;
    expect(wfCols.some((c) => c.name === 'plan_snapshot')).toBe(true);
    expect(wfCols.some((c) => c.name === 'plan_digest')).toBe(true);

    // Simulate an older schema: recreate tables without the columns that were
    // added via addColumnIfMissing. Foreign keys are temporarily disabled so
    // that referenced tables can be dropped and recreated.
    db.pragma('foreign_keys = OFF');

    db.exec(`
      drop table nodes;
      create table nodes (
        id text primary key,
        run_id text not null,
        phase_id text,
        role text not null,
        status text not null,
        gates text not null,
        dependencies text not null,
        created_at text not null,
        updated_at text not null
      );
    `);

    db.exec(`
      drop table gate_results;
      create table gate_results (
        id text primary key,
        run_id text not null,
        node_id text not null,
        gate_type text not null,
        status text not null,
        output_path text,
        duration_ms integer not null,
        retries integer not null,
        fix_attempt_id text,
        failure_classification text,
        created_at text not null
      );
    `);

    db.exec(`
      drop table worktree_leases;
      create table worktree_leases (
        id text primary key,
        run_id text not null,
        node_id text not null,
        role text not null,
        repo_path text not null,
        worktree_path text not null,
        branch_name text not null,
        created_at text not null,
        released_at text
      );
    `);

    db.exec(`
      drop table workflow_instances;
      create table workflow_instances (
        id text primary key,
        project_id text not null references projects(id),
        demand_id text not null references demands(id),
        status text not null,
        current_node_id text,
        created_at text not null,
        updated_at text not null
      );
    `);

    db.pragma('foreign_keys = ON');

    // Verify columns are now missing
    cols = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'inputs')).toBe(false);
    expect(cols.some((c) => c.name === 'outputs')).toBe(false);

    gateCols = db.pragma('table_info(gate_results)') as Array<{ name: string }>;
    expect(gateCols.some((c) => c.name === 'gate_key')).toBe(false);

    wtCols = db.pragma('table_info(worktree_leases)') as Array<{ name: string }>;
    expect(wtCols.some((c) => c.name === 'base_head')).toBe(false);

    wfCols = db.pragma('table_info(workflow_instances)') as Array<{ name: string }>;
    expect(wfCols.some((c) => c.name === 'plan_snapshot')).toBe(false);
    expect(wfCols.some((c) => c.name === 'plan_digest')).toBe(false);

    // Run migration again — addColumnIfMissing must restore the columns
    migrateDatabase(db);

    cols = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'inputs')).toBe(true);
    expect(cols.some((c) => c.name === 'outputs')).toBe(true);

    gateCols = db.pragma('table_info(gate_results)') as Array<{ name: string }>;
    expect(gateCols.some((c) => c.name === 'gate_key')).toBe(true);

    wtCols = db.pragma('table_info(worktree_leases)') as Array<{ name: string }>;
    expect(wtCols.some((c) => c.name === 'base_head')).toBe(true);

    wfCols = db.pragma('table_info(workflow_instances)') as Array<{ name: string }>;
    expect(wfCols.some((c) => c.name === 'plan_snapshot')).toBe(true);
    expect(wfCols.some((c) => c.name === 'plan_digest')).toBe(true);

    db.close();
  });

  it('P1-UX-02: adds sessions.acknowledged_at idempotently and defaults legacy rows to NULL (unacknowledged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    // Column exists on a fresh DB.
    let cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'acknowledged_at')).toBe(true);

    // Simulate a legacy sessions table created before the column existed, with
    // an existing failed row.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      drop table sessions;
      create table sessions (
        id text primary key,
        workspace_id text not null,
        title text,
        profile text not null,
        status text not null,
        run_id text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_sessions_run_id on sessions(run_id);
      insert into sessions
        (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
      values
        ('legacy_sess', 'ws_1', 'old', 'human-web', 'failed', 'run_legacy',
         '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    `);
    db.pragma('foreign_keys = ON');

    cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'acknowledged_at')).toBe(false);

    // Re-run migration: addColumnIfMissing restores the column without a table
    // rebuild, and the legacy failed row reads back NULL (unacknowledged).
    migrateDatabase(db);
    cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'acknowledged_at')).toBe(true);

    const legacy = db
      .prepare('select acknowledged_at from sessions where id = ?')
      .get('legacy_sess') as { acknowledged_at: string | null };
    expect(legacy.acknowledged_at).toBeNull();

    // Idempotent: running migration a third time does not fail or duplicate.
    migrateDatabase(db);
    cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'acknowledged_at')).toHaveLength(1);

    db.close();
  });

  it('P1-DATA-01: fresh database enforces foreign keys on session child tables and cascades deletions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    migrateDatabase(db);

    // Verify foreign key definitions on session child tables
    const eventsFk = db.pragma('foreign_key_list(session_events)') as Array<{ table: string; on_delete: string }>;
    expect(eventsFk.some((fk) => fk.table === 'sessions' && fk.on_delete === 'CASCADE')).toBe(true);

    const jobsFk = db.pragma('foreign_key_list(jobs)') as Array<{ table: string; on_delete: string }>;
    expect(jobsFk.some((fk) => fk.table === 'sessions' && fk.on_delete === 'CASCADE')).toBe(true);

    const checkFk = db.pragma('foreign_key_list(projection_checkpoints)') as Array<{ table: string; on_delete: string }>;
    expect(checkFk.some((fk) => fk.table === 'sessions' && fk.on_delete === 'CASCADE')).toBe(true);

    // Test rejecting orphan inserts
    expect(() =>
      db.prepare(`
        insert into session_events (session_id, seq, type, version, timestamp)
        values ('nonexistent_sess', 1, 'user/message', 1, '2026-08-21T00:00:00.000Z')
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(() =>
      db.prepare(`
        insert into jobs (id, session_id, kind, status, created_at, updated_at)
        values ('job_orphan', 'nonexistent_sess', 'workflow-run', 'queued', 'now', 'now')
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(() =>
      db.prepare(`
        insert into projection_checkpoints (session_id, projection_name, last_seq, updated_at)
        values ('nonexistent_sess', 'test_proj', 1, 'now')
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    // Test cascade delete when session is deleted
    db.exec(`
      insert into workspaces (id, root, created_at) values ('ws1', '/tmp', '2026-08-21T00:00:00.000Z');
      insert into sessions (id, workspace_id, profile, status, created_at, updated_at)
        values ('s_cascade', 'ws1', 'human-web', 'active', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
      insert into session_events (session_id, seq, type, version, timestamp)
        values ('s_cascade', 1, 'user/message', 1, '2026-08-21T00:00:00.000Z');
      insert into jobs (id, session_id, kind, status, created_at, updated_at)
        values ('job_cascade', 's_cascade', 'workflow-run', 'queued', 'now', 'now');
      insert into projection_checkpoints (session_id, projection_name, last_seq, updated_at)
        values ('s_cascade', 'test_proj', 1, 'now');
    `);

    expect(db.prepare('select count(*) as cnt from session_events where session_id = ?').get('s_cascade')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from jobs where session_id = ?').get('s_cascade')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from projection_checkpoints where session_id = ?').get('s_cascade')).toEqual({ cnt: 1 });

    // Delete session
    db.prepare('delete from sessions where id = ?').run('s_cascade');

    // Child rows must cascade delete
    expect(db.prepare('select count(*) as cnt from session_events where session_id = ?').get('s_cascade')).toEqual({ cnt: 0 });
    expect(db.prepare('select count(*) as cnt from jobs where session_id = ?').get('s_cascade')).toEqual({ cnt: 0 });
    expect(db.prepare('select count(*) as cnt from projection_checkpoints where session_id = ?').get('s_cascade')).toEqual({ cnt: 0 });

    db.close();
  });

  it('P1-DATA-01: migrates legacy v4 schema with orphan rows: quarantines orphans and enables FKs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-db-'));
    tempDirs.push(dir);
    const db = openTekonDatabase({ filename: join(dir, 'tekon.sqlite') });

    // Create legacy v4 schema without FKs on child tables
    db.exec(`
      create table schema_migrations (version integer primary key, applied_at text not null);
      insert into schema_migrations (version, applied_at) values (4, '2026-08-20T00:00:00.000Z');

      create table workspaces (id text primary key, root text not null, created_at text not null);
      create table sessions (id text primary key, workspace_id text not null, profile text not null, status text not null, run_id text, created_at text not null, updated_at text not null);

      create table session_events (
        id integer primary key autoincrement,
        session_id text not null,
        seq integer not null,
        type text not null,
        version integer not null,
        timestamp text not null,
        payload text not null default '{}',
        visibility text not null default 'ui-only',
        model_visible integer not null default 0,
        source_event_seqs text not null default '[]',
        correlation_id text,
        unique(session_id, seq)
      );

      create table jobs (
        id text primary key,
        session_id text not null,
        kind text not null,
        status text not null,
        owner text,
        lease text,
        abort_state text not null default 'none',
        checkpoint text,
        payload text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table projection_checkpoints (
        session_id text not null,
        projection_name text not null,
        last_seq integer not null,
        updated_at text not null,
        primary key (session_id, projection_name)
      );

      -- Valid parent session
      insert into workspaces (id, root, created_at) values ('ws1', '/tmp', 'now');
      insert into sessions (id, workspace_id, profile, status, created_at, updated_at)
        values ('s_valid', 'ws1', 'human-web', 'active', 'now', 'now');

      -- Valid child rows
      insert into session_events (session_id, seq, type, version, timestamp)
        values ('s_valid', 1, 'user/message', 1, 'now');
      insert into jobs (id, session_id, kind, status, created_at, updated_at)
        values ('j_valid', 's_valid', 'workflow-run', 'queued', 'now', 'now');
      insert into projection_checkpoints (session_id, projection_name, last_seq, updated_at)
        values ('s_valid', 'view', 1, 'now');

      -- Orphan rows (session does not exist)
      insert into session_events (session_id, seq, type, version, timestamp)
        values ('s_orphan', 1, 'user/message', 1, 'now');
      insert into jobs (id, session_id, kind, status, created_at, updated_at)
        values ('j_orphan', 's_orphan', 'workflow-run', 'queued', 'now', 'now');
      insert into projection_checkpoints (session_id, projection_name, last_seq, updated_at)
        values ('s_orphan', 'view', 1, 'now');
    `);

    // Run migration
    migrateDatabase(db);

    // Valid child rows are preserved in the main tables
    expect(db.prepare('select count(*) as cnt from session_events where session_id = ?').get('s_valid')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from jobs where session_id = ?').get('s_valid')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from projection_checkpoints where session_id = ?').get('s_valid')).toEqual({ cnt: 1 });

    // Main tables no longer have orphan rows
    expect(db.prepare('select count(*) as cnt from session_events where session_id = ?').get('s_orphan')).toEqual({ cnt: 0 });
    expect(db.prepare('select count(*) as cnt from jobs where session_id = ?').get('s_orphan')).toEqual({ cnt: 0 });
    expect(db.prepare('select count(*) as cnt from projection_checkpoints where session_id = ?').get('s_orphan')).toEqual({ cnt: 0 });

    // Orphan rows were quarantined
    expect(db.prepare('select count(*) as cnt from session_events_orphan_quarantine where session_id = ?').get('s_orphan')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from jobs_orphan_quarantine where session_id = ?').get('s_orphan')).toEqual({ cnt: 1 });
    expect(db.prepare('select count(*) as cnt from projection_checkpoints_orphan_quarantine where session_id = ?').get('s_orphan')).toEqual({ cnt: 1 });

    // FKs are active on the migrated tables
    expect(() =>
      db.prepare(`
        insert into session_events (session_id, seq, type, version, timestamp)
        values ('s_orphan_new', 1, 'user/message', 1, 'now')
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });
});
