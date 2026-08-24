import { describe, expect, it } from 'vitest';

import {
  deriveSessionSidePanel,
  type SidePanelState,
} from '../../src/client/lib/session-side-panel.js';
import type { StreamEvent } from '../../src/client/lib/session-stream.js';

// Phase 3 3c: the right-rail derivation (run status, pending approvals, cards)
// is the correctness surface. Pure function over the event stream; the React
// panel renders it. inline approval reuses DecisionCard + gate.approve/reject
// (governance semantics unchanged, §0.3).

function ev(type: string, payload: Record<string, unknown> = {}, seq = 1): StreamEvent {
  return {
    seq,
    type,
    timestamp: '2026-08-24T00:00:00.000Z',
    payload,
    visibility: 'model',
    modelVisible: false,
    correlationId: null,
  };
}

describe('deriveSessionSidePanel', () => {
  it('extracts the runId from workflow/agent events', () => {
    const state = deriveSessionSidePanel([
      ev('workflow/started', { runId: 'run_42' }, 1),
    ]);
    expect(state.runId).toBe('run_42');
  });

  it('tracks a pending approval from approval/requested', () => {
    const state = deriveSessionSidePanel([
      ev('workflow/started', { runId: 'run_1' }, 1),
      ev('approval/requested', { runId: 'run_1', decisionId: 'd1', nodeId: 'rd' }, 2),
    ]);
    expect(state.pendingDecisionIds).toEqual(['d1']);
    expect(state.hasPendingApproval).toBe(true);
  });

  it('clears a pending approval once it is decided', () => {
    const state = deriveSessionSidePanel([
      ev('approval/requested', { runId: 'run_1', decisionId: 'd1' }, 2),
      ev('approval/decided', { runId: 'run_1', decisionId: 'd1', decision: 'approved' }, 5),
    ]);
    expect(state.pendingDecisionIds).toEqual([]);
    expect(state.hasPendingApproval).toBe(false);
  });

  it('keeps other pending approvals when one is decided', () => {
    const state = deriveSessionSidePanel([
      ev('approval/requested', { runId: 'run_1', decisionId: 'd1' }, 2),
      ev('approval/requested', { runId: 'run_1', decisionId: 'd2' }, 3),
      ev('approval/decided', { runId: 'run_1', decisionId: 'd1' }, 6),
    ]);
    expect(state.pendingDecisionIds).toEqual(['d2']);
  });

  it('derives run status from the latest lifecycle signal', () => {
    // A terminal turn/end with a failed step should not mask an explicit status.
    const running = deriveSessionSidePanel([
      ev('workflow/started', { runId: 'run_1' }, 1),
      ev('step/start', { nodeId: 'rd' }, 2),
    ]);
    expect(running.runStatus).toBe('running');

    const paused = deriveSessionSidePanel([
      ev('workflow/started', { runId: 'run_1' }, 1),
      ev('approval/requested', { runId: 'run_1', decisionId: 'd1' }, 2),
    ]);
    // A pending approval means the run is awaiting a human decision.
    expect(paused.runStatus).toBe('awaiting-approval');
  });

  it('collects artifact/tool/error cards in order', () => {
    const state = deriveSessionSidePanel([
      ev('artifact/created', { artifactType: 'code-changes', artifactId: 'a1' }, 3),
      ev('tool/result', { name: 'build' }, 4),
      ev('agent/error', { message: 'boom' }, 5),
    ]);
    expect(state.cards.map((c) => c.kind)).toEqual(['artifact', 'tool', 'error']);
  });

  it('returns an empty, safe state for no events', () => {
    const state: SidePanelState = deriveSessionSidePanel([]);
    expect(state.runId).toBeNull();
    expect(state.hasPendingApproval).toBe(false);
    expect(state.cards).toEqual([]);
    expect(state.runStatus).toBeNull();
  });
});
