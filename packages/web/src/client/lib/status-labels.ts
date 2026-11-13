// ---------------------------------------------------------------------------
// Single source of truth for status display labels (UI-02).
//
// Before this module the same state carried different labels on the session
// list, the run table and the run detail (e.g. an interrupted run was rendered
// as "待输入" in one place and "已中断" in another). Every status badge or
// status text must resolve its label through here.
// ---------------------------------------------------------------------------

/** Canonical status → Chinese label. Unknown statuses fall back to the raw value. */
export const STATUS_LABELS: Record<string, string> = {
  // Workflow / run statuses.
  pending: '等待中',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  paused: '已暂停',
  blocked: '已阻塞',
  cancelled: '已取消',
  skipped: '已跳过',
  // There is no input box for an interrupted run in this phase; say what the
  // user can actually do (resume), not the misleading "awaiting input".
  interrupted: '已中断，需恢复',

  // Session statuses.
  active: '进行中',
  idle: '空闲',
  'awaiting-input': '等待输入',
  'awaiting-approval': '等待审批',
  done: '已完成',

  // Job-only transitional status.
  cancelling: '取消中',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export interface SessionLike {
  status: string;
  runStatus?: string | null;
}

/**
 * The one status a session row may badge. Precedence:
 *  - awaiting-approval is a user action, so the actionable session label wins
 *    over the run's paused/blocked state at a human gate;
 *  - a failed session is the authoritative user-visible outcome even when its
 *    run row is still settling (e.g. a crash left the workflow 'running');
 *  - otherwise a run-backed session shows its run status, which keeps an
 *    interrupted run truthful instead of inheriting "awaiting input";
 *  - sessions without a run show their own session status.
 */
export function sessionBadgeStatus(session: SessionLike): string {
  if (session.status === 'awaiting-approval') return 'awaiting-approval';
  if (session.status === 'failed') return 'failed';
  return session.runStatus ?? session.status;
}
