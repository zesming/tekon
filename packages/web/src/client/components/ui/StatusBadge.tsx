// ---------------------------------------------------------------------------
// StatusBadge — color-coded pill for workflow statuses.
// Pass `label` to override the displayed text (e.g. Chinese labels);
// otherwise the raw status string is shown.
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

const STATUS_LABEL_MAP: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  paused: '已暂停',
  blocked: '已阻塞',
  cancelled: '已取消',
};

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md' | 'lg';
  /** Override the displayed text; falls back to STATUS_LABEL_MAP lookup, then raw status. */
  label?: string;
}

export function StatusBadge({ status, size = 'md', label }: StatusBadgeProps) {
  const badgeClass = statusClassMap[status] ?? 'badge-cancelled';
  const sizeClass = size !== 'md' ? ` badge-${size}` : '';
  const display = label ?? STATUS_LABEL_MAP[status] ?? status;

  return (
    <span className={`badge ${badgeClass}${sizeClass}`} title={status}>
      {display}
    </span>
  );
}
