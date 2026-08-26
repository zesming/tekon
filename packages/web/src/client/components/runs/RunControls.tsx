import { useState, useEffect, useRef } from 'react';
import { useMutation } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunControlsProps {
  runId: string;
  status: string;
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
  compact,
  onView,
}: RunControlsProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();

  const [pendingAction, setPendingAction] = useState<string | null>(null);
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
  ];

  const pauseMutation = useMutation<
    RpcProcedureMap['project.pause']['input'],
    RpcProcedureMap['project.pause']['output']
  >((input) => rpc.call('project.pause', input), { invalidateKeys });

  const resumeMutation = useMutation<
    RpcProcedureMap['project.resume']['input'],
    RpcProcedureMap['project.resume']['output']
  >((input) => rpc.call('project.resume', input), { invalidateKeys });

  const cancelMutation = useMutation<
    RpcProcedureMap['project.cancel']['input'],
    RpcProcedureMap['project.cancel']['output']
  >((input) => rpc.call('project.cancel', input), { invalidateKeys });

  if (!token) return null;

  const handlePause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await pauseMutation.mutate({ runId, token });
      addFlash('success', `Run ${runId.slice(0, 8)} paused`);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to pause run',
      );
    }
  };

  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await resumeMutation.mutate({ runId, token });
      addFlash('success', `Run ${runId.slice(0, 8)} resumed`);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to resume run',
      );
    }
  };

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (pendingAction !== 'cancel') {
      setPendingAction('cancel');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setPendingAction(null), 3000);
      return;
    }

    // Second click — execute
    setPendingAction(null);
    if (timerRef.current) clearTimeout(timerRef.current);

    try {
      await cancelMutation.mutate({ runId, token });
      addFlash('success', `Run ${runId.slice(0, 8)} cancelled`);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to cancel run',
      );
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
      className="flex gap-2"
      style={{ alignItems: 'center' }}
      role="group"
      aria-label="运行控制"
    >
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
          disabled={isPending}
          onClick={handleResume}
        >
          {compact ? '▶' : '恢复'}
        </button>
      )}

      {canCancel && (
        <button
          type="button"
          className={
            compact ? 'btn btn-ghost btn-sm' : 'btn btn-danger btn-sm'
          }
          title="取消运行"
          aria-label={
            pendingAction === 'cancel' ? '确认取消运行' : '请求取消运行'
          }
          disabled={isPending}
          onClick={handleCancel}
        >
          {pendingAction === 'cancel'
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
