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
      addFlash('success', `Run ${runId.slice(0, 8)} paused`);
    } catch (err) {
      addFlash('error', err instanceof Error ? err.message : 'Failed to pause run');
    }
  };

  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await resumeMutation.mutate({ runId, token });
      addFlash('success', `Run ${runId.slice(0, 8)} resumed`);
    } catch (err) {
      addFlash('error', err instanceof Error ? err.message : 'Failed to resume run');
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
      addFlash('error', err instanceof Error ? err.message : 'Failed to cancel run');
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
          title="Pause"
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
          title="Resume"
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
          title="Cancel"
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
          title="View details"
          onClick={(e) => e.stopPropagation()}
        >
          👁
        </button>
      )}
    </div>
  );
}
