import { NavLink } from 'react-router';

import { useQuery, useAuthScope } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import { routes } from '../lib/route-paths.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { SessionComposer } from '../components/sessions/SessionComposer.js';

// Phase 3 3b: Session List + composer. The human-first entry point — sessions
// are the main axis (workspace/session/message), replacing run-centric reads.

export function SessionsPage() {
  const scope = useAuthScope();

  // Fire unconditionally like the other read pages: the RPC client supplies the
  // session token (3a M1 fix); auth failures surface via ErrorBanner, not a
  // pre-check on the in-memory token (which the e2e never populates).
  const { data, isLoading, error, refetch } = useQuery<
    RpcProcedureMap['session.list']['output']
  >(queryKeys.sessionList(scope), () => rpc.call('session.list'));

  const sessions = data?.sessions ?? [];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">会话 Sessions</h1>
          <p className="page-subtitle">
            以会话为主轴查看 Agent 交付 · a continuous, replayable narrative
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={refetch}
          >
            ↻ 刷新
          </button>
        </div>
      </header>

      <SessionComposer />

      {error ? <ErrorBanner error={error} onRetry={refetch} /> : null}

      {isLoading ? (
        <LoadingState />
      ) : sessions.length === 0 ? (
        <EmptyState
          message="还没有会话"
          hint="使用上方输入框描述需求，开始你的第一个会话。"
        />
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className="session-list-item">
              <NavLink to={routes.session(session.id)} className="session-list-link">
                <span className="session-list-title">
                  {session.title ?? session.id}
                </span>
                <StatusBadge status={session.status} size="sm" />
                {session.runId ? (
                  <span className="session-list-run text-muted">
                    run {session.runId}
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
