import { useState, useEffect, useRef } from 'react';
import { useMutation } from '../../hooks/index.js';
import { useResumeConfirmation } from '../../hooks/use-resume-confirmation.js';
import { ResumeConfirmation } from './ResumeConfirmation.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { queryCache } from '../../lib/query-cache.js';
import type { ApiWorkflow } from '../../../shared/api-types.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunControlsProps {
  runId: string;
  status: string;
  recovery?: ApiWorkflow['recovery'];
  /** Compact mode for table rows */
  compact?: boolean;
  /**
   * Invoked when the user activates the "view details" control on a terminal
   * run. When omitted the control is not rendered (avoids a dead button).
   */
  onView?: (runId: string) => void;
}

// ---------------------------------------------------------------------------
// Status groups
// ---------------------------------------------------------------------------

/**
 * Statuses the engine treats as resumable. Report P1-08: users most need to
 * resume failed/interrupted/blocked runs, but Resume previously only showed for
 * `paused`, leaving the common recovery cases with no entry point.
 */
const RESUMABLE_STATUSES = new Set(['paused', 'blocked', 'interrupted']);
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled']);

/**
 * Which run-control affordances are valid for a given status. Pure so it can be
 * unit-tested without a DOM renderer (web tests run in the `node` environment).
 */
export interface RunControlAffordances {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canView: boolean;
}

