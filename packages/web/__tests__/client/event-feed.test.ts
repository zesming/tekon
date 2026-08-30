import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventFeed } from "../../src/client/components/sessions/EventFeed.js";
import { describe, expect, it } from 'vitest';

import {
  computeEventWindow,
  DEFAULT_EVENT_WINDOW,
  describeEvent,
  groupEventsByTurn,
  type FeedRow,
} from '../../src/client/lib/event-feed.js';
import type { StreamEvent } from '../../src/client/lib/session-stream.js';

// Phase 3 3b: the event→feed-row mapping is the correctness surface of the
// feed (15+ event types → a continuous narrative). Pure function, unit-tested;
// the React feed component is thin glue verified by the 3b Playwright e2e.

function ev(
  type: string,
  payload: Record<string, unknown> = {},
  over: Partial<StreamEvent> = {},
): StreamEvent {
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
      ev(
        'assistant/message',
        { text: 'Produced review-report' },
        { modelVisible: true },
      ),
    );
    expect(row.kind).toBe('message');
    expect(row.author).toBe('assistant');
    expect(row.synthetic).toBe(true);
  });

  it('honors an explicit non-synthetic assistant message', () => {
    const row = describeEvent(
      ev(
        'assistant/message',
        { text: 'provider answer', synthetic: false },
        { modelVisible: true },
      ),
    );
    expect(row.synthetic).toBe(false);
  });

  it('pairs tool/call with a tool kind and surfaces the tool name', () => {
    const row = describeEvent(ev('tool/call', { name: 'build', nodeId: 'rd' }));
    expect(row.kind).toBe('tool');
    expect(row.title.toLowerCase()).toContain('build');
  });

  it('renders tool/result and flags a truncated payload', () => {
    const row = describeEvent(
      ev(
        'tool/result',
        { _truncated: true, bytes: 2_000_000 },
        { modelVisible: true },
      ),
    );
    expect(row.kind).toBe('tool');
    expect(row.truncated).toBe(true);
  });

  it('renders step and turn lifecycle markers', () => {
    expect(describeEvent(ev('step/start', { nodeId: 'rd' })).kind).toBe('step');
    expect(
      describeEvent(ev('step/end', { nodeId: 'rd', status: 'passed' })).kind,
    ).toBe('step');
    expect(describeEvent(ev('turn/start')).kind).toBe('turn');
    expect(describeEvent(ev('turn/end')).kind).toBe('turn');
  });

  it('renders job and automation lifecycle events as human-readable governance rows', () => {
    const workflow = describeEvent(
      ev('job/status', { kind: 'workflow-resume', status: 'running' }),
    );
    expect(workflow.kind).toBe('governance');
    expect(workflow.title).toContain('执行任务');
    expect(workflow.title).not.toBe('job/status');

    // job/status carries the job KIND: automation jobs get their own labels so
    // a readiness/delivery projection job is never mislabeled as "执行任务".
    const readinessJob = describeEvent(
      ev('job/status', { kind: 'readiness-evaluate', status: 'running' }),
    );
    expect(readinessJob.kind).toBe('governance');
    expect(readinessJob.title).toContain('准备度检查');
    const deliveryJob = describeEvent(
      ev('job/status', { kind: 'delivery-auto-prepare', status: 'running' }),
    );
    expect(deliveryJob.kind).toBe('governance');
    expect(deliveryJob.title).toContain('交付材料准备');

    const readiness = describeEvent(ev('readiness/evaluated', { ready: true }));
    expect(readiness.title).toContain('通过');
    const delivery = describeEvent(ev('delivery/prepared'));
    expect(delivery.title).toContain('交付材料');
  });

  it('renders governance events (gate/artifact/approval/node) as governance rows', () => {
    expect(
      describeEvent(ev('gate/result', { gateType: 'build', status: 'passed' }))
        .kind,
    ).toBe('governance');
    expect(
      describeEvent(ev('artifact/created', { artifactType: 'code-changes' }))
        .kind,
    ).toBe('governance');
    expect(
      describeEvent(ev('approval/requested', { decisionId: 'd1' })).kind,
    ).toBe('governance');
    expect(
      describeEvent(
        ev('workflow/node-ended', { nodeId: 'rd', status: 'passed' }),
      ).kind,
    ).toBe('governance');
  });

  it('flags agent/error as an error row', () => {
    const row = describeEvent(ev('agent/error', { message: 'boom' }));
    expect(row.kind).toBe('error');
    expect(row.body).toContain('boom');
  });

  // S2: agent lifecycle events must have real labels, not fall through to the
  // raw-type 'generic' row (which reads like debug noise).
  it('labels agent/status with the run status instead of a generic row', () => {
    const row = describeEvent(
      ev('agent/status', { runId: 'run_1', status: 'passed' }),
    );
    expect(row.kind).toBe('step');
    expect(row.title).toContain('passed');
    expect(row.title).not.toBe('agent/status');
  });

  it('labels cancel-requested and cancelled as governance rows', () => {
    const requested = describeEvent(
      ev('agent/cancel-requested', { runId: 'run_1' }),
    );
    expect(requested.kind).toBe('governance');
    expect(requested.title).not.toBe('agent/cancel-requested');

    const cancelled = describeEvent(ev('agent/cancelled', { runId: 'run_1' }));
    expect(cancelled.kind).toBe('governance');
    expect(cancelled.title).not.toBe('agent/cancelled');
  });

  it('renders agent/steered as user-authored steering prose', () => {
    const row = describeEvent(
      ev('agent/steered', { text: 'focus on the parser' }),
    );
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

describe("computeEventWindow (T6 event feed DOM windowing)", () => {
  it("returns all events and zero hidden count when total <= window size", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 }));
    const result = computeEventWindow(events, false, 250);

    expect(result.hasEarlierEvents).toBe(false);
    expect(result.hiddenEarlierCount).toBe(0);
    expect(result.visibleEvents).toHaveLength(100);
    expect(result.visibleEvents[0].seq).toBe(1);
    expect(result.visibleEvents[99].seq).toBe(100);
  });

  it("handles empty events list", () => {
    const result = computeEventWindow([], false, 250);

    expect(result.hasEarlierEvents).toBe(false);
    expect(result.hiddenEarlierCount).toBe(0);
    expect(result.visibleEvents).toEqual([]);
  });

  it("handles exact boundary at window size (250 items)", () => {
    const events = Array.from({ length: 250 }, (_, i) => ({ seq: i + 1 }));
    const result = computeEventWindow(events, false, 250);

    expect(result.hasEarlierEvents).toBe(false);
    expect(result.hiddenEarlierCount).toBe(0);
    expect(result.visibleEvents).toHaveLength(250);
  });

  it("windows to latest 250 and counts hidden earlier events when total > 250 (unexpanded)", () => {
    const events = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1 }));
    const result = computeEventWindow(events, false, 250);

    expect(result.hasEarlierEvents).toBe(true);
    expect(result.hiddenEarlierCount).toBe(50);
    expect(result.visibleEvents).toHaveLength(250);
    expect(result.visibleEvents[0].seq).toBe(51);
    expect(result.visibleEvents[249].seq).toBe(300);
  });

  it("returns all events and clears hidden count when expanded is true", () => {
    const events = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1 }));
    const result = computeEventWindow(events, true, 250);

    expect(result.hasEarlierEvents).toBe(false);
    expect(result.hiddenEarlierCount).toBe(0);
    expect(result.visibleEvents).toHaveLength(300);
    expect(result.visibleEvents[0].seq).toBe(1);
    expect(result.visibleEvents[299].seq).toBe(300);
  });

  it("uses DEFAULT_EVENT_WINDOW (250) by default", () => {
    expect(DEFAULT_EVENT_WINDOW).toBe(250);
    const events = Array.from({ length: 251 }, (_, i) => ({ seq: i + 1 }));
    const result = computeEventWindow(events, false);

    expect(result.hasEarlierEvents).toBe(true);
    expect(result.hiddenEarlierCount).toBe(1);
    expect(result.visibleEvents).toHaveLength(250);
    expect(result.visibleEvents[0].seq).toBe(2);
  });

  it("respects custom window size", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1 }));
    const unexpanded = computeEventWindow(events, false, 3);

    expect(unexpanded.hasEarlierEvents).toBe(true);
    expect(unexpanded.hiddenEarlierCount).toBe(7);
    expect(unexpanded.visibleEvents).toHaveLength(3);
    expect(unexpanded.visibleEvents[0].seq).toBe(8);
    expect(unexpanded.visibleEvents[2].seq).toBe(10);

    const expanded = computeEventWindow(events, true, 3);
    expect(expanded.hasEarlierEvents).toBe(false);
    expect(expanded.hiddenEarlierCount).toBe(0);
    expect(expanded.visibleEvents).toHaveLength(10);
  });
});

