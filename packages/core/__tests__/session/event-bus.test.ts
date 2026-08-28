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

  // 4e: subscribeAll is the global subscription for automation listeners
  // (auto-prepare delivery, readiness evaluation). Unlike per-session
  // subscribe, it receives every session's events.
  it('subscribeAll receives events from every session', () => {
    const bus = createSessionEventBus();
    const received: SessionEvent[] = [];

    bus.subscribeAll((event) => received.push(event));
    bus.publish(makeEvent('s1', 1));
    bus.publish(makeEvent('s2', 1));

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('subscribeAll stops delivering after its unsubscribe', () => {
    const bus = createSessionEventBus();
    const received: SessionEvent[] = [];

    const unsubscribe = bus.subscribeAll((event) => received.push(event));
    bus.publish(makeEvent('s1', 1));
    unsubscribe();
    bus.publish(makeEvent('s1', 2));

    expect(received).toHaveLength(1);
  });

  // 4e: the bus is a synchronous fan-out with no exception isolation today —
  // a throwing listener would break every later listener AND propagate to the
  // publisher (which appends session events / settles jobs). Isolation routes
  // listener errors to onError and keeps every other listener + the publisher
  // unaffected. This is what makes it safe to attach automation listeners.
  it('isolates a throwing listener: other listeners still run, publish does not throw', () => {
    const errors: unknown[] = [];
    const bus = createSessionEventBus({ onError: (e) => errors.push(e) });
    const perSession: SessionEvent[] = [];
    const global: SessionEvent[] = [];

    bus.subscribe('s1', () => {
      throw new Error('boom (per-session)');
    });
    bus.subscribe('s1', (event) => perSession.push(event));
    bus.subscribeAll(() => {
      throw new Error('boom (global)');
    });
    bus.subscribeAll((event) => global.push(event));

    // Must not throw despite two throwing listeners.
    expect(() => bus.publish(makeEvent('s1', 1))).not.toThrow();
    // The healthy listeners still received the event.
    expect(perSession).toHaveLength(1);
    expect(global).toHaveLength(1);
    // Both throws were reported to onError.
    expect(errors).toHaveLength(2);
  });
});
