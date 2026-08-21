import { createHash, randomUUID } from 'node:crypto';

import type { TekonDatabase } from '../db/connection.js';
import type { WriteQueue } from '../db/write-queue.js';
import type { AuditEvent } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';

export interface AuditLogger {
  append(input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AuditEvent>;
  verify(
    runId: string,
  ): Promise<{ valid: true } | { valid: false; brokenEventId: string }>;
}

export function createAuditLogger(options: {
  repositories: TekonRepositories;
  /**
   * When both `db` and `writeQueue` are provided (web composition root),
   * append runs read-hash-insert as a single writeQueue task operating on
   * `db` directly. It must not call `repositories.appendAuditEvent` — that
   * would enqueue another task on the same serial queue and self-deadlock
   * (S6/MF4). When omitted, the legacy two-phase path is used (CLI).
   */
  db?: TekonDatabase;
  writeQueue?: WriteQueue;
}): AuditLogger {
  const directWrite = options.db !== undefined && options.writeQueue !== undefined;

  return {
    async append(input) {
      if (directWrite) {
        const db = options.db as TekonDatabase;
        const writeQueue = options.writeQueue as WriteQueue;
        return writeQueue.enqueue(() => {
          const lastRow = db
            .prepare(
              `select hash, created_at from audit_events
               where run_id = ?
               order by created_at desc, id desc
               limit 1`,
            )
            .get(input.runId) as
            | { hash: string; created_at: string }
            | undefined;
          const createdAt =
            input.createdAt ??
            nextMonotonicTimestamp(lastRow?.created_at);
          const eventWithoutHash = {
            id: `event_${randomUUID()}`,
            runId: input.runId,
            type: input.type,
            payload: input.payload,
            prevHash: lastRow?.hash ?? null,
            createdAt,
          };
          const event: AuditEvent = {
            ...eventWithoutHash,
            hash: hashEvent(eventWithoutHash),
          };
          db.prepare(
            `insert into audit_events (id, run_id, type, payload, prev_hash, hash, created_at)
             values (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            event.id,
            event.runId,
            event.type,
            JSON.stringify(event.payload),
            event.prevHash,
            event.hash,
            event.createdAt,
          );
          return event;
        });
      }

      const events = await options.repositories.listAuditEvents(input.runId);
      const prevHash = events.at(-1)?.hash ?? null;
      const createdAt =
        input.createdAt ?? nextMonotonicTimestamp(events.at(-1)?.createdAt);
      const eventWithoutHash = {
        id: `event_${randomUUID()}`,
        runId: input.runId,
        type: input.type,
        payload: input.payload,
        prevHash,
        createdAt,
      };
      const event: AuditEvent = {
        ...eventWithoutHash,
        hash: hashEvent(eventWithoutHash),
      };
      return options.repositories.appendAuditEvent(event);
    },

    async verify(runId) {
      const events = await options.repositories.listAuditEvents(runId);
      let prevHash: string | null = null;

      for (const event of events) {
        if (event.prevHash !== prevHash) {
          return { valid: false, brokenEventId: event.id };
        }

        const expectedHash = hashEvent({
          id: event.id,
          runId: event.runId,
          type: event.type,
          payload: event.payload,
          prevHash: event.prevHash,
          createdAt: event.createdAt,
        });

        if (event.hash !== expectedHash) {
          return { valid: false, brokenEventId: event.id };
        }

        prevHash = event.hash;
      }

      return { valid: true };
    },
  };
}

function nextMonotonicTimestamp(previous?: string): string {
  const now = Date.now();
  if (!previous) {
    return new Date(now).toISOString();
  }

  const previousMs = Date.parse(previous);
  return new Date(Math.max(now, previousMs + 1)).toISOString();
}

function hashEvent(event: Omit<AuditEvent, 'hash'>): string {
  return createHash('sha256')
    .update(
      stableStringify({
        id: event.id,
        runId: event.runId,
        type: event.type,
        payload: event.payload,
        prevHash: event.prevHash,
        createdAt: event.createdAt,
      }),
    )
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
