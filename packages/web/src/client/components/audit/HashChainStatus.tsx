import type { AuditVerification } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// HashChainStatus — verification status badge for audit chain
// ---------------------------------------------------------------------------

interface HashChainStatusProps {
  verification: AuditVerification;
  eventCount: number;
}

export function HashChainStatus({
  verification,
  eventCount,
}: HashChainStatusProps) {
  const isValid = verification.valid;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`badge badge-sm ${isValid ? 'badge-passed' : 'badge-failed'}`}
      >
        chain {isValid ? '✓' : '✕'}
      </span>
      <span className="text-sm text-muted">{eventCount} events</span>
    </div>
  );
}
