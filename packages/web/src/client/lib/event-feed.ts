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

function asText(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
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
        // Phase 2 M3: synthesized from artifact metadata, not real model prose.
        synthetic: true,
      };
    case 'tool/call': {
      const name = asText(p, 'name', 'tool') ?? 'tool';
      return { ...base, kind: 'tool', title: `调用 ${name}`, body: asText(p, 'command', 'summary') };
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
    case 'gate/result': {
      const gate = asText(p, 'gateType', 'gateKey') ?? 'gate';
      const status = asText(p, 'status') ?? '';
      return { ...base, kind: 'governance', title: `门禁 ${gate} · ${status}`.trim() };
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
    case 'workflow/node-started':
    case 'workflow/node-ended':
    case 'workflow/started': {
      const nodeId = asText(p, 'nodeId');
      const status = asText(p, 'status');
      return {
        ...base,
        kind: 'governance',
        title: `${event.type}${nodeId ? ` ${nodeId}` : ''}${status ? ` · ${status}` : ''}`,
      };
    }
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
