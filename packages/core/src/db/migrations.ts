import type { TekonDatabase } from './connection.js';

const WORK_USABLE_SCHEMA_VERSION = 5;

function assertIntegrityOk(db: TekonDatabase): void {
  const rows = db.pragma('integrity_check') as unknown;
  const values = Array.isArray(rows)
    ? rows.map((row) =>
        typeof row === 'object' && row !== null
          ? String((row as Record<string, unknown>).integrity_check ?? '')
          : String(row),
      )
    : [String(rows)];
  if (values.some((value) => value !== 'ok')) {
    throw new Error(
      `SQLite integrity_check failed: ${values.join(', ')}`,
    );
  }
}


export function migrateDatabase(db: TekonDatabase): void {
  const migrate = db.transaction(() => {
    assertIntegrityOk(db);
    db.pragma('defer_foreign_keys = ON');

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
        kind text not null default 'workflow',
        allow_dirty_base integer not null default 0,
        plan_snapshot text,
        plan_digest text,
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
        gate_key text,
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
        base_head text,
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

      create table if not exists workspaces (
        id text primary key,
        root text not null,
        repo text,
        branch_policy text,
        permission_profile text,
        created_at text not null
      );

      create table if not exists sessions (
        id text primary key,
        workspace_id text not null references workspaces(id),
        title text,
        profile text not null,
        status text not null,
        run_id text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_sessions_run_id on sessions(run_id);

      create table if not exists session_events (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
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
      create index if not exists idx_session_events_session_seq
        on session_events(session_id, seq);

      create table if not exists jobs (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
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
      create index if not exists idx_jobs_status_created on jobs(status, created_at);

      create table if not exists projection_checkpoints (
        session_id text not null references sessions(id) on delete cascade,
        projection_name text not null,
        last_seq integer not null,
        updated_at text not null,
        primary key (session_id, projection_name)
      );
    `);

    addColumnIfMissing(db, 'nodes', 'inputs', "text not null default '[]'");
    addColumnIfMissing(db, 'nodes', 'outputs', "text not null default '[]'");
    addColumnIfMissing(db, 'nodes', 'node_order', 'integer not null default 0');
    addColumnIfMissing(db, 'gate_results', 'gate_key', 'text');
    addColumnIfMissing(db, 'worktree_leases', 'base_head', 'text');
    addColumnIfMissing(
      db,
      'workflow_instances',
      'kind',
      "text not null default 'workflow'",
    );
    addColumnIfMissing(
      db,
      'workflow_instances',
      'allow_dirty_base',
      'integer not null default 0',
    );
    addColumnIfMissing(
      db,
      'workflow_instances',
      'plan_snapshot',
      'text',
    );
    addColumnIfMissing(
      db,
      'workflow_instances',
      'plan_digest',
      'text',
    );

    addColumnIfMissing(db, 'sessions', 'run_id', 'text');
    addColumnIfMissing(db, 'sessions', 'acknowledged_at', 'text');

    rebuildSessionChildTablesIfMissingFk(db);

    db.prepare(
      'insert or ignore into schema_migrations (version, applied_at) values (?, ?)',
    ).run(WORK_USABLE_SCHEMA_VERSION, new Date().toISOString());

    assertIntegrityOk(db);
  });

  migrate();
}

function addColumnIfMissing(
  db: TekonDatabase,
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

function hasForeignKeyTo(
  db: TekonDatabase,
  table: string,
  targetTable: string,
): boolean {
  const fkList = db.prepare(`pragma foreign_key_list(${table})`).all() as Array<{
    table: string;
  }>;
  return fkList.some(
    (fk) => fk.table.toLowerCase() === targetTable.toLowerCase(),
  );
}

function rebuildSessionChildTablesIfMissingFk(db: TekonDatabase): void {
  // 1. session_events
  if (!hasForeignKeyTo(db, 'session_events', 'sessions')) {
    db.exec(`
      create table if not exists session_events_orphan_quarantine as
        select * from session_events where session_id not in (select id from sessions);

      create table session_events_new (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
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

      insert into session_events_new (id, session_id, seq, type, version, timestamp, payload, visibility, model_visible, source_event_seqs, correlation_id)
        select id, session_id, seq, type, version, timestamp, payload, visibility, model_visible, source_event_seqs, correlation_id
        from session_events
        where session_id in (select id from sessions);

      drop table session_events;
      alter table session_events_new rename to session_events;
      create index if not exists idx_session_events_session_seq
        on session_events(session_id, seq);
    `);
  }

  // 2. jobs
  if (!hasForeignKeyTo(db, 'jobs', 'sessions')) {
    db.exec(`
      create table if not exists jobs_orphan_quarantine as
        select * from jobs where session_id not in (select id from sessions);

      create table jobs_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
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

      insert into jobs_new (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
        select id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at
        from jobs
        where session_id in (select id from sessions);

      drop table jobs;
      alter table jobs_new rename to jobs;
      create index if not exists idx_jobs_status_created on jobs(status, created_at);
    `);
  }

  // 3. projection_checkpoints
  if (!hasForeignKeyTo(db, 'projection_checkpoints', 'sessions')) {
    db.exec(`
      create table if not exists projection_checkpoints_orphan_quarantine as
        select * from projection_checkpoints where session_id not in (select id from sessions);

      create table projection_checkpoints_new (
        session_id text not null references sessions(id) on delete cascade,
        projection_name text not null,
        last_seq integer not null,
        updated_at text not null,
        primary key (session_id, projection_name)
      );

      insert into projection_checkpoints_new (session_id, projection_name, last_seq, updated_at)
        select session_id, projection_name, last_seq, updated_at
        from projection_checkpoints
        where session_id in (select id from sessions);

      drop table projection_checkpoints;
      alter table projection_checkpoints_new rename to projection_checkpoints;
    `);
  }
}
