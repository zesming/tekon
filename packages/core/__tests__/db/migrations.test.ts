import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateDatabase, openDonkeyDatabase } from '../../src/index.js';

describe('database migrations', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates all phase 1 persistence tables and configures sqlite pragmas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'donkey-db-'));
    tempDirs.push(dir);
    const db = openDonkeyDatabase({ filename: join(dir, 'donkey.sqlite') });

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
});
