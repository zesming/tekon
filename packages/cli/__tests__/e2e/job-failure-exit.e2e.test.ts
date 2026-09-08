import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { openTekonDatabase } from '@tekon/core';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CLI task failure exit status through a real process', () => {
  it('returns non-zero when run job fails while the workflow remains running', async () => {
    const repo = createFixtureRepo();
    const child = spawn(
      process.execPath,
      [
        cliPath,
        'run',
        '验证任务失败退出码',
        '--template',
        'bugfix',
        '--agent',
        'mock',
        '--repo',
        repo,
      ],
      { cwd: repo },
    );
    const db = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
    try {
      const runId = await waitForRun(db);
      const target = db
        .prepare("select id, role from nodes where run_id=? and role='reviewer' limit 1")
        .get(runId) as { id: string; role: string } | undefined;
      expect(target).toBeDefined();
      injectAmbiguousLeases(db, repo, runId, target!.id, target!.role);

      const result = await collect(child);
      const workflowBeforeExit = db
        .prepare('select status from workflow_instances where id=?')
        .get(runId) as { status: string } | undefined;
      const failedJob = db
        .prepare(
          "select id, status from jobs where session_id in (select id from sessions where run_id=?) order by created_at desc limit 1",
        )
        .get(runId) as { id: string; status: string } | undefined;
      expect(
        {
          workflowStatus: workflowBeforeExit?.status,
          jobStatus: failedJob?.status,
        },
        describeRunState(db, runId),
      ).toEqual({ workflowStatus: 'running', jobStatus: 'failed' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`状态: running`);
      expect(result.stderr).toContain('jobStatus=failed');
      expect(result.stderr).toContain(`tekon log --run-id ${runId}`);
      expect(result.stderr).toContain(`jobId=${failedJob!.id}`);
    } finally {
      db.close();
      stopIfRunning(child);
    }
  }, 60_000);

  it('returns non-zero when resume job fails while the workflow remains running', async () => {
    const repo = createFixtureRepo();
    const child = spawn(
      process.execPath,
      [
        cliPath,
        'run',
        '准备恢复失败退出码',
        '--template',
        'bugfix',
        '--agent',
        'mock',
        '--repo',
        repo,
      ],
      { cwd: repo },
    );
    const db = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
    try {
      const runId = await waitForRun(db);
      const target = db
        .prepare("select id, role from nodes where run_id=? and role='reviewer' limit 1")
        .get(runId) as { id: string; role: string } | undefined;
      expect(target).toBeDefined();
      injectAmbiguousLeases(db, repo, runId, target!.id, target!.role);

      // Reuse the first real process to leave a failed job with a still-running
      // workflow. The bare resume command is then the second holder that must
      // surface its own failed job rather than deriving success from workflow
      // status alone.
      await collect(child);
      const workflowBeforeResume = db
        .prepare('select status from workflow_instances where id=?')
        .get(runId) as { status: string } | undefined;
      const failedJobBeforeResume = db
        .prepare(
          "select id, status from jobs where session_id in (select id from sessions where run_id=?) order by created_at desc limit 1",
        )
        .get(runId) as { id: string; status: string } | undefined;
      expect(
        {
          workflowStatus: workflowBeforeResume?.status,
          jobStatus: failedJobBeforeResume?.status,
        },
        describeRunState(db, runId),
      ).toEqual({ workflowStatus: 'running', jobStatus: 'failed' });

      const result = runCli(repo, ['resume', '--run-id', runId]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain('status=running');
      expect(result.stderr).toContain('jobStatus=failed');
      expect(result.stderr).toContain(`tekon log --run-id ${runId}`);
      const failedJob = db
        .prepare(
          "select id, status from jobs where session_id in (select id from sessions where run_id=?) order by created_at desc limit 1",
        )
        .get(runId) as { id: string; status: string } | undefined;
      expect(failedJob).toMatchObject({ status: 'failed' });
      expect(result.stderr).toContain(`jobId=${failedJob!.id}`);
    } finally {
      db.close();
      stopIfRunning(child);
    }
  }, 60_000);
});

function createFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-cli-job-failure-'));
  roots.push(repo);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }),
  );
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repo,
    stdio: 'pipe',
  });
  const initialized = runCli(repo, ['init']);
  expect(initialized.status, initialized.stderr).toBe(0);
  return repo;
}

function runCli(repo: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

async function waitForRun(db: ReturnType<typeof openTekonDatabase>): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = db
      .prepare('select id from workflow_instances order by created_at desc limit 1')
      .get() as { id: string } | undefined;
    if (row) return row.id;
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for workflow admission');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function describeRunState(
  db: ReturnType<typeof openTekonDatabase>,
  runId: string,
): string {
  const nodes = db
    .prepare(
      'select id, role, status from nodes where run_id=? order by created_at, id',
    )
    .all(runId);
  const gates = db
    .prepare(
      `select node_id, gate_type, gate_key, status, failure_classification
       from gate_results where run_id=? order by created_at, id`,
    )
    .all(runId);
  return `run state diagnostics: ${JSON.stringify({ nodes, gates })}`;
}

function injectAmbiguousLeases(
  db: ReturnType<typeof openTekonDatabase>,
  repo: string,
  runId: string,
  nodeId: string,
  role: string,
): void {
  const baseHead = (
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  ).trim();
  const insert = db.prepare(
    `insert into worktree_leases (
       id, run_id, node_id, role, repo_path, worktree_path,
       branch_name, base_head, created_at, released_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
  );
  for (const suffix of ['one', 'two']) {
    insert.run(
      `lease_injected_${suffix}`,
      runId,
      nodeId,
      role,
      repo,
      join(repo, '.tekon', 'worktrees', runId, `injected-${suffix}`),
      `tekon/${runId}/injected-${suffix}`,
      baseHead,
      new Date().toISOString(),
    );
  }
}

function collect(child: ChildProcess): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function stopIfRunning(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}
