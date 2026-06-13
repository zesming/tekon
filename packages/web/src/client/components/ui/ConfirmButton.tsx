import { useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// ConfirmButton — two-click confirm for destructive / high-risk actions
// ---------------------------------------------------------------------------

interface ConfirmButtonProps {
  /** Label shown in the idle state */
  label: ReactNode;
  /** Label shown in the "are you sure?" state */
  confirmLabel?: ReactNode;
  /** Called when the user confirms the action */
  onConfirm: () => void | Promise<void>;
  /** Visual variant */
  variant?: 'danger' | 'primary' | 'secondary';
  /** Size */
  size?: 'sm' | 'md';
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Auto-reset delay in ms (0 = no auto-reset) */
  resetMs?: number;
}

export function ConfirmButton({
  label,
  confirmLabel = '确定？',
  onConfirm,
  variant = 'danger',
  size = 'md',
  disabled = false,
  resetMs = 3000,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (busy) return;

    if (!armed) {
      setArmed(true);
      if (resetMs > 0) {
        timerRef.current = setTimeout(() => {
          setArmed(false);
          timerRef.current = null;
        }, resetMs);
      }
      return;
    }

    // Armed — execute the action
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }, [armed, busy, onConfirm, resetMs]);

  const sizeClass = size !== 'md' ? ` btn-${size}` : '';
  const variantClass = `btn-${variant}`;

  return (
    <button
      type="button"
      className={`btn ${variantClass}${sizeClass}${armed ? ' armed' : ''}`}
      disabled={disabled || busy}
      onClick={handleClick}
      style={armed ? { animation: 'confirmPulse 0.3s ease' } : undefined}
    >
      {busy ? '...' : armed ? confirmLabel : label}
      <style>{`
        @keyframes confirmPulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.05); }
          100% { transform: scale(1); }
        }
      `}</style>
    </button>
  );
}
