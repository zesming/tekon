import { describe, expect, it } from 'vitest';

import {
  deriveSessionSidePanel,
  mergeSessionSnapshotIntoSidePanel,
} from '../../src/client/lib/session-side-panel.js';
import type { StreamEvent } from '../../src/client/lib/session-stream.js';

function event(
  type: string,
  payload: Record<string, unknown>,
  seq: number,
): StreamEvent {
  return {
    seq,
    type,
    timestamp: '2026-09-01T00:00:00.000Z',
    payload,
    visibility: 'ui-only',
    modelVisible: false,
    correlationId: null,
  };
}

describe('mergeSessionSnapshotIntoSidePanel', () => {
  const empty = deriveSessionSidePanel([]);

  it.each([
    ['active', 'running'],
    ['idle', 'paused'],
    ['awaiting-input', 'blocked'],
    ['awaiting-approval', 'awaiting-approval'],
    ['done', 'passed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ])('maps Session status %s to RunControls status %s', (status, expected) => {
    expect(
      mergeSessionSnapshotIntoSidePanel(empty, {
        runId: 'run_snapshot',
        status,
      }),
    ).toMatchObject({
      runId: 'run_snapshot',
      runStatus: expected,
    });
  });

  it('reveals pending approval from the authoritative snapshot before SSE catches up', () => {
    expect(
      mergeSessionSnapshotIntoSidePanel(empty, {
        runId: 'run_approval',
        status: 'awaiting-approval',
        actionKind: 'approval',
      }),
    ).toMatchObject({
      runId: 'run_approval',
      runStatus: 'awaiting-approval',
      hasPendingApproval: true,
    });
  });

  it('prefers newer live state over the point-in-time snapshot', () => {
    const live = deriveSessionSidePanel([
      event('workflow/started', { runId: 'run_live' }, 1),
      event('turn/end', { runId: 'run_live', status: 'passed' }, 2),
    ]);

    expect(
      mergeSessionSnapshotIntoSidePanel(live, {
        runId: 'run_snapshot',
        status: 'active',
      }),
    ).toMatchObject({
      runId: 'run_live',
      runStatus: 'passed',
    });
  });

  it('fails closed when neither source identifies a run state', () => {
    expect(mergeSessionSnapshotIntoSidePanel(empty, {})).toMatchObject({
      runId: null,
      runStatus: null,
      hasPendingApproval: false,
    });
  });
});
