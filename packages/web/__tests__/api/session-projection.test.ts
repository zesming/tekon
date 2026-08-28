import { describe, expect, it } from 'vitest';

import {
  deriveSessionAction,
  effectiveLastActivityAt,
  sortSessionsByActivity,
} from '../../src/server/api/routers/session.js';

describe('Session list projection', () => {
  it('uses the durable session update when it is newer than the latest projected event', () => {
    expect(
      effectiveLastActivityAt({
        lastActivityAt: '2026-08-28T10:00:00.000Z',
        updatedAt: '2026-08-28T10:05:00.000Z',
      }),
    ).toBe('2026-08-28T10:05:00.000Z');
  });

  it('keeps a newer event timestamp when it is newer than the session row', () => {
    expect(
      effectiveLastActivityAt({
        lastActivityAt: '2026-08-28T10:06:00.000Z',
        updatedAt: '2026-08-28T10:05:00.000Z',
      }),
    ).toBe('2026-08-28T10:06:00.000Z');
  });

  it('orders sessions by effective activity with deterministic fallbacks', () => {
    const sessions = [
      {
        id: 'sess_old_event_new_status',
        createdAt: '2026-08-28T09:00:00.000Z',
        updatedAt: '2026-08-28T10:10:00.000Z',
        lastActivityAt: '2026-08-28T09:30:00.000Z',
      },
      {
        id: 'sess_new_event',
        createdAt: '2026-08-28T09:10:00.000Z',
        updatedAt: '2026-08-28T09:10:00.000Z',
        lastActivityAt: '2026-08-28T10:05:00.000Z',
      },
    ];

    expect(sortSessionsByActivity(sessions).map((session) => session.id)).toEqual([
      'sess_old_event_new_status',
      'sess_new_event',
    ]);
  });

  it('does not promise an in-session text input for a blocked workflow', () => {
    expect(deriveSessionAction('awaiting-input')).toEqual({
      needsAction: true,
      actionKind: 'input',
    });
    // The transport value remains compatible, while the product label is
    // deliberately rendered as a recovery action rather than “待输入”.
  });
});
