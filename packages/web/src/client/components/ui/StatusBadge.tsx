// ---------------------------------------------------------------------------
// StatusBadge — color-coded pill for workflow, session, and job statuses.
// Pass `label` to override the displayed text (e.g. product-specific copy);
// otherwise the shared Chinese status label is used. The label map lives in
// lib/status-labels.ts so every surface renders one status under one name.
// ---------------------------------------------------------------------------

import { statusLabel } from '../../lib/status-labels.js';

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

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md' | 'lg';
  /** Override the displayed text; falls back to the shared label, then raw status. */
  label?: string;
}

export function StatusBadge({ status, size = 'md', label }: StatusBadgeProps) {
  // Unknown plugin-defined statuses remain visibly neutral. Treating an
  // unknown value as cancelled invents a terminal outcome the product does not
  // actually know.
  const badgeClass = statusClassMap[status] ?? 'badge-skipped';
  const sizeClass = size !== 'md' ? ` badge-${size}` : '';
  const display = label ?? statusLabel(status);

  return (
    <span className={`badge ${badgeClass}${sizeClass}`} title={status}>
      {display}
    </span>
  );
}
