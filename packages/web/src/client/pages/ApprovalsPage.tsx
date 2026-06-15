import { useCallback, useMemo } from 'react';

import { useQuery, useMutation } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { useAuth } from '../context/auth-context.js';
import { useFlash } from '../context/flash-context.js';
import type {
  ProjectOverviewOutput,
  GateListOutput,
  DecisionInput,
  DecisionOutput,
} from '../../shared/api-types.js';

import { DecisionCard } from '../components/approvals/DecisionCard.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EmptyState } from '../components/ui/EmptyState.js';

// ---------------------------------------------------------------------------
// ApprovalsPage — shows pending human-decision approvals for the latest run
// ---------------------------------------------------------------------------

export function ApprovalsPage() {
  const { token } = useAuth();
  const flash = useFlash();

  // ── 1. Project overview → latest run ───────────────────────────────────────
  const overviewQuery = useQuery<ProjectOverviewOutput>(
    'approvals:overview',
    () => rpc.call('project.overview'),
  );

  const latestRunId = overviewQuery.data?.latestRun?.id ?? null;

  // ── 2. Gate list → pending decisions ───────────────────────────────────────
  const gateListKey = latestRunId ? `approvals:gates:${latestRunId}` : null;
  const gatesQuery = useQuery<GateListOutput>(
    gateListKey,
    () => rpc.call('gate.list', { runId: latestRunId! }),
  );

  const pendingDecisions = useMemo(
    () => gatesQuery.data?.pendingDecisions ?? [],
    [gatesQuery.data?.pendingDecisions],
  );

  // ── 3. Mutations: approve / reject ─────────────────────────────────────────
  const invalidateKeys = useMemo(
    () => [
      'approvals:overview',
      ...(latestRunId ? [`approvals:gates:${latestRunId}`] : []),
      // Also invalidate the dashboard caches so counts refresh
      'dashboard:overview',
    ],
    [latestRunId],
  );

  const approveMutation = useMutation<DecisionInput, DecisionOutput>(
    (input) => rpc.call('gate.approve', input),
    { invalidateKeys },
  );

  const rejectMutation = useMutation<DecisionInput, DecisionOutput>(
    (input) => rpc.call('gate.reject', input),
    { invalidateKeys },
  );

  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  // ── 4. Handlers ────────────────────────────────────────────────────────────
  const handleApprove = useCallback(
    async (decisionId: string, note: string) => {
      if (!token) {
        flash.addFlash('error', '请先登录并提供 token');
        return;
      }
      if (!latestRunId) return;

      try {
        await approveMutation.mutate({
          runId: latestRunId,
          decisionId,
          actor: 'web-user',
          note: note || undefined,
          token,
        });
        flash.addFlash('success', `决策 ${decisionId} 已批准`);
      } catch (err) {
        flash.addFlash(
          'error',
          `审批失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [token, latestRunId, approveMutation, flash],
  );

  const handleReject = useCallback(
    async (decisionId: string, note: string) => {
      if (!token) {
        flash.addFlash('error', '请先登录并提供 token');
        return;
      }
      if (!latestRunId) return;

      try {
        await rejectMutation.mutate({
          runId: latestRunId,
          decisionId,
          actor: 'web-user',
          note: note || undefined,
          token,
        });
        flash.addFlash('success', `决策 ${decisionId} 已拒绝`);
      } catch (err) {
        flash.addFlash(
          'error',
          `拒绝失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [token, latestRunId, rejectMutation, flash],
  );

  // ── 5. Refresh handler ─────────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    overviewQuery.refetch();
    gatesQuery.refetch();
  }, [overviewQuery, gatesQuery]);

  // ── 6. Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-subtitle">
            审批队列
            {latestRunId ? (
              <span
                className="text-mono text-muted"
                style={{ marginLeft: '8px' }}
              >
                · run {latestRunId}
              </span>
            ) : null}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleRefresh}
          >
            ↻ 刷新
          </button>
        </div>
      </header>

      {/* Token warning */}
      {!token ? (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--pend-bg)',
            border: '1px solid #fde68a',
            borderRadius: 'var(--r-md)',
            marginBottom: '20px',
            fontSize: '13px',
            color: '#92400e',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '16px' }}>⚠</span>
          需要提供 token 才能执行审批操作。请在页面右上角输入 token。
        </div>
      ) : null}

      {/* Loading state */}
      {overviewQuery.isLoading || gatesQuery.isLoading ? (
        <LoadingState message="加载审批队列..." />
      ) : null}

      {/* Error state */}
      {overviewQuery.error ? (
        <ErrorBanner error={overviewQuery.error} onRetry={overviewQuery.refetch} />
      ) : gatesQuery.error ? (
        <ErrorBanner error={gatesQuery.error} onRetry={gatesQuery.refetch} />
      ) : null}

      {/* Empty state */}
      {!overviewQuery.isLoading &&
      !gatesQuery.isLoading &&
      !overviewQuery.error &&
      !gatesQuery.error &&
      pendingDecisions.length === 0 ? (
        <EmptyState
          message="没有待处理审批"
          hint={
            latestRunId
              ? '最新运行的所有人工审批节点均已决策。'
              : '暂无活跃运行。启动运行后将在此显示审批。'
          }
        />
      ) : null}

      {/* Pending decisions list */}
      {pendingDecisions.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {pendingDecisions.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              isPending={isMutating}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      ) : null}

      {/* Mutation error */}
      {approveMutation.error ? (
        <div style={{ marginTop: '16px' }}>
          <ErrorBanner error={approveMutation.error} />
        </div>
      ) : rejectMutation.error ? (
        <div style={{ marginTop: '16px' }}>
          <ErrorBanner error={rejectMutation.error} />
        </div>
      ) : null}
    </>
  );
}
