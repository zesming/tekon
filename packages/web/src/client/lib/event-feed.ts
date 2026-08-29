import type { StreamEvent } from './session-stream.js';

/**
 * Phase 3 3b: map raw session events to feed rows and group them into turns.
 *
 * This is the correctness surface of the event feed — a continuous narrative
 * built from ~15 typed event types. Kept pure so it can be unit-tested in the
 * node env; the React feed component renders these descriptors.
 */

export type FeedRowKind =
  | 'message'
  | 'tool'
  | 'step'
  | 'turn'
  | 'governance'
  | 'error'
  | 'generic';

export interface FeedRow {
  seq: number;
  kind: FeedRowKind;
  /** Short label for the row header. */
  title: string;
  /** Optional multi-line body (message text, error detail, tool output). */
  body?: string;
  /** Message author, when kind === 'message'. */
  author?: 'user' | 'assistant';
  /** True when the content is a synthesized summary, not real model prose. */
  synthetic: boolean;
  /** True when the server truncated the payload (spill deferred, phase 2b). */
  truncated: boolean;
  timestamp: string;
  type: string;
}

export interface FeedGroup {
  /** turn/start seq that opened this group, or null for pre-turn events. */
  turnSeq: number | null;
  rows: FeedRow[];
}

function asText(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isTruncated(payload: Record<string, unknown>): boolean {
  return payload._truncated === true;
}

/** Map one event to a feed row. Never throws; unknown types degrade to generic. */
export function describeEvent(event: StreamEvent): FeedRow {
  const p = event.payload ?? {};
  const base = {
    seq: event.seq,
    synthetic: false,
    truncated: isTruncated(p),
    timestamp: event.timestamp,
    type: event.type,
  };

  switch (event.type) {
    case 'user/message':
      return {
        ...base,
        kind: 'message',
        author: 'user',
        title: '你 You',
        body: asText(p, 'text', 'message') ?? '',
      };
    case 'assistant/message':
      return {
        ...base,
        kind: 'message',
        author: 'assistant',
        title: 'Agent',
        body: asText(p, 'text', 'message') ?? '',
        // Old events omit the flag and remain conservatively labelled as
        // synthesized; providers with a documented final-output boundary emit
        // synthetic:false.
        synthetic: p.synthetic !== false,
      };
    case 'tool/call': {
      const name = asText(p, 'name', 'tool') ?? 'tool';
      return {
        ...base,
        kind: 'tool',
        title: `调用 ${name}`,
        body: asText(p, 'command', 'summary'),
      };
    }
    case 'tool/result': {
      const name = asText(p, 'name', 'tool');
      return {
        ...base,
        kind: 'tool',
        title: name ? `结果 ${name}` : '工具结果',
        body: base.truncated ? undefined : asText(p, 'output', 'summary'),
      };
    }
    case 'step/start':
    case 'step/end': {
      const nodeId = asText(p, 'nodeId') ?? '';
      const status = asText(p, 'status');
      const verb = event.type === 'step/start' ? '开始' : '结束';
      return {
        ...base,
        kind: 'step',
        title: `步骤${verb} ${nodeId}${status ? ` · ${status}` : ''}`.trim(),
      };
    }
    case 'turn/start':
      return { ...base, kind: 'turn', title: '回合开始' };
    case 'turn/end':
      return { ...base, kind: 'turn', title: '回合结束' };
    case 'agent/error':
      return {
        ...base,
        kind: 'error',
        title: 'Agent 错误',
        body: asText(p, 'message', 'error') ?? '',
      };
    // Agent lifecycle (S2). Without these, terminal/cancel signals fall through
    // to the raw-type 'generic' row, which reads like debug noise in the feed.
    case 'agent/status': {
      const status = asText(p, 'status');
      return {
        ...base,
        kind: 'step',
        title: status ? `运行状态 · ${status}` : '运行状态',
      };
    }
    case 'agent/cancel-requested':
      return { ...base, kind: 'governance', title: '已请求取消' };
    case 'agent/cancelled':
      return { ...base, kind: 'governance', title: '已取消' };
    case 'agent/steered':
      // NOTE: agent/steered is declared in the session contract but has no
      // emitter yet — the payload field name (text/message/guidance) is a
      // forward-looking guess. asText degrades to an empty body if none match;
      // revisit when a steer path actually emits this event.
      return {
        ...base,
        kind: 'message',
        author: 'user',
        title: '你 You · 转向',
        body: asText(p, 'text', 'message', 'guidance') ?? '',
      };
    case 'job/status': {
      const kind = asText(p, 'kind') ?? 'job';
      const status = asText(p, 'status') ?? 'updated';
      const label =
        kind === 'readiness-evaluate'
          ? '准备度检查'
          : kind === 'delivery-auto-prepare'
            ? '交付材料准备'
            : '执行任务';
      return {
        ...base,
        kind: 'governance',
        title: `${label} · ${status}`,
      };
    }
    case 'readiness/evaluated': {
      const result =
        p.ready === true ? '通过' : p.ready === false ? '未通过' : '已更新';
      return {
        ...base,
        kind: 'governance',
        title: `交付准备度 · ${result}`,
      };
    }
    case 'delivery/prepared':
      return { ...base, kind: 'governance', title: '交付材料已准备' };
    case 'gate/result': {
      const gate = asText(p, 'gateType', 'gateKey') ?? 'gate';
      const status = asText(p, 'status') ?? '';
      return {
        ...base,
        kind: 'governance',
        title: `门禁 ${gate} · ${status}`.trim(),
      };
    }
    case 'artifact/created': {
      const kind = asText(p, 'artifactType', 'type') ?? 'artifact';
      return { ...base, kind: 'governance', title: `产物 ${kind}` };
    }
    case 'approval/requested':
      return { ...base, kind: 'governance', title: '待人工审批' };
    case 'approval/decided': {
      const decision = asText(p, 'decision', 'status') ?? '';
      return { ...base, kind: 'governance', title: `审批 ${decision}`.trim() };
    }
    case 'workflow/node-started': {
      const nodeId = asText(p, 'nodeId');
      return {
        ...base,
        kind: 'governance',
        title: nodeId ? `节点开始 · ${nodeId}` : '节点开始',
      };
    }
    case 'workflow/node-ended': {
      const nodeId = asText(p, 'nodeId');
      const status = asText(p, 'status');
      return {
        ...base,
        kind: 'governance',
        title: `节点结束${nodeId ? ` · ${nodeId}` : ''}${status ? ` · ${status}` : ''}`,
      };
    }
    case 'workflow/started':
      return {
        ...base,
        kind: 'governance',
        title: p.resumed === true ? '受控交付已恢复' : '受控交付已开始',
      };
    case 'session/created':
      return { ...base, kind: 'governance', title: '会话已创建' };
    default:
      // Unknown / future event type — show it rather than dropping it.
      return { ...base, kind: 'generic', title: event.type };
  }
}

/**
 * Group events into turns. A turn begins at a `turn/start` and includes every
 * event up to and including its `turn/end`. Events before the first turn/start
 * (e.g. session/created, the opening user/message) form a leading group with
 * turnSeq === null. Rows within each group are sorted by seq.
 */
export function groupEventsByTurn(events: readonly StreamEvent[]): FeedGroup[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const groups: FeedGroup[] = [];
  let current: FeedGroup | null = null;

  for (const event of sorted) {
    if (event.type === 'turn/start') {
      current = { turnSeq: event.seq, rows: [] };
      groups.push(current);
    } else if (!current) {
      // Pre-turn leading group.
      current = { turnSeq: null, rows: [] };
      groups.push(current);
    }
    current.rows.push(describeEvent(event));
    if (event.type === 'turn/end') {
      // Close the turn: the next event opens a fresh group.
      current = null;
    }
  }
  return groups;
}

export const DEFAULT_EVENT_WINDOW = 250;

export interface EventWindowState<T = unknown> {
  hasEarlierEvents: boolean;
  hiddenEarlierCount: number;
  visibleEvents: T[];
}

/**
 * Pure calculation for DOM windowing of long event feeds (T6).
 * - total <= windowSize or expanded: all events visible, no earlier events.
 * - total > windowSize and !expanded: only latest windowSize events visible,
 *   hiddenEarlierCount = total - windowSize.
 */
export function computeEventWindow<T>(
  events: readonly T[],
  expanded: boolean = false,
  windowSize: number = DEFAULT_EVENT_WINDOW,
): EventWindowState<T> {
  const total = events.length;
  const hasEarlierEvents = total > windowSize && !expanded;
  const hiddenEarlierCount = hasEarlierEvents ? total - windowSize : 0;
  const visibleEvents = hasEarlierEvents
    ? events.slice(-windowSize)
    : [...events];

  return {
    hasEarlierEvents,
    hiddenEarlierCount,
    visibleEvents,
  };
}
