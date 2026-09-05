import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '../../src/client/lib/relative-time.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('uses the supplied clock for deterministic minute, hour, and day boundaries', () => {
    expect(formatRelativeTime('2026-08-28T11:59:01.000Z', NOW)).toBe('刚刚');
    expect(formatRelativeTime('2026-08-28T11:59:00.000Z', NOW)).toBe(
      '1分钟前',
    );
    expect(formatRelativeTime('2026-08-28T11:00:00.000Z', NOW)).toBe(
      '1小时前',
    );
    expect(formatRelativeTime('2026-08-27T12:00:00.000Z', NOW)).toBe(
      '1天前',
    );
    expect(formatRelativeTime('2026-08-21T12:00:00.000Z', NOW)).toBe(
      '7天前',
    );
  });

  it('treats a future timestamp as just now instead of exposing a negative value', () => {
    expect(formatRelativeTime('2026-08-28T12:01:00.000Z', NOW)).toBe('刚刚');
  });

  it('fails visibly for malformed input or an invalid clock', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('not-a-date');
    expect(
      formatRelativeTime('2026-08-28T11:00:00.000Z', Number.NaN),
    ).toBe('2026-08-28T11:00:00.000Z');
  });
});
