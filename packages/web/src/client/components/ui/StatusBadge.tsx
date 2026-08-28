// ---------------------------------------------------------------------------
// StatusBadge — color-coded pill for workflow, session, and job statuses.
// Pass `label` to override the displayed text (e.g. product-specific copy);
// otherwise the shared Chinese status label is used.
// ---------------------------------------------------------------------------

const statusClassMap: Record<string, string> = {
  // Workflow / run statuses.
  passed: 'badge-passed',
  running: 'badge-running',
  pending: 'badge-pending',
  failed: 'badge-failed',
  paused: 'badge-paused',
  blocked: 'badge-blocked',
  cancelled: 'badge-cancelled',
  skipped: 'badge-skipped',
  interrupted: 'badge-interrupted',

  // Session statuses. Reuse the established visual vocabulary instead of
  // falling through to the cancelled style, which made active/done sessions
  // look cancelled in the default Session UI.
  active: 'badge-running',
  idle: 'badge-pending',
  'awaiting-input': 'badge-blocked',
  'awaiting-approval': 'badge-blocked',
  done: 'badge-passed',

  // Job-only transitional status.
  cancelling: 'badge-pending',
};

const STATUS_LABEL_MAP: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  paused: '已暂停',
  blocked: '已阻塞',
  cancelled: '已取消',
  skipped: '已跳过',
  interrupted: '已中断',
  active: '进行中',
  idle: '空闲',
  'awaiting-input': '等待输入',
  'awaiting-approval': '等待审批',
  done: '已完成',
  cancelling: '取消中',
};

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md' | 'lg';
  /** Override the displayed text; falls back to STATUS_LABEL_MAP lookup, then raw status. */
  label?: string;
}

export function StatusBadge({ status, size = 'md', label }: StatusBadgeProps) {
  // Unknown plugin-defined statuses remain visibly neutral. Treating an
  // unknown value as cancelled invents a terminal outcome the product does not
  // actually know.
  const badgeClass = statusClassMap[status] ?? 'badge-skipped';
  const sizeClass = size !== 'md' ? ` badge-${size}` : '';
  const display = label ?? STATUS_LABEL_MAP[status] ?? status;

  return (
    <span className={`badge ${badgeClass}${sizeClass}`} title={status}>
      {display}
    </span>
  );
}
