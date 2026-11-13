import { useCallback, useMemo, useState } from 'react';

import { useQuery, useAuthScope } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { useAuth } from '../context/auth-context.js';
import { useFlash } from '../context/flash-context.js';
import { useResumeConfirmation } from '../hooks/use-resume-confirmation.js';
import { ResumeConfirmation } from '../components/runs/ResumeConfirmation.js';
import { approvalFeedback } from '../lib/approval-feedback.js';
import { preflightWarning } from '../lib/preflight-warning.js';
import { queryCache } from '../lib/query-cache.js';
import { routes } from '../lib/route-paths.js';
import { queryKeys } from '../lib/query-keys.js';
import type {
  DecisionInput,
} from '../../shared/api-types.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { DecisionCard } from '../components/approvals/DecisionCard.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EmptyState } from '../components/ui/EmptyState.js';

type PendingEntry =
  RpcProcedureMap['gate.pendingAll']['output']['pending'][number];

// ---------------------------------------------------------------------------
// PendingApprovalEntry — one decision with the runId and recovery it belongs
// to, so approvals from older runs are operable (PD-22). The resume
// confirmation is per run, hence a dedicated component owning that state.
// ---------------------------------------------------------------------------

export function PendingApprovalEntry({
  entry,
  token,
  isMutating,
  onBegin,
  onSettled,
  onNotice,
}: {
  entry: PendingEntry;
  token: string | null;
  isMutating: boolean;
  onBegin: () => void;
  onSettled: () => void;
  // Partial-success notices must outlive the entry itself: the approved
  // decision leaves the pending queue on refetch, so a notice kept inside the
  // entry would unmount before the user can read the recovery guidance.
  onNotice: (runId: string, message: string) => void;
}) {
  const { runId, decision, recovery } = entry;
  const flash = useFlash();
  const confirmation = useResumeConfirmation(runId, recovery);

  const handleApprove = useCallback(
    async (decisionId: string, note: string) => {
      if (!token) {
        flash.addFlash('error', '请先登录并提供 token');
        return;
      }
      if (confirmation.required && !confirmation.confirmed) return;
      onBegin();
      try {
        const result = await rpc.call('gate.approve', {
          runId,
          decisionId,
          actor: 'web-user',
          note: note || undefined,
          token,
          ...confirmation.input,
        } satisfies DecisionInput);
        const feedback = approvalFeedback(result);
        onNotice(runId, feedback.message);
        flash.addFlash(feedback.variant, feedback.message);
        const warning = preflightWarning(result.preflight);
        if (warning) flash.addFlash('warning', warning);
      } catch (err) {
        flash.addFlash(
          'error',
          `批准失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        confirmation.setConfirmed(false);
        onSettled();
      }
    },
    [token, confirmation, runId, flash, onBegin, onSettled, onNotice],
  );

  const handleReject = useCallback(
    async (decisionId: string, note: string) => {
      if (!token) {
        flash.addFlash('error', '请先登录并提供 token');
        return;
      }
      onBegin();
      try {
        await rpc.call('gate.reject', {
          runId,
          decisionId,
          actor: 'web-user',
          note: note || undefined,
          token,
        } satisfies DecisionInput);
        flash.addFlash('success', `Decision ${decisionId} rejected`);
      } catch (err) {
        flash.addFlash(
          'error',
          `Reject failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        onSettled();
      }
    },
    [token, runId, flash, onBegin, onSettled],
  );

  return (
    <div className="approval-entry" data-run-id={runId}>
      <p className="text-mono text-muted approval-entry-run">
        <a href={routes.run(runId)}>run {runId}</a>
      </p>
      <ResumeConfirmation
        recovery={recovery}
        checked={confirmation.confirmed}
        disabled={isMutating}
        onChange={confirmation.setConfirmed}
      />
      <DecisionCard
        decision={decision}
        isPending={isMutating}
        approveDisabled={confirmation.required && !confirmation.confirmed}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApprovalsPage — pending human decisions across every run in scope (PD-22).
// ---------------------------------------------------------------------------

export function ApprovalsPage() {
  const { token } = useAuth();
  const scope = useAuthScope();

  const pendingQuery = useQuery<RpcProcedureMap['gate.pendingAll']['output']>(
    queryKeys.gatePendingAll(scope),
    () => rpc.call('gate.pendingAll'),
  );

  const invalidateKeys = useMemo(
    () => [
      'project.overview',
      'gate.results',
      'gate.pendingAll',
      'session.detail.',
      'session.list.',
      'review.',
    ],
    [],
  );

  // gate.approve/reject share one in-flight flag; the query refetch drives
  // the list update when a decision leaves the pending set.
  const [isMutating, setIsMutating] = useState(false);
  // Page-level recovery notices: the entry that raised them unmounts on the
  // post-approval refetch, so the guidance (and its run link) must live here.
  const [notices, setNotices] = useState<Array<{ runId: string; message: string }>>([]);
  const handleNotice = useCallback((runId: string, message: string) => {
    setNotices((current) => [
      ...current.filter((item) => item.runId !== runId),
      { runId, message },
    ]);
  }, []);
  const settle = useCallback(() => {
    setIsMutating(false);
    for (const key of invalidateKeys) queryCache.invalidate(key);
  }, [invalidateKeys]);

  const handleRefresh = useCallback(() => {
    pendingQuery.refetch();
  }, [pendingQuery]);

  const pending = pendingQuery.data?.pending ?? [];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-subtitle">
            审批队列
            {pending.length > 0 ? (
              <span className="text-mono text-muted" style={{ marginLeft: '8px' }}>
                · {pending.length} 项待处理，跨 {new Set(pending.map((entry) => entry.runId)).size} 个运行
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

      {pendingQuery.isLoading ? <LoadingState message="加载审批队列..." /> : null}

      {pendingQuery.error ? (
        <ErrorBanner error={pendingQuery.error} onRetry={pendingQuery.refetch} />
      ) : null}

      {!pendingQuery.isLoading && !pendingQuery.error && pending.length === 0 ? (
        <EmptyState
          message="没有待处理审批"
          hint="当前项目下所有运行的人工门禁都已处理。"
        />
      ) : null}

      {notices.map((item) => (
        <p className="run-recovery-notice" key={item.runId}>
          {item.message}{' '}
          <a href={routes.run(item.runId)}>查看运行并恢复</a>
        </p>
      ))}

      {pending.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {pending.map((entry) => (
            <PendingApprovalEntry
              key={`${entry.runId}:${entry.decision.id}`}
              entry={entry}
              token={token}
              isMutating={isMutating}
              onBegin={() => setIsMutating(true)}
              onSettled={settle}
              onNotice={handleNotice}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
