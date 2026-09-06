import { useNavigate } from 'react-router';
import { RunControls } from './RunControls.js';
import {
  admissionNeedsRecovery,
  admissionReadinessLabel,
} from './AdmissionNotice.js';
import { routes } from '../../lib/route-paths.js';
import type { z } from 'zod';
import type { apiWorkflowSchema } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiWorkflow = z.output<typeof apiWorkflowSchema>;

export interface RunTableProps {
  runs: ApiWorkflow[];
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<string, string> = {
  running: 'badge badge-running',
  passed: 'badge badge-passed',
  failed: 'badge badge-failed',
  paused: 'badge badge-paused',
  pending: 'badge badge-pending',
  blocked: 'badge badge-blocked',
  cancelled: 'badge badge-cancelled',
  interrupted: 'badge badge-interrupted',
};

function statusBadge(status: string) {
  return STATUS_BADGE[status] ?? 'badge badge-pending';
}

function shortId(id: string) {
  if (id.length <= 16) return id;
  return `${id.slice(0, 7)}…${id.slice(-4)}`;
}

function formatDuration(createdAt: string, updatedAt: string): string {
  const start = new Date(createdAt).getTime();
  const end = new Date(updatedAt).getTime();
  const diffMs = Math.max(0, end - start);
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Sortable runs table matching the design mockup layout.
 */
export function RunTable({ runs, isLoading }: RunTableProps) {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="card">
        <div className="card-body">
          <p className="text-muted text-sm">加载运行列表...</p>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <p className="text-muted text-sm">
            暂无运行记录。启动新运行后将在此显示。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-body compact">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Status</th>
                <th>Demand</th>
                <th>Progress</th>
                <th>Duration</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const status = run.recovery ? run.recovery.runStatus ?? 'unknown' : run.status;
                return (
                <tr
                  key={run.id}
                  tabIndex={0}
                  role="button"
                  onClick={(event) => {
                    // 表内控件保留自身行为，只有普通单元格点击才进入详情。
                    if (event.target instanceof Element && event.target.closest('button, input, label, a, select, textarea')) return;
                    navigate(routes.run(run.id));
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(routes.run(run.id));
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="cell-id">{shortId(run.id)}</td>
                  <td>
                    <span
                      className={statusBadge(
                        admissionNeedsRecovery(run) ? 'pending' : status,
                      )}
                    >
                      {admissionNeedsRecovery(run)
                        ? admissionReadinessLabel(run)
                        : status}
                    </span>
                  </td>
                  <td className="cell-primary" style={{ maxWidth: 200 }}>
                    <span
                      className="truncate"
                      style={{ display: 'block' }}
                      title={run.demandTitle ?? run.demandId}
                    >
                      {run.demandTitle || run.demandId || '—'}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted">
                        {admissionNeedsRecovery(run)
                          ? '任务尚未执行'
                          : (run.currentNodeId ?? '—')}
                      </span>
                    </div>
                  </td>
                  <td className="cell-mono">
                    {formatDuration(run.createdAt, run.updatedAt)}
                  </td>
                  <td className="cell-secondary">
                    {formatRelativeTime(run.createdAt)}
                  </td>
                  <td>
                    {admissionNeedsRecovery(run) ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(routes.run(run.id));
                        }}
                      >
                        观察
                      </button>
                    ) : (
                      <RunControls
                        runId={run.id}
                        status={status}
                        recovery={run.recovery}
                        compact
                        onView={(id) => navigate(routes.run(id))}
                      />
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
