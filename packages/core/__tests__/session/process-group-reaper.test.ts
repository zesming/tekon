import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  auditProcessGroupReaps,
  createProcessGroupReaper,
  PROCESS_START_TIME_TOLERANCE_MS,
} from '../../src/index.js';

describe('process group reaper', () => {
  it('reads the start time of a real process group leader and stops the whole group', async () => {
    const spawnedAt = Date.now();
    const leader = spawn(process.execPath, [
      '-e',
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
    ], { detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => leader.once('exit', resolve));
    try {
      const reaper = createProcessGroupReaper();
      const pgid = leader.pid!;
      const startTime = reaper.leaderStartTime(pgid);
      expect(startTime).not.toBeNull();
      expect(Math.abs(startTime! - spawnedAt)).toBeLessThanOrEqual(PROCESS_START_TIME_TOLERANCE_MS);

      reaper.signal(pgid, 'SIGTERM');
      await exited;
      // The grandchild was in the same group, so the group is empty now.
      await expect.poll(() => {
        try {
          process.kill(-pgid, 0);
          return 'alive';
        } catch {
          return 'gone';
        }
      }, { timeout: 5_000 }).toBe('gone');
      expect(reaper.leaderStartTime(pgid)).toBeNull();
    } finally {
      try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('writes what happened to each process group into the run audit', async () => {
    const appended: unknown[] = [];
    const record = auditProcessGroupReaps({ append: async (event) => { appended.push(event); } });
    const startedAt = '2026-11-13T00:00:01.000Z';
    await record({ jobId: 'job_1', runId: 'run_1', pgid: 4242, startedAt, outcome: 'start-time-mismatch' });
    await record({ jobId: 'job_2', runId: null, pgid: 4243, startedAt, outcome: 'signalled' });
    expect(appended).toEqual([{
      runId: 'run_1',
      type: 'job.process-group',
      payload: { jobId: 'job_1', pgid: 4242, startedAt, outcome: 'start-time-mismatch' },
    }]);
  });

  it('treats pid 0, 1 and negative numbers as no process group', () => {
    const reaper = createProcessGroupReaper();
    for (const pgid of [0, 1, -5]) expect(reaper.leaderStartTime(pgid)).toBeNull();
  });
});
