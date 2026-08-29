import { MouseEvent } from 'react';
import { NavLink } from 'react-router';

import {
  useQuery,
  useMutation,
  useAuthScope,
  useTicker,
  useWorkspaceSummaryStream,
} from '../hooks/index.js';
import { useFlash } from '../context/flash-context.js';
import { formatRelativeTime } from '../lib/relative-time.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import { routes } from '../lib/route-paths.js';
import type {
  RpcProcedureMap,
  SessionActionKind,
} from '../../shared/rpc-contract.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { SessionComposer } from '../components/sessions/SessionComposer.js';

const ACTION_KIND_LABELS: Record<SessionActionKind, string> = {
  approval: '待审批',
  input: '待输入',
  failed: '需处理',
};

// Phase 3 3b / Phase 4 P1-04 / T3 / T5: controlled-delivery list + composer.
// Displays relative activity time, needsAction badges, acknowledge action for failed sessions,
// and subscribes to workspace summary SSE for real-time list synchronization.

export function SessionsPage() {
  const nowMs = useTicker(60_000);
  const scope = useAuthScope();
  const { addFlash } = useFlash();

  // Fire unconditionally like the other read pages: the RPC client supplies the
  // session token; auth failures surface via ErrorBanner.
  const { data, isLoading, error, refetch } = useQuery<
    RpcProcedureMap['session.list']['output']
  >(queryKeys.sessionList(scope), () => rpc.call('session.list'));

  const sessions = data?.sessions ?? [];
  const workspaceId = data?.workspaceId ?? null;

  // T5: Subscribe to live workspace summary SSE stream for real-time list invalidation
  useWorkspaceSummaryStream(workspaceId);

  // T3: Acknowledge mutation for failed sessions
  const ackMutation = useMutation<
    RpcProcedureMap['session.acknowledge']['input'],
    RpcProcedureMap['session.acknowledge']['output']
  >((input) => rpc.call('session.acknowledge', input), {
    invalidateKeys: ['session.list'],
  });

  const handleAcknowledge = async (
    e: MouseEvent<HTMLButtonElement>,
    sessionId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await ackMutation.mutate({ sessionId });
      addFlash('success', '已确认并归档该失败会话');
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '确认失败会话失败',
      );
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">受控交付</h1>
          <p className="page-subtitle">
            发起并跟踪完整研发交付，查看执行过程、阶段审批与交付产物
          </p>
        </div>
        <div className="page-actions">
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
          {sessions.map((session) => {
            const relativeTime = formatRelativeTime(
              session.lastActivityAt,
              nowMs,
            );
            const isFailedUnacknowledged =
              (session.status === 'failed' || session.actionKind === 'failed') &&
              !session.acknowledgedAt;

            return (
              <li
                key={session.id}
                className={`session-list-item${isFailedUnacknowledged ? " session-list-item-with-ack" : ""}`}
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
                      {ACTION_KIND_LABELS[session.actionKind]}
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
                    aria-label={`最近活动：${relativeTime}`}
                  >
                    {relativeTime}
                  </time>
                </NavLink>
                {isFailedUnacknowledged && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs session-acknowledge-btn"
                    title="确认并归档"
                    aria-label="确认并归档失败会话"
                    disabled={ackMutation.isPending}
                    onClick={(e) => handleAcknowledge(e, session.id)}
                  >
                    ✓ 确认归档
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