describe("EventFeed earlier history button rendering (MUST-1 + MUST-2)", () => {
  it("renders enabled '加载更早历史' button when externalHasEarlier is true and not at limit", () => {
    const events: StreamEvent[] = [
      ev("user/message", { text: "hello" }, { seq: 1 }),
    ];
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events,
        hasEarlier: true,
        reachedEarlierLimit: false,
        isLoadingEarlier: false,
        onLoadEarlier: () => {},
      }),
    );
    expect(html).toContain("加载更早历史");
    expect(html).not.toContain("disabled");
  });

  it("renders disabled '已加载最早历史' button when reachedEarlierLimit is true", () => {
    const events: StreamEvent[] = [
      ev("user/message", { text: "hello" }, { seq: 1 }),
    ];
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events,
        hasEarlier: true,
        reachedEarlierLimit: true,
        isLoadingEarlier: false,
        onLoadEarlier: () => {},
      }),
    );
    expect(html).toContain("已加载最早历史");
    expect(html).toContain("disabled");
  });

  it("renders disabled '正在加载更早历史…' button when isLoadingEarlier is true", () => {
    const events: StreamEvent[] = [
      ev("user/message", { text: "hello" }, { seq: 1 }),
    ];
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events,
        hasEarlier: true,
        reachedEarlierLimit: false,
        isLoadingEarlier: true,
        onLoadEarlier: () => {},
      }),
    );
    expect(html).toContain("正在加载更早历史…");
    expect(html).toContain("disabled");
  });

  it("preserves in-memory DOM unfold button when external pagination is not active", () => {
    const events: StreamEvent[] = Array.from({ length: 300 }, (_, i) =>
      ev("user/message", { text: `msg ${i + 1}` }, { seq: i + 1 }),
    );
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events,
      }),
    );
    expect(html).toContain("展开更早的 50 条事件");
  });
});
