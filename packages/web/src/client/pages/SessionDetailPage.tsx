import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router';

import { useQuery, useAuthScope, useSessionStream } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  deriveSessionSidePanel,
  mergeSessionSnapshotIntoSidePanel,
} from '../lib/session-side-panel.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EventFeed } from '../components/sessions/EventFeed.js';
import { SessionSidePanel } from '../components/sessions/SessionSidePanel.js';
import { ExecutionBindingNotice } from '../components/runs/ExecutionBindingNotice.js';
import {
  AdmissionReadinessBanner,
  admissionNeedsRecovery,
  admissionReadinessLabel,
  knownAdmissionLabel,
} from '../components/runs/AdmissionNotice.js';

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
    truncated,
    dismissTruncated,
  } = useSessionStream(sessionId);
  const liveState = useMemo(() => deriveSessionSidePanel(events), [events]);
  const session = data?.session;
  const admissionPending = admissionNeedsRecovery(session);
  // Opening SSE events can exist before files are ready. Only a successful
  // authoritative snapshot may enable controls, including after refresh errors.
  const snapshotUnavailable = !session || Boolean(error);
  useEffect(() => {
    if (!admissionPending) return;
    const timer = window.setInterval(refetch, 5_000);
    return () => window.clearInterval(timer);
  }, [admissionPending, refetch]);
  const sidePanelState = useMemo(
    () =>
      mergeSessionSnapshotIntoSidePanel(liveState, {
        runId: session?.runId,
        status: session?.status,
        actionKind: session?.actionKind,
      }),
    [liveState, session?.actionKind, session?.runId, session?.status],
  );

  // session.get is a point-in-time snapshot while the event stream keeps
  // advancing. The merged state uses the snapshot until the live projection is
  // known, then prefers the newer event-derived workflow status.
  const displayedStatus = sidePanelState.runStatus ?? session?.status ?? null;

  return (
    <div className="session-detail">
      <header className="page-header">
        <div>
          <h1 className="page-title">{session?.title ?? sessionId}</h1>
          <p className="page-subtitle">
            {session && !error ? (
              <>
                {admissionPending && session ? (
                  <span className="badge badge-pending badge-sm">
                    {admissionReadinessLabel(session)}
                  </span>
                ) : displayedStatus ? (
                  <StatusBadge status={displayedStatus} size="sm" />
                ) : null}
                {session.runId ? ' · 已关联交付运行' : ''}
              </>
            ) : error ? (
              knownAdmissionLabel(session)
                ? `${knownAdmissionLabel(session)} · 当前状态刷新失败`
                : '受理状态待确认'
            ) : (
              '正在确认受理状态…'
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
      {session ? <AdmissionReadinessBanner value={session} /> : null}
      {session?.runId ? <ExecutionBindingNotice value={session.executionBinding} /> : null}

      <div className="session-columns">
        <section className="session-feed-col" aria-label="会话活动">
          <EventFeed
            key={sessionId ?? 'none'}
            events={events}
            hasEarlier={hasEarlier}
            reachedEarlierLimit={reachedEarlierLimit}
            isLoadingEarlier={isLoadingEarlier}
            onLoadEarlier={loadEarlier}
            truncated={truncated}
            onDismissTruncated={dismissTruncated}
          />
        </section>
        <aside className="session-side-col" aria-label="运行控制与结果">
          {snapshotUnavailable ? (
            <p className="text-muted">
              尚未取得有效受理快照，暂不提供运行控制。
            </p>
          ) : admissionPending ? (
            <p className="text-muted">
              目录就绪前不会执行任务。当前仅可观察受理记录。
            </p>
          ) : (
            <SessionSidePanel state={sidePanelState} />
          )}
        </aside>
      </div>
    </div>
  );
}
