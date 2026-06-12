// ---------------------------------------------------------------------------
// StatusBadge — color-coded pill for workflow statuses
// ---------------------------------------------------------------------------

const statusClassMap: Record<string, string> = {
  passed: 'badge-passed',
  running: 'badge-running',
  pending: 'badge-pending',
  failed: 'badge-failed',
  paused: 'badge-paused',
  blocked: 'badge-blocked',
  cancelled: 'badge-cancelled',
};

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md' | 'lg';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const badgeClass = statusClassMap[status] ?? 'badge-cancelled';
  const sizeClass = size !== 'md' ? ` badge-${size}` : '';

  return (
    <span className={`badge ${badgeClass}${sizeClass}`}>
      {status}
    </span>
  );
}
