import { useNavigate } from 'react-router';
import { RunControls } from './RunControls.js';
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
          <p className="text-muted text-sm">Loading runs…</p>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <p className="text-muted text-sm">
            No runs found. Start a new run to begin.
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
              {runs.map((run) => (
                <tr
                  key={run.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => navigate(routes.run(run.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(routes.run(run.id));
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="cell-id">{shortId(run.id)}</td>
                  <td>
                    <span className={statusBadge(run.status)}>
                      {run.status}
                    </span>
                  </td>
                  <td
                    className="cell-primary"
                    style={{ maxWidth: 200 }}
                  >
                    <span className="truncate" style={{ display: 'block' }}>
                      {run.demandId || '—'}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted">
                        {run.currentNodeId ?? '—'}
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
                    <RunControls
                      runId={run.id}
                      status={run.status}
                      compact
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
