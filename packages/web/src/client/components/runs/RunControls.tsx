import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { routes } from '../../lib/route-paths.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunControlsProps {
  runId: string;
  status: string;
  /** Compact mode for table rows */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Pause / Resume / Cancel action buttons for a workflow run.
 * Only renders the actions that are valid for the current status.
 */
export function RunControls({ runId, status, compact }: RunControlsProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();
  const navigate = useNavigate();

  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending-action timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const invalidateKeys = ['project.detail', 'project.overview', 'review:', 'gate:', 'audit:'];

  const pauseMutation = useMutation<
    RpcProcedureMap['project.pause']['input'],
    RpcProcedureMap['project.pause']['output']
  >(
    (input) => rpc.call('project.pause', input),
    { invalidateKeys },
  );

  const resumeMutation = useMutation<
    RpcProcedureMap['project.resume']['input'],
    RpcProcedureMap['project.resume']['output']
  >(
    (input) => rpc.call('project.resume', input),
    { invalidateKeys },
  );

  const cancelMutation = useMutation<
    RpcProcedureMap['project.cancel']['input'],
    RpcProcedureMap['project.cancel']['output']
  >(
    (input) => rpc.call('project.cancel', input),
    { invalidateKeys },
  );

  if (!token) return null;

  const handlePause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await pauseMutation.mutate({ runId, token });
      addFlash('success', `运行 ${runId.slice(0, 8)} 已暂停`);
    } catch (err) {
      addFlash('error', err instanceof Error ? err.message : '暂停失败');
    }
  };

  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await resumeMutation.mutate({ runId, token });
      addFlash('success', `运行 ${runId.slice(0, 8)} 已恢复`);
    } catch (err) {
      addFlash('error', err instanceof Error ? err.message : '恢复失败');
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
      addFlash('success', `运行 ${runId.slice(0, 8)} 已取消`);
    } catch (err) {
      addFlash('error', err instanceof Error ? err.message : '取消失败');
    }
  };

  const isPending =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    cancelMutation.isPending;

  const btnClass = compact ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm';

  return (
    <div className="flex gap-2" style={{ alignItems: 'center' }}>
      {(status === 'running') && (
        <button
          type="button"
          className={btnClass}
          title="暂停"
          disabled={isPending}
          onClick={handlePause}
        >
          ⏸
        </button>
      )}

      {(status === 'paused') && (
        <button
          type="button"
          className={btnClass}
          title="恢复"
          disabled={isPending}
          onClick={handleResume}
        >
          ▶
        </button>
      )}

      {(status === 'running' || status === 'paused') && (
        <button
          type="button"
          className={compact ? 'btn btn-ghost btn-sm' : 'btn btn-danger btn-sm'}
          title="取消"
          disabled={isPending}
          onClick={handleCancel}
        >
          {pendingAction === 'cancel' ? '确认取消?' : '✕'}
        </button>
      )}

      {(status === 'passed' || status === 'failed' || status === 'cancelled') && (
        <button
          type="button"
          className={btnClass}
          title="查看详情"
          onClick={(e) => {
            e.stopPropagation();
            navigate(routes.run(runId));
          }}
        >
          👁
        </button>
      )}
    </div>
  );
}
