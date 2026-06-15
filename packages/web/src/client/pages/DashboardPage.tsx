import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useQuery } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { routes } from '../lib/route-paths.js';
import type {
  ProjectOverviewOutput,
  ProjectDetailOutput,
  GateListOutput,
  AuditListOutput,
  ApiWorkflow,
} from '../../shared/api-types.js';

import { Card } from '../components/ui/Card.js';
import { StatusBadge } from '../components/ui/StatusBadge.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EmptyState } from '../components/ui/EmptyState.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a run ID like "wf_7f3a8c2d-…" to "wf_7f3a…e2b1". */
function shortenId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Format an ISO timestamp to a relative string like "12m ago" or "2d ago". */
function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

/** Format a duration between two ISO timestamps like "42m" or "1h 12m". */
function formatDuration(startIso: string, endIso?: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = endMs - startMs;
  if (diffMs < 0) return '0m';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/** Derive the template name from a demandId (e.g. "standard-delivery"). */
function templateFromDemandId(demandId: string): string {
  return demandId;
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'paused';
}

// ---------------------------------------------------------------------------
// DashboardPage
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const navigate = useNavigate();

  // ── 1. Project overview ──────────────────────────────────────────────────
  const overviewQuery = useQuery<ProjectOverviewOutput>(
    'dashboard:overview',
    () => rpc.call('project.overview'),
  );

  const projectId = overviewQuery.data?.project.id ?? 'local';
  const latestRunId = overviewQuery.data?.latestRun?.id ?? null;

  // ── 2. Project detail (full run list) ────────────────────────────────────
  const detailQuery = useQuery<ProjectDetailOutput>(
    overviewQuery.data ? `dashboard:detail:${projectId}` : null,
    () => rpc.call('project.detail', { projectId }),
  );

  const allRuns = detailQuery.data?.runs ?? [];
  const recentRuns = useMemo(() => allRuns.slice(0, 5), [allRuns]);

  // ── 3. Gate data for recent runs (phases progress) ───────────────────────
  const gateRunIdsKey = useMemo(
    () => (recentRuns.length > 0 ? JSON.stringify(recentRuns.map((r) => r.id)) : null),
    [recentRuns],
  );

  const gatesQuery = useQuery<
    Array<{ runId: string; gates: GateListOutput['gates']; pending: GateListOutput['pendingDecisions'] }>
  >(
    gateRunIdsKey ? `dashboard:gates:${gateRunIdsKey}` : null,
    async () => {
      const results = await Promise.allSettled(
        recentRuns.map(async (run) => {
          const gateData = await rpc.call('gate.list', { runId: run.id });
          return { runId: run.id, gates: gateData.gates, pending: gateData.pendingDecisions };
        }),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<typeof results[number] extends PromiseFulfilledResult<infer U> ? U : never> => r.status === 'fulfilled')
        .map((r) => r.value);
    },
  );

  // Build a Map of runId → gate summary for quick lookup
  const gateMap = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; pendingCount: number }>();
    if (gatesQuery.data) {
      for (const entry of gatesQuery.data) {
        const passedCount = entry.gates.filter((g) => g.status === 'passed').length;
        map.set(entry.runId, {
          total: entry.gates.length,
          passed: passedCount,
          pendingCount: entry.pending.length,
        });
      }
    }
    return map;
  }, [gatesQuery.data]);

  // ── 4. Audit chain verification for latest run ──────────────────────────
  const auditQuery = useQuery<AuditListOutput>(
    latestRunId ? `dashboard:audit:${latestRunId}` : null,
    () => rpc.call('audit.list', { runId: latestRunId! }),
  );

  // ── Derived data ────────────────────────────────────────────────────────

  const activeRun: ApiWorkflow | null = useMemo(() => {
    const latest = overviewQuery.data?.latestRun;
    if (latest && isActiveStatus(latest.status)) return latest;
    return allRuns.find((r) => isActiveStatus(r.status)) ?? null;
  }, [overviewQuery.data?.latestRun, allRuns]);

  const counts = overviewQuery.data?.counts;

  // Pass rate from the aggregated gate data of recent runs
  const passRateDisplay = useMemo(() => {
    let totalPassed = 0;
    let totalGates = 0;
    for (const entry of gateMap.values()) {
      totalPassed += entry.passed;
      totalGates += entry.total;
    }
    if (totalGates === 0) return null;
    return {
      pct: Math.round((totalPassed / totalGates) * 100),
      label: `${totalPassed} / ${totalGates} gates passed`,
    };
  }, [gateMap]);

  const activeRunGates = activeRun ? gateMap.get(activeRun.id) : undefined;

  const runningCount = allRuns.filter((r) => r.status === 'running').length;
  const pendingCount = allRuns.filter((r) => r.status === 'pending' || r.status === 'paused').length;

  // ── Loading state ───────────────────────────────────────────────────────
  if (overviewQuery.isLoading) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">项目总览</p>
          </div>
        </header>
        <LoadingState message="Loading project overview..." />
      </>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (overviewQuery.error) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">项目总览</p>
          </div>
        </header>
        <ErrorBanner error={overviewQuery.error} onRetry={overviewQuery.refetch} />
      </>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────
  const subtitleParts = [
    `${allRuns.length} runs`,
    runningCount > 0 ? `${runningCount} running` : null,
    pendingCount > 0 ? `${pendingCount} pending` : null,
  ].filter(Boolean);

  return (
    <>
      {/* ── Header ── */}
      <header className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            项目总览 · {overviewQuery.data?.project.name ?? 'Tekon'}
            {subtitleParts.length > 0 ? ` — ${subtitleParts.join(' · ')}` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              overviewQuery.refetch();
              detailQuery.refetch();
            }}
          >
            ↻ 刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate(routes.runs)}
          >
            + 新建运行
          </button>
        </div>
      </header>

      {/* ── Stat Cards ── */}
      <div className="stat-grid">
        {/* Runs */}
        <div className="stat-card accent-blue">
          <div className="stat-label">运行 Runs</div>
          <div className="stat-value">
            {detailQuery.isLoading ? '…' : allRuns.length}
          </div>
          <div className="stat-sub">
            {runningCount > 0 ? `${runningCount} running` : 'no active runs'}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
          </div>
        </div>

        {/* Pass Rate */}
        <div className="stat-card accent-green">
          <div className="stat-label">通过率 Pass Rate</div>
          <div className="stat-value">
            {passRateDisplay !== null ? (
              <>
                {passRateDisplay.pct}
                <span style={{ fontSize: '18px', color: 'var(--text-s)' }}>%</span>
              </>
            ) : (
              <span style={{ fontSize: '18px', color: 'var(--text-t)' }}>—</span>
            )}
          </div>
          <div className="stat-sub">
            {passRateDisplay !== null ? passRateDisplay.label : 'no gate data'}
          </div>
        </div>

        {/* Artifacts */}
        <div className="stat-card accent-violet">
          <div className="stat-label">产物 Artifacts</div>
          <div className="stat-value">{counts?.artifacts ?? 0}</div>
          <div className="stat-sub">
            latest run{counts && counts.artifacts === 1 ? '' : 's'}
          </div>
        </div>

        {/* Pending approvals */}
        <div className="stat-card accent-amber">
          <div className="stat-label">待审批 Pending</div>
          <div className="stat-value">{counts?.pendingApprovals ?? 0}</div>
          <div className="stat-sub">
            {counts && counts.pendingApprovals > 0
              ? 'human gates awaiting'
              : 'no pending approvals'}
          </div>
        </div>

        {/* Audit chain */}
        <div className="stat-card accent-green">
          <div className="stat-label">审计链 Audit</div>
          <div className="stat-value" style={{ fontSize: '22px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {auditQuery.isLoading ? (
              <span style={{ color: 'var(--text-t)' }}>…</span>
            ) : auditQuery.data?.verification.valid ? (
              <>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  fill="none"
                  stroke="#10B981"
                  strokeWidth="2"
                >
                  <path d="M2 9l5 5L16 4" />
                </svg>
                Valid
              </>
            ) : (
              <>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  fill="none"
                  stroke="#EF4444"
                  strokeWidth="2"
                >
                  <path d="M4 4l10 10M14 4L4 14" />
                </svg>
                Invalid
              </>
            )}
          </div>
          <div className="stat-sub">
            {auditQuery.data
              ? `${auditQuery.data.events.length} events · chain ${auditQuery.data.verification.valid ? 'intact' : 'broken'}`
              : latestRunId
                ? 'verifying…'
                : 'no runs to audit'}
          </div>
        </div>
      </div>

      {/* ── Recent Runs Table ── */}
      <Card
        title="最近运行 Recent Runs"
        full
        headerRight={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(routes.runs)}
          >
            查看全部 →
          </button>
        }
        compact
        className="mb-6"
      >
        {detailQuery.isLoading ? (
          <LoadingState message="加载运行列表..." />
        ) : detailQuery.error ? (
          <div style={{ padding: '16px' }}>
            <ErrorBanner error={detailQuery.error} onRetry={detailQuery.refetch} />
          </div>
        ) : allRuns.length === 0 ? (
          <EmptyState
            message="No runs yet"
            hint="Start your first workflow run to see it here."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Status</th>
                  <th>Template</th>
                  <th>Phases</th>
                  <th>Duration</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => {
                  const gates = gateMap.get(run.id);
                  const hasGates = gates !== undefined && gates.total > 0;

                  return (
                    <tr
                      key={run.id}
                      onClick={() => navigate(routes.run(run.id))}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="cell-id">{shortenId(run.id)}</td>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="cell-primary">
                        {templateFromDemandId(run.demandId)}
                      </td>
                      <td className="cell-mono">
                        {hasGates
                          ? `${gates.passed}/${gates.total}`
                          : '—'}
                      </td>
                      <td className="cell-mono">
                        {formatDuration(run.createdAt, run.updatedAt)}
                      </td>
                      <td className="cell-secondary">
                        {formatRelativeTime(run.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Bottom Panel Grid: Active Run + Pending Approvals ── */}
      <div className="panel-grid">
        {/* Active Run */}
        <Card
          title="当前运行 Active Run"
          headerRight={
            activeRun !== null ? (
              <StatusBadge status={activeRun.status} />
            ) : null
          }
        >
          {activeRun === null ? (
            <EmptyState
              message="No active runs"
              hint="Running workflows will appear here."
            />
          ) : (
            <div
              onClick={() => navigate(routes.run(activeRun.id))}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ marginBottom: '14px' }}>
                <div className="text-mono text-muted" style={{ marginBottom: '4px' }}>
                  {shortenId(activeRun.id)}
                </div>
                <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>
                  {templateFromDemandId(activeRun.demandId)}
                </div>
                <div className="text-sm text-muted">
                  {templateFromDemandId(activeRun.demandId)} · {formatRelativeTime(activeRun.createdAt)}
                </div>
              </div>

              {activeRunGates !== undefined && activeRunGates.total > 0 ? (
                <>
                  <div
                    className="text-sm text-muted"
                    style={{ fontWeight: 600, marginBottom: '6px' }}
                  >
                    Progress · {activeRunGates.passed}/{activeRunGates.total} gates
                  </div>
                  <div className="readiness-bar">
                    <div
                      className={`readiness-fill ${progressLevel(activeRunGates.passed / activeRunGates.total)}`}
                      style={{
                        width: `${Math.round((activeRunGates.passed / activeRunGates.total) * 100)}%`,
                      }}
                    />
                  </div>
                </>
              ) : null}

              <div className="mt-4 text-sm" style={{ color: 'var(--text-s)' }}>
                <div
                  className="flex justify-between"
                  style={{ marginBottom: '6px' }}
                >
                  <span>Duration</span>
                  <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                    {formatDuration(activeRun.createdAt, activeRun.updatedAt)}
                  </span>
                </div>
                <div
                  className="flex justify-between"
                  style={{ marginBottom: '6px' }}
                >
                  <span>Status</span>
                  <StatusBadge status={activeRun.status} size="sm" />
                </div>
                {activeRunGates !== undefined && activeRunGates.pendingCount > 0 ? (
                  <div className="flex justify-between">
                    <span>Pending approvals</span>
                    <span style={{ fontWeight: 600, color: 'var(--pend)' }}>
                      {activeRunGates.pendingCount}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </Card>

        {/* Pending Approvals Preview */}
        <Card
          title="待审批 Pending"
          headerRight={
            counts && counts.pendingApprovals > 0 ? (
              <span className="badge badge-pending">
                {counts.pendingApprovals} waiting
              </span>
            ) : null
          }
        >
          {!counts || counts.pendingApprovals === 0 ? (
            <EmptyState
              message="No pending approvals"
              hint="Human gates awaiting approval will appear here."
            />
          ) : (
            <>
              {/* Show per-run pending breakdown from gate data */}
              {gatesQuery.data
                ?.filter((entry) => entry.pending.length > 0)
                .map((entry) => (
                  <div
                    key={entry.runId}
                    style={{
                      padding: '10px 0',
                      borderBottom: '1px solid var(--border-l)',
                    }}
                  >
                    <div
                      className="flex items-center gap-2"
                      style={{ marginBottom: '6px' }}
                    >
                      <StatusBadge status="pending" size="sm" />
                      <span className="text-sm" style={{ fontWeight: 600 }}>
                        {shortenId(entry.runId)}
                      </span>
                    </div>
                    <div className="text-sm text-muted">
                      {entry.pending.length} pending decision
                      {entry.pending.length > 1 ? 's' : ''}
                    </div>
                  </div>
                )) ?? (
                  <div style={{ padding: '10px 0' }}>
                    <div
                      className="flex items-center gap-2"
                      style={{ marginBottom: '6px' }}
                    >
                      <StatusBadge status="pending" size="sm" />
                      <span className="text-sm" style={{ fontWeight: 600 }}>
                        human gates
                      </span>
                    </div>
                    <div className="text-sm text-muted">
                      {counts.pendingApprovals} pending approval
                      {counts.pendingApprovals > 1 ? 's' : ''}
                    </div>
                  </div>
                )}
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-2"
                style={{ width: '100%' }}
                onClick={() => navigate(routes.approvals)}
              >
                查看审批 →
              </button>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function progressLevel(ratio: number): 'high' | 'medium' | 'low' {
  if (ratio >= 0.6) return 'high';
  if (ratio >= 0.3) return 'medium';
  return 'low';
}
