import { useParams } from 'react-router';

import { useQuery, useAuthScope, useSessionStream } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EventFeed } from '../components/sessions/EventFeed.js';
import { SessionSidePanel } from '../components/sessions/SessionSidePanel.js';

// Phase 3 3b: Session Detail — three-column shell. Left: session metadata.
// Middle: live event feed (SSE). Right: run controls + inline approval/cards
// (filled in 3c; a placeholder for now). The feed is the continuous narrative.

const CONN_LABEL: Record<string, string> = {
  connecting: '连接中',
  live: '实时',
  reconnecting: '重连中',
  closed: '已关闭',
};

export function SessionDetailPage() {
  const { sessionId = null } = useParams();
  const scope = useAuthScope();

  // Fire unconditionally; the RPC client / SSE client supply the token (3a).
  const { data, error, refetch } = useQuery<
    RpcProcedureMap['session.get']['output']
  >(
    sessionId ? queryKeys.sessionDetail(sessionId, scope) : null,
    () => rpc.call('session.get', { sessionId: sessionId! }),
  );

  const { events, connState } = useSessionStream(sessionId);

  const session = data?.session;

  return (
    <div className="session-detail">
      <header className="page-header">
        <div>
          <h1 className="page-title">
            {session?.title ?? sessionId}
          </h1>
          <p className="page-subtitle">
            {session ? (
              <>
                <StatusBadge status={session.status} size="sm" />
                {session.runId ? ` · run ${session.runId}` : ''}
              </>
            ) : (
              '加载中…'
            )}
            <span className={`session-conn session-conn-${connState}`}>
              {' · '}
              {CONN_LABEL[connState] ?? connState}
            </span>
          </p>
        </div>
      </header>

      {error ? <ErrorBanner error={error} onRetry={refetch} /> : null}

      <div className="session-columns">
        <main className="session-feed-col">
          <EventFeed events={events} />
        </main>
        <aside className="session-side-col">
          <SessionSidePanel events={events} />
        </aside>
      </div>
    </div>
  );
}
