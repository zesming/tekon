import { useEffect, useState } from 'react';

import { queryCache } from '../lib/query-cache.js';
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

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    setConnState('connecting');

    const stream = openWorkspaceSummaryStream({
      workspaceId,
      token,
      onEvent(_event: WorkspaceSummaryEvent) {
        queryCache.invalidate('session.list.');
      },
      onStateChange: setConnState,
    });

    return () => stream.close();
  }, [workspaceId, token]);

  return { connState };
}
