import { execFileSync } from 'node:child_process';

import type { AuditLogger } from '../audit/logger.js';

/** Signals the detached process groups a reclaimed job left behind. */
export interface ProcessGroupReaper {
  /** Start time (epoch ms) of the process whose pid is `pgid`, or null if none. */
  leaderStartTime(pgid: number): number | null;
  signal(pgid: number, signal: NodeJS.Signals): void;
}

/** `ps` reports start times to the second. */
export const PROCESS_START_TIME_TOLERANCE_MS = 2_000;

export type ProcessGroupReapOutcome =
  | 'signalled'
  | 'killed'
  | 'escalation-skipped'
  | 'start-time-mismatch'
  | 'leader-gone';

export interface ProcessGroupReapRecord {
  jobId: string;
  runId: string | null;
  pgid: number;
  startedAt: string;
  outcome: ProcessGroupReapOutcome;
}

/** Records each outcome as a `job.process-group` audit event of its run. */
export function auditProcessGroupReaps(
  audit: Pick<AuditLogger, 'append'>,
): (record: ProcessGroupReapRecord) => Promise<void> {
  return async ({ runId, jobId, pgid, startedAt, outcome }) => {
    if (!runId) return;
    await audit.append({ runId, type: 'job.process-group', payload: { jobId, pgid, startedAt, outcome } });
  };
}

export function createProcessGroupReaper(): ProcessGroupReaper {
  return {
    leaderStartTime(pgid) {
      if (!Number.isInteger(pgid) || pgid <= 1) return null;
      try {
        // execFileSync blocks the event loop (up to the 5s timeout); ps is
        // normally sub-millisecond, and reclaim is a cold path by design.
        const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pgid)], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        }).trim();
        const startedAt = Date.parse(output);
        return Number.isFinite(startedAt) ? startedAt : null;
      } catch {
        // ps exits non-zero when no such process exists.
        return null;
      }
    },
    signal(pgid, signal) {
      if (!Number.isInteger(pgid) || pgid <= 1) return;
      try {
        process.kill(-pgid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}
