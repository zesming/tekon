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

const ACTION_KIND_LABELS: Record<string, string> = {
  approval: '待审批',
  // awaiting-input currently represents a blocked workflow. The product has no
  // in-session follow-up composer yet, so “待输入” would promise an unavailable
  // action. Keep the transport value for compatibility and label the real move.
  input: '待恢复',
  failed: '需处理',
};

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (Number.isNaN(diffMs)) return iso;
  if (diffMs < 0) return '刚刚';

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays <= 7) return `${diffDays}天前`;
  return date.toLocaleDateString();
}

// Phase 3 3b / Phase 4 P1-04: controlled-delivery list + composer.
// Displays relative activity time and needsAction badges per session.

export function SessionsPage() {
  const scope = useAuthScope();

  // Fire unconditionally like the other read pages: the RPC client supplies the
  // session token (3a M1 fix); auth failures surface via ErrorBanner, not a
  // pre-check on the in-memory token (which the e2e never populates).
  const { data, isLoading, error, refetch } = useQuery<
    RpcProcedureMap['session.list']['output']
  >(queryKeys.sessionList(scope), () => rpc.call('session.list'));

  const sessions = data?.sessions ?? [];
  const workspaceId = data?.workspaceId ?? null;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">受控交付</h1>
          <p className="page-subtitle">
            发起并跟踪完整研发交付，查看执行过程、审批与结果
          </p>
        </div>
        <div className="page-actions">
          {/* There is one workspace today. Render it as information, not a
              disabled selector that suggests a choice the product cannot make. */}
          {workspaceId ? (
            <div
              className="workspace-picker"
              role="group"
              aria-label="当前工作区"
              title="暂只支持当前项目"
            >
              <span className="workspace-picker-label">工作区</span>
              <span className="workspace-picker-value">当前项目</span>
            </div>
          ) : null}
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
          message="还没有交付任务"
          hint="使用上方输入框描述需求，启动第一个受控交付。"
        />
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="session-list-item"
              title={session.runId ? `关联运行 ${session.runId}` : undefined}
            >
              <NavLink
                to={routes.session(session.id)}
                className="session-list-link"
              >
                <span className="session-list-title">
                  {session.title ?? session.id}
                </span>
                {session.needsAction && session.actionKind ? (
                  <span
                    className={`session-list-action session-list-action-${session.actionKind}`}
                  >
                    {ACTION_KIND_LABELS[session.actionKind] ?? '待处理'}
                  </span>
                ) : null}
                <StatusBadge status={session.status} size="sm" />
                {session.runId ? (
                  <span className="session-list-run text-muted">交付运行</span>
                ) : null}
                <time
                  className="session-list-time"
                  dateTime={session.lastActivityAt}
                  title={session.lastActivityAt}
                >
                  {formatRelativeTime(session.lastActivityAt)}
                </time>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
