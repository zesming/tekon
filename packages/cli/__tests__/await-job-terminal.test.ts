import { describe, expect, it, vi } from 'vitest';

import type { DurableJobRunner, JobRepository, JobStatus } from '@tekon/core';

import { awaitJobTerminal } from '../src/lib/session-context.js';

// 4c M2 (design §4.3): awaitJobTerminal is the CLI holder's observation loop.
// While the run's job executes in THIS process, the loop reads its own job row
// and relays cross-process governance requests into the runner's in-process
// APIs — the mechanism that makes `tekon pause`/`tekon cancel` from another
// process actually take effect on the holder (cross-owner persistence alone is
// inert; the engine only checks in-process signal/pauseFlags at node
// boundaries). These tests pin that relay directly.

/**
 * A jobs stub whose `get` walks a scripted status sequence (one entry per
 * poll), holding on the last entry. Only the fields awaitJobTerminal reads are
 * populated.
 */
function scriptedJobs(jobId: string, statuses: JobStatus[]): JobRepository {
  let call = 0;
  return {
    async get(id: string) {
      if (id !== jobId) return null;
      const idx = Math.min(call, statuses.length - 1);
      call += 1;
      return {
        id: jobId,
        sessionId: 'session_x',
        kind: 'workflow-run',
        status: statuses[idx]!,
        owner: 'worker_other',
        lease: null,
        abortState: 'none',
        checkpoint: null,
        payload: {},
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      };
    },
  } as unknown as JobRepository;
}

function spyRunner(): DurableJobRunner & {
  requestPause: ReturnType<typeof vi.fn>;
  requestCancel: ReturnType<typeof vi.fn>;
} {
  return {
    requestPause: vi.fn(async () => {}),
    requestCancel: vi.fn(async () => {}),
  } as unknown as DurableJobRunner & {
    requestPause: ReturnType<typeof vi.fn>;
    requestCancel: ReturnType<typeof vi.fn>;
  };
}

describe('awaitJobTerminal (4c M2 observation loop)', () => {
  it('returns immediately on a terminal status without relaying any request', async () => {
    const jobs = scriptedJobs('job_done', ['done']);
    const runner = spyRunner();

    const status = await awaitJobTerminal({
      jobs,
      jobRunner: runner,
      jobId: 'job_done',
      pollIntervalMs: 1,
    });

    expect(status).toBe('done');
    expect(runner.requestPause).not.toHaveBeenCalled();
    expect(runner.requestCancel).not.toHaveBeenCalled();
  });

  it('relays an observed cross-process paused status to requestPause, then returns on terminal', async () => {
    // paused (observe) → done (terminal). The holder must call requestPause
    // (in-process pauseFlags only, never abort) and keep polling — pause is not
    // terminal.
    const jobs = scriptedJobs('job_paused', ['paused', 'done']);
    const runner = spyRunner();

    const status = await awaitJobTerminal({
      jobs,
      jobRunner: runner,
      jobId: 'job_paused',
      pollIntervalMs: 1,
    });

    expect(status).toBe('done');
    expect(runner.requestPause).toHaveBeenCalledWith('job_paused');
    expect(runner.requestCancel).not.toHaveBeenCalled();
  });

  it('relays an observed cross-process cancelling status to requestCancel, then returns on cancelled', async () => {
    const jobs = scriptedJobs('job_cancel', ['cancelling', 'cancelled']);
    const runner = spyRunner();

    const status = await awaitJobTerminal({
      jobs,
      jobRunner: runner,
      jobId: 'job_cancel',
      pollIntervalMs: 1,
    });

    expect(status).toBe('cancelled');
    expect(runner.requestCancel).toHaveBeenCalledWith(
      'job_cancel',
      expect.stringContaining('cross-process'),
    );
    expect(runner.requestPause).not.toHaveBeenCalled();
  });

  it('throws when the job row disappears (jobs.get → null)', async () => {
    const jobs = scriptedJobs('other', ['running']);
    const runner = spyRunner();

    await expect(
      awaitJobTerminal({
        jobs,
        jobRunner: runner,
        jobId: 'job_missing',
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/job not found/u);
  });
});