export function runControlAffordances(status: string): RunControlAffordances {
  return {
    canPause: status === 'running',
    canResume: RESUMABLE_STATUSES.has(status),
    canCancel: status === 'running' || status === 'paused',
    canView: TERMINAL_STATUSES.has(status),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Pause / Resume / Cancel action buttons for a workflow run.
 * Only renders the actions that are valid for the current status.
 */
export function RunControls({
  runId,
  status,
  recovery,
  compact,
  onView,
}: RunControlsProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();

  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionReceipt, setActionReceipt] = useState<string | null>(null);
  const confirmation = useResumeConfirmation(runId, recovery);
  const actionInFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending-action timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const invalidateKeys = [
    'project.detail',
    'project.overview',
    'review.',
    'gate.results',
    'audit.',
    'session.detail.',
    'session.list.',
  ];

  const refreshObservations = () => {
    for (const key of invalidateKeys) queryCache.invalidate(key);
  };
  const resumeRecovery = recovery?.resumeRecovery;
  const confirmed = confirmation.confirmed;
  const cancelRecovery = status === 'cancelled' ? recovery?.cancelRecovery : null;
  const canRetryCancel = Boolean(cancelRecovery && (cancelRecovery.needsControlRetry || cancelRecovery.needsObservationRepair));

  const pauseMutation = useMutation<
    RpcProcedureMap['project.pause']['input'],
    RpcProcedureMap['project.pause']['output']
  >((input) => rpc.call('project.pause', input), { invalidateKeys });

  const resumeMutation = useMutation<
    RpcProcedureMap['project.resume']['input'],
    RpcProcedureMap['project.resume']['output']
  >((input) => rpc.call('project.resume', input));

  const cancelMutation = useMutation<
    RpcProcedureMap['project.cancel']['input'],
    RpcProcedureMap['project.cancel']['output']
  >((input) => rpc.call('project.cancel', input));

  if (!token) return null;

  const handlePause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    setActionReceipt(null);
    try {
      const result = await pauseMutation.mutate({ runId, token });
      if (TERMINAL_STATUSES.has(result.run.status)) {
        const message = `运行已结束（${result.run.status}），请核对最新运行状态。`;
        addFlash('info', message);
        setActionReceipt(message);
      } else {
        const message = '暂停请求已记录，活动步骤将在边界停下。';
        addFlash('success', message);
        setActionReceipt(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '暂停请求失败';
      addFlash('error', message);
      setActionError(message);
    } finally {
      actionInFlight.current = false;
      refreshObservations();
    }
  };

  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionInFlight.current || (resumeRecovery?.requiresConfirmation && !confirmed)) return;
    actionInFlight.current = true;
    setActionError(null);
    setActionReceipt(null);
    try {
      const result = await resumeMutation.mutate({ runId, token,
        ...confirmation.input,
      });
      if (TERMINAL_STATUSES.has(result.run.status)) {
        const message = `运行已结束（${result.run.status}），请核对最新运行状态。`;
        addFlash('info', message);
        setActionReceipt(message);
      } else {
        const message = '已受理恢复，请观察原运行。';
        addFlash('success', message);
        setActionReceipt(message);
      }
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '恢复运行失败',
      );
      setActionError(err instanceof Error ? err.message : '恢复运行失败');
      confirmation.setConfirmed(false);
    } finally {
      actionInFlight.current = false;
      refreshObservations();
    }
  };

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (actionInFlight.current) return;
    setActionReceipt(null);
    if (!canRetryCancel && pendingAction !== 'cancel') {
      setPendingAction('cancel');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setPendingAction(null), 3000);
      return;
    }

    // Second click — execute
    setPendingAction(null);
    if (timerRef.current) clearTimeout(timerRef.current);

    actionInFlight.current = true;
    setActionError(null);
    try {
      const result = await cancelMutation.mutate({ runId, token });
      // A successful request can return an already passed/failed run. The
      // server's terminal winner, not the clicked action, determines feedback.
      const label = `运行 ${runId.slice(0, 8)}`;
      if (result.run.status === 'cancelled') {
        const message = `${label} 已记录取消；这不代表所有后台进程已退出。`;
        addFlash('success', message);
        setActionReceipt(message);
      } else if (result.run.status === 'passed' || result.run.status === 'failed') {
        const state = result.run.status === 'passed' ? '已完成' : '已失败';
        const message = `${label}${state}，未改为取消。`;
        addFlash('info', message);
        setActionReceipt(message);
      } else {
        const message = `${label}的取消请求已返回，请核对最新运行状态。`;
        addFlash('info', message);
        setActionReceipt(message);
      }
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '取消请求失败',
      );
      setActionError(err instanceof Error ? err.message : '取消请求失败');
    } finally {
      actionInFlight.current = false;
      refreshObservations();
    }
  };

  const isPending =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    cancelMutation.isPending;

  const btnClass = compact
    ? 'btn btn-ghost btn-sm'
    : 'btn btn-secondary btn-sm';
  const { canPause, canResume, canCancel, canView } =
    runControlAffordances(status);

  return (
    <div
      className="flex gap-2 run-controls"
      style={{ alignItems: 'center', flexWrap: 'wrap' }}
      role="group"
      aria-label="运行控制"
    >
      {status === 'cancelled' && (
        <p className="run-recovery-notice">
          已记录取消。{cancelRecovery
            ? `${cancelRecovery.needsControlRetry ? '取消控制待重试。' : '取消控制无需补发。'}${cancelRecovery.needsObservationRepair ? '运行观察待修复。' : ''}${cancelRecovery.exitStatus === 'confirmed' ? '已确认 Tekon 受管理执行句柄退出；不代表所有后台进程已退出。' : '退出未确认；请检查旧进程。'}`
            : '恢复信息未知，无法确认退出；请刷新后核对。'}
        </p>
      )}
      {actionError && <p className="run-recovery-error">{actionError}</p>}
      {actionReceipt && (
        <div className="run-control-receipt" role="status" aria-live="polite">
          <span>{actionReceipt}</span>
          <button
            type="button"
            className="flash-dismiss"
            aria-label="关闭运行回执"
            onClick={() => setActionReceipt(null)}
          >
            ✕
          </button>
        </div>
      )}
      {canResume && <ResumeConfirmation recovery={recovery} checked={confirmed} disabled={isPending} onChange={confirmation.setConfirmed} />}
      {canPause && (
        <button
          type="button"
          className={btnClass}
          title="暂停运行"
          aria-label="暂停运行"
          disabled={isPending}
          onClick={handlePause}
        >
          {compact ? '⏸' : '暂停'}
        </button>
      )}

      {canResume && (
        <button
          type="button"
          className={btnClass}
          title="恢复运行"
          aria-label="恢复运行"
          disabled={isPending || Boolean(resumeRecovery?.requiresConfirmation && !confirmed)}
          onClick={handleResume}
        >
          {compact ? '▶' : '恢复'}
        </button>
      )}

      {(canCancel || canRetryCancel) && (
        <button
          type="button"
          className={
            compact ? 'btn btn-ghost btn-sm' : 'btn btn-danger btn-sm'
          }
          title="取消运行"
          aria-label={
            canRetryCancel ? '重试取消运行' : pendingAction === 'cancel' ? '确认取消运行' : '请求取消运行'
          }
          disabled={isPending}
          onClick={handleCancel}
        >
          {canRetryCancel ? '重试取消' : pendingAction === 'cancel'
            ? '确认取消？'
            : compact
              ? '✕'
              : '取消'}
        </button>
      )}

      {canView && onView && (
        <button
          type="button"
          className={btnClass}
          title="查看运行详情"
          aria-label="查看运行详情"
          onClick={(e) => {
            e.stopPropagation();
            onView(runId);
          }}
        >
          {compact ? '👁' : '查看详情'}
        </button>
      )}
    </div>
  );
}
