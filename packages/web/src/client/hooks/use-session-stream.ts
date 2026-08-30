import { useCallback, useEffect, useRef, useState } from 'react';

import { queryCache } from '../lib/query-cache.js';
import { rpc } from '../lib/rpc-client.js';
import {
  lastEventId,
  mergeEventsBySeq,
  openSessionStream,
  type StreamConnState,
  type StreamEvent,
} from '../lib/session-stream.js';
import { useSessionToken } from './use-session-token.js';

export const CLIENT_STREAM_WINDOW_SIZE = 1000;
const EARLIER_PAGE_LIMIT = 500;

// Events that change a session's list-visible state (status badge / existence).
const SESSION_LIST_REFRESH_EVENTS = new Set([
  'session/created',
  'approval/requested',
  'approval/decided',
  'turn/end',
  'workflow/node-ended',
  'workflow/started',
  // Run-level terminal (dual-write maps run.passed → agent/status) and the web
  // cancel path (agent/cancelled) also flip the list status badge.
  'agent/status',
  'agent/cancelled',
]);

export interface UseSessionStreamResult {
  events: StreamEvent[];
  connState: StreamConnState;
  latestSeq: number;
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
}

export function useSessionStream(
  sessionId: string | null,
): UseSessionStreamResult {
  const { token } = useSessionToken();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connState, setConnState] = useState<StreamConnState>('connecting');
  const [hasEarlier, setHasEarlier] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const eventsRef = useRef<StreamEvent[]>([]);

  const loadEarlier = useCallback(async () => {
    if (!sessionId || isLoadingEarlier) return;
    const earliestSeq = eventsRef.current[0]?.seq ?? 0;
    if (earliestSeq <= 1) {
      setHasEarlier(false);
      return;
    }

    setIsLoadingEarlier(true);
    try {
      const sinceSeq = Math.max(0, earliestSeq - EARLIER_PAGE_LIMIT - 1);
      const res = await rpc.call('session.events', {
        sessionId,
        sinceSeq,
        limit: EARLIER_PAGE_LIMIT,
      });
      if (res?.events && res.events.length > 0) {
        eventsRef.current = mergeEventsBySeq(
          res.events as StreamEvent[],
          eventsRef.current,
        );
        setEvents(eventsRef.current);
        setHasEarlier(eventsRef.current[0]?.seq > 1);
      } else {
        setHasEarlier(false);
      }
    } catch {
      // keep current state on error
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [sessionId, isLoadingEarlier]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    // Reset accumulated state when the subscription target changes.
    eventsRef.current = [];
    setEvents([]);
    setConnState('connecting');
    setHasEarlier(false);
    setIsLoadingEarlier(false);

    const stream = openSessionStream({
      sessionId,
      token,
      onEvent(event) {
        eventsRef.current = mergeEventsBySeq(eventsRef.current, [event]);
        if (eventsRef.current.length > CLIENT_STREAM_WINDOW_SIZE) {
          eventsRef.current = eventsRef.current.slice(
            -CLIENT_STREAM_WINDOW_SIZE,
          );
        }
        setEvents(eventsRef.current);
        setHasEarlier((eventsRef.current[0]?.seq ?? 1) > 1);
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
    hasEarlier,
    isLoadingEarlier,
    loadEarlier,
  };
}
