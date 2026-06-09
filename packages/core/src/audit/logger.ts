import { createHash, randomUUID } from 'node:crypto';

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
}): AuditLogger {
  return {
    async append(input) {
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
