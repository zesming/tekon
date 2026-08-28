import type { SessionEvent } from '../types/session-contract.js';

export interface SessionEventBus {
  publish(event: SessionEvent): void;
  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void;
  /**
   * 4e: global subscription — receives EVERY session's events, not just one
   * session's. For automation listeners (auto-prepare delivery, readiness
   * evaluation) that react to run-level events regardless of session. Returns
   * an unsubscribe function like `subscribe`.
   */
  subscribeAll(listener: (event: SessionEvent) => void): () => void;
}

export interface SessionEventBusOptions {
  /**
   * 4e: invoked when a listener throws. The bus isolates listener errors so a
   * single throwing listener can neither break the other listeners nor
   * propagate to the publisher (which appends the durable event / settles the
   * job). Defaults to a no-op; composition roots pass a logger.
   */
  onError?: (error: unknown, event: SessionEvent) => void;
}

/**
 * Process-local pub/sub for session events. The event store stays pure
 * (append-only); publishers explicitly call `publish` after a successful
 * append so live subscribers never race the durable log.
 *
 * Fan-out is synchronous (SSE depends on this: subscribe-then-replay is only
 * lossless if publish delivers synchronously). Listener exceptions are
 * isolated (4e) so attaching automation listeners cannot destabilize SSE or
 * the job runner.
 */
export function createSessionEventBus(
  options: SessionEventBusOptions = {},
): SessionEventBus {
  const listeners = new Map<
    string,
    Set<(event: SessionEvent) => void>
  >();
  const globalListeners = new Set<(event: SessionEvent) => void>();

  function safeInvoke(
    listener: (event: SessionEvent) => void,
    event: SessionEvent,
  ): void {
    try {
      listener(event);
    } catch (error) {
      options.onError?.(error, event);
    }
  }

  return {
    publish(event) {
      const set = listeners.get(event.sessionId);
      if (set) {
        for (const listener of [...set]) {
          safeInvoke(listener, event);
        }
      }
      if (globalListeners.size > 0) {
        for (const listener of [...globalListeners]) {
          safeInvoke(listener, event);
        }
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

    subscribeAll(listener) {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },
  };
}
