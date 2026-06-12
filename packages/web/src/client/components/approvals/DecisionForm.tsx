import { useState, useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// DecisionForm — note input + Approve / Reject buttons (two-step confirmation)
// ---------------------------------------------------------------------------

interface DecisionFormProps {
  /** Risk label from the decision context (used to decide if reject needs confirmation) */
  riskLabel: string;
  /** Whether a mutation is currently in flight */
  isPending: boolean;
  /** Called with the note text when the user approves */
  onApprove: (note: string) => void | Promise<void>;
  /** Called with the note text when the user rejects */
  onReject: (note: string) => void | Promise<void>;
}

export function DecisionForm({
  isPending,
  onApprove,
  onReject,
}: DecisionFormProps) {
  const [note, setNote] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending-action timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleReset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setPendingAction(null), 3000);
  }, []);

  const handleApproveClick = useCallback(async () => {
    if (pendingAction !== 'approve') {
      setPendingAction('approve');
      scheduleReset();
      return;
    }
    // Second click — execute
    setPendingAction(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    await onApprove(note);
    setNote('');
  }, [pendingAction, note, onApprove, scheduleReset]);

  const handleRejectClick = useCallback(async () => {
    if (pendingAction !== 'reject') {
      setPendingAction('reject');
      scheduleReset();
      return;
    }
    // Second click — execute
    setPendingAction(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    await onReject(note);
    setNote('');
  }, [pendingAction, note, onReject, scheduleReset]);

  return (
    <div className="approval-actions" style={{ flexDirection: 'column', gap: '12px' }}>
      <input
        type="text"
        className="approval-note"
        placeholder="添加备注（可选）..."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={isPending}
      />
      <div className="flex gap-3 items-center" style={{ width: '100%' }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={isPending}
          onClick={handleApproveClick}
        >
          {isPending
            ? '处理中...'
            : pendingAction === 'approve'
              ? '确认批准?'
              : '✓ Approve'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={isPending}
          onClick={handleRejectClick}
        >
          {isPending
            ? '处理中...'
            : pendingAction === 'reject'
              ? '确认拒绝?'
              : '✗ Reject'}
        </button>
      </div>
    </div>
  );
}
