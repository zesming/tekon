import { describe, expect, it } from 'vitest';

import {
  createSessionEventBus,
  type SessionEvent,
} from '../../src/index.js';

function makeEvent(sessionId: string, seq: number): SessionEvent {
  return {
    sessionId,
    seq,
    type: 'turn/start',
    version: 1,
    timestamp: new Date().toISOString(),
    payload: {},
    visibility: 'ui-only',
    modelVisible: false,
    sourceEventSeqs: [],
    correlationId: null,
  };
}

describe('session event bus', () => {
  it('delivers published events to subscribers', () => {
    const bus = createSessionEventBus();
    const received: SessionEvent[] = [];

    bus.subscribe('s1', (event) => received.push(event));
    bus.publish(makeEvent('s1', 1));

    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(1);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createSessionEventBus();
    const received: SessionEvent[] = [];

    const unsubscribe = bus.subscribe('s1', (event) => received.push(event));
    bus.publish(makeEvent('s1', 1));
    unsubscribe();
    bus.publish(makeEvent('s1', 2));

    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(1);
  });

  it('isolates subscribers by session id', () => {
    const bus = createSessionEventBus();
    const fromA: SessionEvent[] = [];
    const fromB: SessionEvent[] = [];

    bus.subscribe('s1', (event) => fromA.push(event));
    bus.subscribe('s2', (event) => fromB.push(event));
    bus.publish(makeEvent('s1', 1));
    bus.publish(makeEvent('s2', 1));

    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].sessionId).toBe('s1');
    expect(fromB[0].sessionId).toBe('s2');
  });

  it('supports multiple subscribers on the same session', () => {
    const bus = createSessionEventBus();
    const first: SessionEvent[] = [];
    const second: SessionEvent[] = [];

    bus.subscribe('s1', (event) => first.push(event));
    bus.subscribe('s1', (event) => second.push(event));
    bus.publish(makeEvent('s1', 1));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});
