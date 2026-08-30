import { describe, expect, it, vi } from 'vitest';

import {
  createJobRepository,
  createJobRunner,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type JobExecutor,
} from '../../src/index.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('condition not met before timeout');
    }
    await sleep(5);
  }
}

describe('job runner stop poll barrier', () => {
  it('waits for an already-entered claim poll before snapshotting pending work', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    let executionCount = 0;
    const executor: JobExecutor = {
      async execute() {
        executionCount += 1;
        return { status: 'done' };
      },
    };
    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor,
      pollIntervalMs: 1,
      workerId: 'worker_stop_barrier',
    });

    try {
      const workspace =
        await sessions.getOrCreateDefaultWorkspace('/tmp/stop-barrier');
      const session = await sessions.createSession({
        workspaceId: workspace.id,
        title: 'stop barrier',
        profile: 'human-web',
        runId: 'run_stop_barrier',
      });
      const job = await runner.enqueue({
        sessionId: session.id,
        kind: 'workflow-run',
      });

      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let markClaimEntered!: () => void;
      const claimEntered = new Promise<void>((resolve) => {
        markClaimEntered = resolve;
      });
      const originalClaimNext = jobs.claimNext.bind(jobs);
      vi.spyOn(jobs, 'claimNext').mockImplementation(async (...args) => {
        markClaimEntered();
        await claimGate;
        return originalClaimNext(...args);
      });

      runner.start();
      await claimEntered;

      let stopResolved = false;
      const stopPromise = runner.stop().then(() => {
        stopResolved = true;
      });
      await sleep(20);

      // The running poll has not returned from claimNext yet. stop() must wait
      // for that poll instead of snapshotting an empty pending set and returning.
      expect(stopResolved).toBe(false);

      releaseClaim();
      await stopPromise;
      await waitFor(async () => (await jobs.get(job.id))?.status === 'done');

      expect(executionCount).toBe(1);
      expect(await jobs.get(job.id)).toMatchObject({ status: 'done' });

      // No queued interval callback may claim or spawn more work after stop.
      await sleep(20);
      expect(executionCount).toBe(1);
    } finally {
      await runner.stop();
      db.close();
    }
  });
});
