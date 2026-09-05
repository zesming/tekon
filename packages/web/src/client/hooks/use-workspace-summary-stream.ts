import { useEffect, useRef, useState } from 'react';

import { queryCache } from '../lib/query-cache.js';
import { authScope, queryKeys } from '../lib/query-keys.js';
import {
  openWorkspaceSummaryStream,
  type WorkspaceSummaryEvent,
} from '../lib/workspace-summary-stream.js';
import type { StreamConnState } from '../lib/session-stream.js';
import { useSessionToken } from './use-session-token.js';

export interface UseWorkspaceSummaryStreamResult {
  connState: StreamConnState;
}

/**
 * T5: Subscribe to the workspace summary SSE stream.
 * Invalidates the session.list query whenever a workspace/summary event arrives.
 */
export function useWorkspaceSummaryStream(
  workspaceId: string | null,
): UseWorkspaceSummaryStreamResult {
  const { token } = useSessionToken();
  const [connState, setConnState] = useState<StreamConnState>('connecting');
  const contextKey = JSON.stringify([workspaceId, token]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const stateContext = useRef(contextKey);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let active = true;
    const current = () => active && contextRef.current === contextKey;
    stateContext.current = contextKey;
    setConnState('connecting');
    const listKey = queryKeys.sessionList(authScope(token));

    const stream = openWorkspaceSummaryStream({
      workspaceId,
      token,
      onEvent(_event: WorkspaceSummaryEvent) {
        if (current()) queryCache.invalidate(listKey);
      },
      onStateChange(state) {
        if (!current()) return;
        setConnState(state);
        // A fresh connection establishes a new server signature baseline. Read
        // once even without a subsequent event, including after a disconnect.
        if (state === 'live') queryCache.invalidate(listKey);
      },
    });

    return () => {
      active = false;
      stream.close();
    };
  }, [workspaceId, token, contextKey]);

  return { connState: stateContext.current === contextKey ? connState : 'connecting' };
}
