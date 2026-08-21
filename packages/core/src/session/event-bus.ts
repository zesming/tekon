import type { SessionEvent } from '../types/session-contract.js';

export interface SessionEventBus {
  publish(event: SessionEvent): void;
  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void;
}

/**
 * Process-local pub/sub for session events. The event store stays pure
 * (append-only); publishers explicitly call `publish` after a successful
 * append so live subscribers never race the durable log.
 */
export function createSessionEventBus(): SessionEventBus {
  const listeners = new Map<
    string,
    Set<(event: SessionEvent) => void>
  >();

  return {
    publish(event) {
      const set = listeners.get(event.sessionId);
      if (!set) {
        return;
      }
      for (const listener of [...set]) {
        listener(event);
      }
    },

    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(sessionId);
        }
      };
    },
  };
}
