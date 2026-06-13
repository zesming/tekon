import { NavLink, Outlet, useParams } from 'react-router';

import { useQuery } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { routes } from '../lib/route-paths.js';
import type {
  ApiWorkReviewSurface,
} from '../../shared/api-types.js';

import { StatusBadge } from '../components/ui/StatusBadge.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { RunControls } from '../components/runs/RunControls.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an ISO timestamp to a date-time string like "2026-06-12 14:32". */
function formatDateTime(isoDate: string): string {
  const d = new Date(isoDate);
  const datePart = d.toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const timePart = d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart} ${timePart}`;
}

/** Format duration between two ISO timestamps. */
function formatDuration(startIso: string, endIso?: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = endMs - startMs;
  if (diffMs < 0) return '0s';
  const totalSec = Math.floor(diffMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

/** Derive agent from demand title or return a fallback. */
function deriveAgent(surface: ApiWorkReviewSurface): string {
  // The review surface doesn't directly expose an agent field; use a heuristic
  // or just display a placeholder. We could add this to the API later.
  return '—';
}

// ---------------------------------------------------------------------------
// RunDetailPage — parent layout with breadcrumb, header, controls, tabs
// ---------------------------------------------------------------------------

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();

  // Fetch the full review surface for this run
  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    runId ? `review:${runId}` : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  // ── Loading state ──
  if (reviewQuery.isLoading) {
    return (
      <>
        <nav className="breadcrumb">
          <NavLink to={routes.runs}>运行列表 Runs</NavLink>
          <span>›</span>
          <span>{runId ?? '…'}</span>
        </nav>
        <LoadingState message="Loading run details..." />
      </>
    );
  }

  // ── Error state ──
  if (reviewQuery.error || !reviewQuery.data) {
    return (
      <>
        <nav className="breadcrumb">
          <NavLink to={routes.runs}>运行列表 Runs</NavLink>
          <span>›</span>
          <span>{runId ?? '…'}</span>
        </nav>
        <ErrorBanner
          error={reviewQuery.error ?? new Error('Run not found')}
          onRetry={reviewQuery.refetch}
        />
      </>
    );
  }

  const surface = reviewQuery.data;
  const status = surface.workflowStatus;
  const demandTitle = surface.demand.title || surface.demand.body.slice(0, 80);
  const shortId = runId
    ? runId.length > 14
      ? `${runId.slice(0, 8)}…${runId.slice(-4)}`
      : runId
    : '—';

  // Compute total gate counts
  const totalGates = surface.gates.length;
  const passedGates = surface.gates.filter((g) => g.status === 'passed').length;
  const failedGates = surface.gates.filter((g) => g.status === 'failed').length;
  const skippedGates = surface.gates.filter((g) => g.status === 'skipped').length;
  const blockedGates = surface.gates.filter((g) => g.status === 'blocked').length;
  const pendingGates = surface.gates.filter((g) => g.status === 'pending').length;

  // Find the earliest gate timestamp as a proxy for run start
  const earliestGate = surface.gates.reduce<string | null>((earliest, g) => {
    if (!earliest || g.createdAt < earliest) return g.createdAt;
    return earliest;
  }, null);

  // Find latest gate timestamp as a proxy for run end (for finished runs)
  const latestGate = surface.gates.reduce<string | null>((latest, g) => {
    if (!latest || g.createdAt > latest) return g.createdAt;
    return latest;
  }, null);

  const isFinished =
    status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
  const duration = earliestGate
    ? formatDuration(earliestGate, isFinished ? latestGate ?? undefined : undefined)
    : '—';

  const dateDisplay = earliestGate ? formatDateTime(earliestGate) : '—';

  return (
    <>
      {/* ── Breadcrumb ── */}
      <nav className="breadcrumb">
        <NavLink to={routes.runs}>运行列表 Runs</NavLink>
        <span>›</span>
        <span>{shortId}</span>
      </nav>

      {/* ── Run Header ── */}
      <div className="run-header">
        <div>
          <div className="run-header-id">{runId}</div>
          <div className="run-header-demand">{demandTitle}</div>
          <div className="run-header-meta">
            <StatusBadge status={status} />
            <span>📋 {surface.demand.id || '—'}</span>
            <span>🤖 {deriveAgent(surface)}</span>
            <span>⏱ {duration}</span>
            <span>📅 {dateDisplay}</span>
          </div>
        </div>
        <div className="run-header-actions">
          <RunControls runId={runId!} status={status} />
        </div>
      </div>

      {/* ── Tab Navigation ── */}
      <div className="tabs">
        <NavLink
          to="."
          end
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Overview
        </NavLink>
        <NavLink
          to="artifacts"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Artifacts
        </NavLink>
        <NavLink
          to="gates"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Gates
        </NavLink>
        <NavLink
          to="audit"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Audit
        </NavLink>
        <NavLink
          to="delivery"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Delivery
        </NavLink>
        <NavLink
          to="progress"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Progress
        </NavLink>
      </div>

      {/* ── Tab Content ── */}
      <Outlet />
    </>
  );
}
