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

export function appendAuditEventTxn(
  db: TekonDatabase,
  input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt?: string;
  },
): AuditEvent {
  if (!db.inTransaction) {
    throw new Error('AUDIT_TRANSACTION_REQUIRED');
  }
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
  const createdAt = nextMonotonicTimestamp(lastRow?.created_at, input.createdAt);
  const eventWithoutHash = {
    id: `event_${randomUUID()}`,
    runId: input.runId,
    type: input.type,
    // Hash the persisted JSON value so optional fields cannot break verification.
    payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>,
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
}

export function createAuditLogger(options: {
  repositories: TekonRepositories;
  /**
   * Explicit handles must belong to the same database/queue as repositories.
   * The default construction uses the repositories' shared handles.
   */
  db?: TekonDatabase;
  writeQueue?: WriteQueue;
}): AuditLogger {
  const resolvedDb = options.db ?? options.repositories.getDatabase();
  const resolvedWriteQueue = options.writeQueue ?? options.repositories.getWriteQueue();

  return {
    async append(input) {
      return resolvedWriteQueue.enqueue(() => resolvedDb.transaction(
        () => appendAuditEventTxn(resolvedDb, input),
      ).immediate());
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

function nextMonotonicTimestamp(previous?: string, requested?: string): string {
  const requestedMs = requested === undefined ? Date.now() : Date.parse(requested);
  const previousMs = previous === undefined ? -Infinity : Date.parse(previous);
  if (!Number.isFinite(requestedMs) || Number.isNaN(previousMs)) {
    throw new Error('INVALID_AUDIT_TIMESTAMP');
  }
  return new Date(Math.max(requestedMs, previousMs + 1)).toISOString();
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
