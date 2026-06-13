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
      ]),
    );
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

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
    expect(versions[0].version).toBe(3);

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
    expect(versions[0].version).toBe(3);

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

    db.pragma('foreign_keys = ON');

    // Verify columns are now missing
    cols = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'inputs')).toBe(false);
    expect(cols.some((c) => c.name === 'outputs')).toBe(false);

    gateCols = db.pragma('table_info(gate_results)') as Array<{ name: string }>;
    expect(gateCols.some((c) => c.name === 'gate_key')).toBe(false);

    wtCols = db.pragma('table_info(worktree_leases)') as Array<{ name: string }>;
    expect(wtCols.some((c) => c.name === 'base_head')).toBe(false);

    // Run migration again — addColumnIfMissing must restore the columns
    migrateDatabase(db);

    cols = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'inputs')).toBe(true);
    expect(cols.some((c) => c.name === 'outputs')).toBe(true);

    gateCols = db.pragma('table_info(gate_results)') as Array<{ name: string }>;
    expect(gateCols.some((c) => c.name === 'gate_key')).toBe(true);

    wtCols = db.pragma('table_info(worktree_leases)') as Array<{ name: string }>;
    expect(wtCols.some((c) => c.name === 'base_head')).toBe(true);

    db.close();
  });
});
