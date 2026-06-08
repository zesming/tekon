import type { DonkeyDatabase } from './connection.js';

const WORK_USABLE_SCHEMA_VERSION = 3;

export function migrateDatabase(db: DonkeyDatabase): void {
  const migrate = db.transaction(() => {
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      );

      create table if not exists demands (
        id text primary key,
        title text not null,
        body text not null,
        source text,
        created_at text not null
      );

      create table if not exists projects (
        id text primary key,
        name text not null,
        repo_path text not null,
        created_at text not null
      );

      create table if not exists workflow_instances (
        id text primary key,
        project_id text not null references projects(id),
        demand_id text not null references demands(id),
        status text not null,
        current_node_id text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists phases (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        name text not null,
        status text not null,
        phase_order integer not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists nodes (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        phase_id text references phases(id) on delete set null,
        role text not null,
        status text not null,
        inputs text not null default '[]',
        outputs text not null default '[]',
        gates text not null,
        dependencies text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists artifacts (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        node_id text not null references nodes(id) on delete cascade,
        type text not null,
        version integer not null,
        path text not null,
        sha256 text not null,
        size_bytes integer not null,
        summary text,
        created_at text not null,
        unique(run_id, node_id, type, version)
      );

      create table if not exists role_runs (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        node_id text not null references nodes(id) on delete cascade,
        role text not null,
        status text not null,
        started_at text not null,
        completed_at text,
        interrupted_at text
      );

      create table if not exists gate_results (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        node_id text not null references nodes(id) on delete cascade,
        gate_type text not null,
        status text not null,
        output_path text,
        duration_ms integer not null,
        retries integer not null,
        fix_attempt_id text,
        failure_classification text,
        created_at text not null
      );

      create table if not exists human_decisions (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        node_id text not null references nodes(id) on delete cascade,
        gate_result_id text references gate_results(id) on delete set null,
        status text not null,
        actor text,
        note text,
        created_at text not null,
        decided_at text
      );

      create table if not exists audit_events (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        type text not null,
        payload text not null,
        prev_hash text,
        hash text not null,
        created_at text not null
      );

      create table if not exists run_locks (
        run_id text primary key references workflow_instances(id) on delete cascade,
        locked_by text not null,
        locked_at text not null
      );

      create table if not exists worktree_leases (
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

      create table if not exists delivery_pull_requests (
        id text primary key,
        run_id text not null references workflow_instances(id) on delete cascade,
        branch text not null,
        base_branch text not null,
        title text not null,
        body_path text,
        remote_name text,
        remote_url text,
        status text not null,
        pr_url text,
        approved_by text,
        approved_at text,
        branch_pushed_at text,
        pr_created_at text,
        failure_stage text,
        last_error text,
        attempt_count integer not null,
        created_at text not null,
        updated_at text not null,
        unique(run_id)
      );

      create table if not exists run_provider_configs (
        run_id text primary key references workflow_instances(id) on delete cascade,
        provider text not null,
        config_summary text not null,
        created_at text not null
      );
    `);

    addColumnIfMissing(db, 'nodes', 'inputs', "text not null default '[]'");
    addColumnIfMissing(db, 'nodes', 'outputs', "text not null default '[]'");

    db.prepare(
      'insert or ignore into schema_migrations (version, applied_at) values (?, ?)',
    ).run(WORK_USABLE_SCHEMA_VERSION, new Date().toISOString());
  });

  migrate();
}

function addColumnIfMissing(
  db: DonkeyDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}
