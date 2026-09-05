import { useCallback, useEffect, useRef, useState } from 'react';

import { queryCache } from '../lib/query-cache.js';
import { authScope, queryKeys } from '../lib/query-keys.js';
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
export const MAX_EARLIER = 2000;
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
  reachedEarlierLimit: boolean;
  isLoadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  /** True when the server signalled replay truncation (budget/backpressure). */
  truncated: boolean;
  /** Dismiss the truncation notice. */
  dismissTruncated: () => void;
}

export function useSessionStream(
  sessionId: string | null,
): UseSessionStreamResult {
  const { token } = useSessionToken();
  const contextKey = JSON.stringify([sessionId, token]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const stateContext = useRef(contextKey);
  const subscriptionRef = useRef<object | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connState, setConnState] = useState<StreamConnState>('connecting');
  const [hasEarlier, setHasEarlier] = useState(false);
  const [reachedEarlierLimit, setReachedEarlierLimit] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const eventsRef = useRef<StreamEvent[]>([]);
  const retainFloor = useRef(0);
  // Backward cursor carried across loadEarlier calls. The server advances it
  // even when a whole page is internal events, so an empty visible page does
  // not dead-end paging.
  const earlierCursor = useRef<number | null>(null);

  const dismissTruncated = useCallback(() => setTruncated(false), []);

  const loadEarlier = useCallback(async () => {
    const owner = subscriptionRef.current;
    if (!sessionId || isLoadingEarlier || retainFloor.current >= MAX_EARLIER)
      return;
    if (!owner || contextRef.current !== contextKey) return;
    const current = () => subscriptionRef.current === owner && contextRef.current === contextKey;
    const earliestSeq = eventsRef.current[0]?.seq ?? 0;
    const beforeSeq = earlierCursor.current ?? earliestSeq;
    if (beforeSeq <= 1) {
      setHasEarlier(false);
      return;
    }

    setIsLoadingEarlier(true);
    try {
      // Backward cursor: ask for raw rows with seq < beforeSeq. The server
      // returns nextBeforeSeq (smallest raw seq examined) which advances even
      // when a whole page is internal events, so paging never dead-ends.
      const res = await rpc.call('session.events', {
        sessionId,
        beforeSeq,
        limit: EARLIER_PAGE_LIMIT,
      });
      if (!current()) return;
      const nextCursor = res?.nextBeforeSeq;
      earlierCursor.current = nextCursor ?? null;
      if (res?.events && res.events.length > 0) {
        const before = eventsRef.current[0]?.seq ?? 0;
        eventsRef.current = mergeEventsBySeq(res.events, eventsRef.current);
        const after = eventsRef.current[0]?.seq ?? before;
        // Only count progress when the window actually moved backward.
        if (after < before) {
          retainFloor.current = Math.min(
            MAX_EARLIER,
            retainFloor.current + res.events.length,
          );
        }
        if (retainFloor.current >= MAX_EARLIER) {
          setReachedEarlierLimit(true);
        }
        const maxWindow =
          CLIENT_STREAM_WINDOW_SIZE +
          Math.min(retainFloor.current, MAX_EARLIER);
        if (eventsRef.current.length > maxWindow) {
          eventsRef.current = eventsRef.current.slice(-maxWindow);
        }
        setEvents(eventsRef.current);
      }
      // "Reached the start" is signalled solely by nextBeforeSeq === null.
      if (nextCursor === null) {
        setHasEarlier(false);
      } else {
        setHasEarlier(true);
      }
    } catch {
      // keep current state on error
    } finally {
      if (current()) setIsLoadingEarlier(false);
    }
  }, [sessionId, isLoadingEarlier, contextKey]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const owner = {};
    subscriptionRef.current = owner;
    stateContext.current = contextKey;
    const current = () => subscriptionRef.current === owner && contextRef.current === contextKey;
    const scope = authScope(token);
    // Reset accumulated state when the subscription target changes.
    eventsRef.current = [];
    retainFloor.current = 0;
    earlierCursor.current = null;
    setEvents([]);
    setConnState('connecting');
    setHasEarlier(false);
    setReachedEarlierLimit(false);
    setIsLoadingEarlier(false);
    setTruncated(false);

    const stream = openSessionStream({
      sessionId,
      token,
      onTruncated() {
        if (!current()) return;
        setTruncated(true);
      },
      onEvent(event) {
        if (!current()) return;
        eventsRef.current = mergeEventsBySeq(eventsRef.current, [event]);
        const maxWindow =
          CLIENT_STREAM_WINDOW_SIZE +
          Math.min(retainFloor.current, MAX_EARLIER);
        if (eventsRef.current.length > maxWindow) {
          eventsRef.current = eventsRef.current.slice(-maxWindow);
        }
        setEvents(eventsRef.current);
        setHasEarlier((eventsRef.current[0]?.seq ?? 1) > 1);
        if (SESSION_LIST_REFRESH_EVENTS.has(event.type)) {
          queryCache.invalidate(queryKeys.sessionList(scope));
        }
        if (event.type === 'approval/requested' || event.type === 'approval/decided') {
          const runId = event.payload?.runId;
          // The event is an invalidation hint; the authenticated RPC remains the
          // authority for decision data and permissions.
          queryCache.invalidate(typeof runId === 'string' && runId.length > 0
            ? queryKeys.gateResults(runId, scope)
            : 'gate.results.');
        }
      },
      onStateChange(state) {
        if (current()) setConnState(state);
      },
    });

    return () => {
      if (subscriptionRef.current === owner) subscriptionRef.current = null;
      stream.close();
    };
  }, [sessionId, token, contextKey]);

  const sameContext = stateContext.current === contextKey;
  return {
    events: sameContext ? events : [],
    connState: sameContext ? connState : 'connecting',
    latestSeq: sameContext ? lastEventId(events) : 0,
    hasEarlier: sameContext && hasEarlier,
    reachedEarlierLimit: sameContext && reachedEarlierLimit,
    isLoadingEarlier: sameContext && isLoadingEarlier,
    loadEarlier,
    truncated: sameContext && truncated,
    dismissTruncated,
  };
}
