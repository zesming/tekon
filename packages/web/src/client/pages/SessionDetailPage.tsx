import { useMemo } from 'react';
import { useParams } from 'react-router';

import { useQuery, useAuthScope, useSessionStream } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import { deriveSessionSidePanel } from '../lib/session-side-panel.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EventFeed } from '../components/sessions/EventFeed.js';
import { SessionSidePanel } from '../components/sessions/SessionSidePanel.js';

// Phase 3 3b: Session Detail. The event feed is the continuous narrative;
// the side rail contains run controls, approvals, artifacts, and result cards.

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
  >(sessionId ? queryKeys.sessionDetail(sessionId, scope) : null, () =>
    rpc.call('session.get', { sessionId: sessionId! }),
  );

  const {
    events,
    connState,
    hasEarlier,
    reachedEarlierLimit,
    isLoadingEarlier,
    loadEarlier,
  } = useSessionStream(sessionId);
  const liveState = useMemo(() => deriveSessionSidePanel(events), [events]);

  const session = data?.session;
  // session.get is a point-in-time snapshot while the event stream keeps
  // advancing. Prefer the live workflow projection once it is known so the
  // header cannot remain "active" after the controls and result card already
  // show a passed/failed/cancelled outcome.
  const displayedStatus = liveState.runStatus ?? session?.status ?? null;

  return (
    <div className="session-detail">
      <header className="page-header">
        <div>
          <h1 className="page-title">{session?.title ?? sessionId}</h1>
          <p className="page-subtitle">
            {session ? (
              <>
                {displayedStatus ? (
                  <StatusBadge status={displayedStatus} size="sm" />
                ) : null}
                {session.runId ? ' · 已关联交付运行' : ''}
              </>
            ) : (
              '加载中…'
            )}
            <span
              className={`session-conn session-conn-${connState}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {' · '}
              {CONN_LABEL[connState] ?? connState}
            </span>
          </p>
        </div>
      </header>

      {error ? <ErrorBanner error={error} onRetry={refetch} /> : null}

      <div className="session-columns">
        <section className="session-feed-col" aria-label="会话活动">
          <EventFeed
            key={sessionId ?? 'none'}
            events={events}
            hasEarlier={hasEarlier}
            reachedEarlierLimit={reachedEarlierLimit}
            isLoadingEarlier={isLoadingEarlier}
            onLoadEarlier={loadEarlier}
          />
        </section>
        <aside className="session-side-col" aria-label="运行控制与结果">
          <SessionSidePanel state={liveState} />
        </aside>
      </div>
    </div>
  );
}
