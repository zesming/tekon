import { describe, expect, it } from 'vitest';

import { STATUS_LABELS, sessionBadgeStatus, statusLabel } from '../../src/client/lib/status-labels.js';

describe('statusLabel', () => {
  it('maps every known run, session and job status to a Chinese label', () => {
    expect(statusLabel('running')).toBe('运行中');
    expect(statusLabel('passed')).toBe('已通过');
    expect(statusLabel('awaiting-approval')).toBe('等待审批');
    expect(statusLabel('cancelling')).toBe('取消中');
  });

  it('gives an interrupted run the recovery label, not the old "awaiting input" wording', () => {
    expect(statusLabel('interrupted')).toBe('已中断，需恢复');
    expect(STATUS_LABELS.interrupted).not.toContain('待输入');
  });

  it('falls back to the raw status for unknown values', () => {
    expect(statusLabel('plugin-defined')).toBe('plugin-defined');
  });
});

describe('sessionBadgeStatus', () => {
  it('keeps the actionable approval label even though the run itself is paused at a gate', () => {
    expect(
      sessionBadgeStatus({ status: 'awaiting-approval', runStatus: 'paused' }),
    ).toBe('awaiting-approval');
  });

  it('shows the run status for an interrupted run instead of the misleading session status', () => {
    expect(
      sessionBadgeStatus({ status: 'awaiting-input', runStatus: 'interrupted' }),
    ).toBe('interrupted');
    expect(
      sessionBadgeStatus({ status: 'awaiting-input', runStatus: 'blocked' }),
    ).toBe('blocked');
  });

  it('shows the run status for an ordinary run-backed session', () => {
    expect(
      sessionBadgeStatus({ status: 'active', runStatus: 'running' }),
    ).toBe('running');
    expect(
      sessionBadgeStatus({ status: 'done', runStatus: 'passed' }),
    ).toBe('passed');
  });

  it('falls back to the session status when no run is attached', () => {
    expect(sessionBadgeStatus({ status: 'idle', runStatus: null })).toBe('idle');
    expect(sessionBadgeStatus({ status: 'active' })).toBe('active');
  });

  it('keeps a failed session truthful when its run row is still settling', () => {
    // A crash can leave the workflow 'running' while the session already failed.
    expect(
      sessionBadgeStatus({ status: 'failed', runStatus: 'running' }),
    ).toBe('failed');
  });
});
