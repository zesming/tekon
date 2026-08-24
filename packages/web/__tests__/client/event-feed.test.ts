import { describe, expect, it } from 'vitest';

import {
  describeEvent,
  groupEventsByTurn,
  type FeedRow,
} from '../../src/client/lib/event-feed.js';
import type { StreamEvent } from '../../src/client/lib/session-stream.js';

// Phase 3 3b: the event→feed-row mapping is the correctness surface of the
// feed (15+ event types → a continuous narrative). Pure function, unit-tested;
// the React feed component is thin glue verified by the 3b Playwright e2e.

function ev(type: string, payload: Record<string, unknown> = {}, over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    seq: 1,
    type,
    timestamp: '2026-08-24T00:00:00.000Z',
    payload,
    visibility: 'model',
    modelVisible: false,
    correlationId: null,
    ...over,
  };
}

describe('describeEvent', () => {
  it('renders a user message as user-authored prose', () => {
    const row = describeEvent(ev('user/message', { text: 'fix the bug' }));
    expect(row.kind).toBe('message');
    expect(row.author).toBe('user');
    expect(row.body).toContain('fix the bug');
    expect(row.synthetic).toBe(false);
  });

  it('marks an assistant message as synthetic (metadata summary, not model prose)', () => {
    // Phase 2 M3: assistant/message is synthesized from artifact metadata, not
    // real model output. The feed must label it so a reader is not misled.
    const row = describeEvent(
      ev('assistant/message', { text: 'Produced review-report' }, { modelVisible: true }),
    );
    expect(row.kind).toBe('message');
    expect(row.author).toBe('assistant');
    expect(row.synthetic).toBe(true);
  });

  it('pairs tool/call with a tool kind and surfaces the tool name', () => {
    const row = describeEvent(ev('tool/call', { name: 'build', nodeId: 'rd' }));
    expect(row.kind).toBe('tool');
    expect(row.title.toLowerCase()).toContain('build');
  });

  it('renders tool/result and flags a truncated payload', () => {
    const row = describeEvent(
      ev('tool/result', { _truncated: true, bytes: 2_000_000 }, { modelVisible: true }),
    );
    expect(row.kind).toBe('tool');
    expect(row.truncated).toBe(true);
  });

  it('renders step and turn lifecycle markers', () => {
    expect(describeEvent(ev('step/start', { nodeId: 'rd' })).kind).toBe('step');
    expect(describeEvent(ev('step/end', { nodeId: 'rd', status: 'passed' })).kind).toBe('step');
    expect(describeEvent(ev('turn/start')).kind).toBe('turn');
    expect(describeEvent(ev('turn/end')).kind).toBe('turn');
  });

  it('renders governance events (gate/artifact/approval/node) as governance rows', () => {
    expect(describeEvent(ev('gate/result', { gateType: 'build', status: 'passed' })).kind).toBe('governance');
    expect(describeEvent(ev('artifact/created', { artifactType: 'code-changes' })).kind).toBe('governance');
    expect(describeEvent(ev('approval/requested', { decisionId: 'd1' })).kind).toBe('governance');
    expect(describeEvent(ev('workflow/node-ended', { nodeId: 'rd', status: 'passed' })).kind).toBe('governance');
  });

  it('flags agent/error as an error row', () => {
    const row = describeEvent(ev('agent/error', { message: 'boom' }));
    expect(row.kind).toBe('error');
    expect(row.body).toContain('boom');
  });

  // S2: agent lifecycle events must have real labels, not fall through to the
  // raw-type 'generic' row (which reads like debug noise).
  it('labels agent/status with the run status instead of a generic row', () => {
    const row = describeEvent(ev('agent/status', { runId: 'run_1', status: 'passed' }));
    expect(row.kind).toBe('step');
    expect(row.title).toContain('passed');
    expect(row.title).not.toBe('agent/status');
  });

  it('labels cancel-requested and cancelled as governance rows', () => {
    const requested = describeEvent(ev('agent/cancel-requested', { runId: 'run_1' }));
    expect(requested.kind).toBe('governance');
    expect(requested.title).not.toBe('agent/cancel-requested');

    const cancelled = describeEvent(ev('agent/cancelled', { runId: 'run_1' }));
    expect(cancelled.kind).toBe('governance');
    expect(cancelled.title).not.toBe('agent/cancelled');
  });

  it('renders agent/steered as user-authored steering prose', () => {
    const row = describeEvent(ev('agent/steered', { text: 'focus on the parser' }));
    expect(row.kind).toBe('message');
    expect(row.author).toBe('user');
    expect(row.body).toContain('focus on the parser');
  });

  it('degrades an unknown/future event type to a generic row without throwing', () => {
    const row = describeEvent(ev('some/future-type', { foo: 1 }));
    expect(row.kind).toBe('generic');
    expect(row.title).toContain('some/future-type');
  });
});

describe('groupEventsByTurn', () => {
  it('groups events into turns bounded by turn/start..turn/end', () => {
    const events: StreamEvent[] = [
      ev('session/created', {}, { seq: 1 }),
      ev('turn/start', {}, { seq: 2 }),
      ev('step/start', { nodeId: 'rd' }, { seq: 3 }),
      ev('tool/call', { name: 'build' }, { seq: 4 }),
      ev('turn/end', {}, { seq: 5 }),
      ev('turn/start', {}, { seq: 6 }),
      ev('step/start', { nodeId: 'qa' }, { seq: 7 }),
    ];
    const groups = groupEventsByTurn(events);
    // A pre-turn group (session/created) + two turns.
    expect(groups).toHaveLength(3);
    expect(groups[0].rows.map((r: FeedRow) => r.seq)).toEqual([1]);
    expect(groups[1].rows.map((r: FeedRow) => r.seq)).toEqual([2, 3, 4, 5]);
    expect(groups[2].rows.map((r: FeedRow) => r.seq)).toEqual([6, 7]);
  });

  it('preserves seq order within a group', () => {
    const events: StreamEvent[] = [
      ev('turn/start', {}, { seq: 10 }),
      ev('assistant/message', { text: 'x' }, { seq: 12 }),
      ev('tool/call', { name: 'lint' }, { seq: 11 }),
    ];
    const groups = groupEventsByTurn(events);
    expect(groups[0].rows.map((r) => r.seq)).toEqual([10, 11, 12]);
  });
});
