import { useEffect, useRef, useState } from 'react';

import { queryCache } from '../lib/query-cache.js';
import {
  lastEventId,
  mergeEventsBySeq,
  openSessionStream,
  type StreamConnState,
  type StreamEvent,
} from '../lib/session-stream.js';
import { useSessionToken } from './use-session-token.js';

/**
 * Phase 3 3a: subscribe to one session's event stream.
 *
 * Holds the accumulated, deduped, seq-ordered event list and the connection
 * state. The frame parsing, dedupe and reconnect logic live in
 * `lib/session-stream.ts` (pure + unit-tested); this hook is the React glue.
 *
 * S6/SHOULD-1: when a status-flipping event arrives, invalidate the
 * `session.list` query so the left rail's status badges and any newly created
 * session refresh without a manual reload.
 */

// Events that change a session's list-visible state (status badge / existence).
const SESSION_LIST_REFRESH_EVENTS = new Set([
  'session/created',
  'approval/requested',
  'approval/decided',
  'turn/end',
  'workflow/node-ended',
  'workflow/started',
]);

export interface UseSessionStreamResult {
  events: StreamEvent[];
  connState: StreamConnState;
  latestSeq: number;
}

export function useSessionStream(
  sessionId: string | null,
): UseSessionStreamResult {
  const { token } = useSessionToken();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connState, setConnState] = useState<StreamConnState>('connecting');
  const eventsRef = useRef<StreamEvent[]>([]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    // Reset accumulated state when the subscription target changes.
    eventsRef.current = [];
    setEvents([]);
    setConnState('connecting');

    const stream = openSessionStream({
      sessionId,
      token,
      onEvent(event) {
        eventsRef.current = mergeEventsBySeq(eventsRef.current, [event]);
        setEvents(eventsRef.current);
        if (SESSION_LIST_REFRESH_EVENTS.has(event.type)) {
          queryCache.invalidate('session.list.');
        }
      },
      onStateChange: setConnState,
    });

    return () => stream.close();
  }, [sessionId, token]);

  return {
    events,
    connState,
    latestSeq: lastEventId(events),
  };
}
