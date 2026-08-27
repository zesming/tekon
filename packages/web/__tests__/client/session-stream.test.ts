import { describe, expect, it } from 'vitest';

import {
  createSseParser,
  mergeEventsBySeq,
  lastEventId,
  type StreamEvent,
} from '../../src/client/lib/session-stream.js';

// Phase 3 3a: pure-logic tests for the SSE client. The network/reconnect layer
// is exercised by the 3b Playwright e2e (needs a page to host the stream); here
// we lock the frame parser (half-packets, heartbeats, all legal line endings)
// and the event reducer (dedupe, seq-monotonic, Last-Event-ID) which carry the
// correctness.

describe('SSE frame parser', () => {
  it('parses a complete id/event/data frame', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'id: 5\nevent: turn/start\ndata: {"seq":5,"type":"turn/start"}\n\n',
    );
    expect(frames).toEqual([
      { id: '5', event: 'turn/start', data: '{"seq":5,"type":"turn/start"}' },
    ]);
  });

  it('reassembles a frame split across two chunks (half-packet)', () => {
    const parser = createSseParser();
    expect(parser.push('id: 7\nevent: step/')).toEqual([]);
    const frames = parser.push('start\ndata: {"seq":7}\n\n');
    expect(frames).toEqual([
      { id: '7', event: 'step/start', data: '{"seq":7}' },
    ]);
  });

  it('parses multiple frames in one chunk and keeps a trailing partial buffered', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'id: 1\ndata: {"seq":1}\n\nid: 2\ndata: {"seq":2}\n\nid: 3\ndata: par',
    );
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    // The trailing partial is buffered, not emitted until its blank line.
    expect(parser.push('tial"}\n\n')).toEqual([{ id: '3', data: 'partial"}' }]);
  });

  it('ignores heartbeat/comment lines (": ping")', () => {
    const parser = createSseParser();
    expect(parser.push(': ping\n\n')).toEqual([]);
    const frames = parser.push('id: 9\ndata: {"seq":9}\n\n');
    expect(frames.map((f) => f.id)).toEqual(['9']);
  });

  it('tolerates CRLF line endings', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'id: 4\r\nevent: tool/call\r\ndata: {"seq":4}\r\n\r\n',
    );
    expect(frames).toEqual([
      { id: '4', event: 'tool/call', data: '{"seq":4}' },
    ]);
  });

  it('tolerates bare CR line endings', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'id: 6\revent: tool/result\rdata: {"seq":6}\r\r',
    );
    expect(frames).toEqual([
      { id: '6', event: 'tool/result', data: '{"seq":6}' },
    ]);
  });

  it('normalizes a CRLF pair split across network chunks', () => {
    const parser = createSseParser();
    expect(parser.push('id: 8\r')).toEqual([]);
    expect(parser.push('\nevent: step/end\r')).toEqual([]);
    expect(parser.push('\ndata: {"seq":8}\r')).toEqual([]);
    expect(parser.push('\n\r')).toEqual([]);
    expect(parser.push('\n')).toEqual([
      { id: '8', event: 'step/end', data: '{"seq":8}' },
    ]);
  });
});

describe('event reducer (mergeEventsBySeq)', () => {
  const ev = (seq: number, type = 't'): StreamEvent => ({
    seq,
    type,
    timestamp: '2026-08-24T00:00:00.000Z',
    payload: {},
    visibility: 'model',
    modelVisible: false,
    correlationId: null,
  });

  it('appends new events in seq order', () => {
    const merged = mergeEventsBySeq([ev(1), ev(2)], [ev(3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('dedupes by seq (replay overlap after reconnect)', () => {
    // 0..k then a reconnect replays k..end — the overlap at k must not double.
    const merged = mergeEventsBySeq([ev(1), ev(2), ev(3)], [ev(3), ev(4)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('sorts out-of-order arrivals by seq', () => {
    const merged = mergeEventsBySeq([], [ev(3), ev(1), ev(2)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the first occurrence on duplicate seq', () => {
    const merged = mergeEventsBySeq([ev(1, 'first')], [ev(1, 'second')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].type).toBe('first');
  });
});

describe('lastEventId', () => {
  it('returns the max seq seen for reconnect resumption', () => {
    expect(lastEventId([{ seq: 1 }, { seq: 5 }, { seq: 3 }] as StreamEvent[])).toBe(5);
  });

  it('returns 0 for an empty stream (full replay from the start)', () => {
    expect(lastEventId([])).toBe(0);
  });
});
