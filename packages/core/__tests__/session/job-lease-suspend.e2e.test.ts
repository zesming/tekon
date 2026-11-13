import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateDatabase, openTekonDatabase } from '../../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jobRow(filename: string, jobId: string) {
  const db = openTekonDatabase({ filename });
  try {
    return db.prepare('select status, owner from jobs where id = ?').get(jobId) as
      | { status: string; owner: string | null }
      | undefined;
  } finally {
    db.close();
  }
}

describe('job lease across a suspended process', () => {
  // Relies on this child being the only runner polling the database: with a
  // second live process, a suspended owner and a dead one look the same.
  it('keeps its own job after SIGSTOP longer than the lease TTL and SIGCONT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-lease-suspend-'));
    roots.push(root);
    const filename = join(root, 'tekon.sqlite');
    const release = join(root, 'release');
    const setupDb = openTekonDatabase({ filename });
    migrateDatabase(setupDb);
    setupDb.close();

    const src = new URL('../../src/', import.meta.url).href;
    const loader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const source = `
      import { existsSync } from 'node:fs';
      import * as core from ${JSON.stringify(`${src}index.ts`)};
      const db = core.openTekonDatabase({ filename: ${JSON.stringify(filename)} });
      const queue = core.createWriteQueue();
      const sessions = core.createSessionEventStore(db, queue);
      const jobs = core.createJobRepository(db, queue);
      const runner = core.createJobRunner({
        jobs, sessions, bus: core.createSessionEventBus(), registry: core.createSubprocessRegistry(),
        pollIntervalMs: 20, heartbeatMs: 200, leaseTtlMs: 1000, workerId: 'worker_suspended',
        executor: { async execute(ctx) {
          process.send({ started: ctx.job.id });
          while (!existsSync(${JSON.stringify(release)})) {
            if (ctx.signal.aborted) return { status: 'failed' };
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return { status: 'done' };
        } },
      });
      const workspace = await sessions.getOrCreateDefaultWorkspace(${JSON.stringify(root)});
      const session = await sessions.createSession({
        workspaceId: workspace.id, title: null, profile: 'cli', runId: 'run_suspend',
      });
      const job = await runner.enqueue({ sessionId: session.id, kind: 'workflow-run' });
      runner.start();
      for (;;) {
        const current = await jobs.get(job.id);
        if (current && !['queued', 'running', 'paused', 'cancelling'].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await runner.stop();
      db.close();
      process.disconnect();
    `;
    const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', source], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const jobId = await new Promise<string>((resolve, reject) => {
        child.on('message', (message: { started?: string }) => {
          if (message.started) resolve(message.started);
        });
        child.once('exit', () => reject(new Error(`child exited early: ${stderr}`)));
      });

      child.kill('SIGSTOP');
      await sleep(2_500);
      child.kill('SIGCONT');
      await sleep(500);
      expect(jobRow(filename, jobId)).toEqual({ status: 'running', owner: 'worker_suspended' });

      writeFileSync(release, 'go');
      expect(await exited, stderr).toBe(0);
      expect(jobRow(filename, jobId)?.status).toBe('done');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
