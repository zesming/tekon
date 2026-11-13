import { useParams } from 'react-router';

import { useQuery, useAuthScope } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { ApiWorkReviewSurface } from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { StatusBadge } from '../../components/ui/StatusBadge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readinessLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// ProgressTab — workflow progress and gate timeline from review.get.
//
// PD-13: the former "Command Progress" card read *.progress.json only from the
// run directory root, while the gateway writes them under commands/, gates/ and
// per-node directories, so it was always empty. It was removed rather than
// fixed; a node timeline backed by the event stream replaces it in a later
// phase. The `progress.list` RPC itself stays for other callers.
// ---------------------------------------------------------------------------

export function ProgressTab() {
  const { runId } = useParams<{ runId: string }>();
  const scope = useAuthScope();

  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    runId ? queryKeys.reviewDetail(runId, scope) : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  if (reviewQuery.isLoading)
    return <LoadingState message="加载进度中..." />;
  if (reviewQuery.error)
    return (
      <ErrorBanner
        error={reviewQuery.error}
        onRetry={() => reviewQuery.refetch()}
      />
    );

  const surface = reviewQuery.data;
  if (!surface) return null;

  // Gate stats from the review surface.
  const gates = surface.gates ?? [];
  const totalGates = gates.length;
  const passedGates = gates.filter((g) => g.status === 'passed').length;
  const failedGates = gates.filter((g) => g.status === 'failed').length;
  const runningGates = gates.filter((g) => g.status === 'running').length;
  const pendingGates = totalGates - passedGates - failedGates - runningGates;
  const progressPct =
    totalGates > 0 ? Math.round((passedGates / totalGates) * 100) : 0;

  return (
    <>
      {/* ── Workflow Gate Summary ── */}
      <Card title="运行进度 Workflow Progress" className="mb-6">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '16px',
            flexWrap: 'wrap',
          }}
        >
          <StatusBadge status={surface.workflowStatus} />
          <span className="text-sm text-muted">
            {passedGates}/{totalGates} gates passed
          </span>
        </div>

        <div className="readiness-bar" style={{ height: '8px' }}>
          <div
            className={`readiness-fill ${readinessLevel(progressPct / 100)}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '16px',
            marginTop: '20px',
            textAlign: 'center',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '28px',
                fontWeight: 500,
                color: 'var(--pass)',
              }}
            >
              {passedGates}
            </div>
            <div className="stat-label">Passed</div>
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '28px',
                fontWeight: 500,
                color: failedGates > 0 ? 'var(--fail)' : 'var(--text-t)',
              }}
            >
              {failedGates}
            </div>
            <div className="stat-label">Failed</div>
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '28px',
                fontWeight: 500,
                color: runningGates > 0 ? 'var(--pend)' : 'var(--text-t)',
              }}
            >
              {runningGates}
            </div>
            <div className="stat-label">Running</div>
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '28px',
                fontWeight: 500,
                color: pendingGates > 0 ? 'var(--pend)' : 'var(--text-t)',
              }}
            >
              {pendingGates}
            </div>
            <div className="stat-label">Pending</div>
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '28px',
                fontWeight: 500,
              }}
            >
              {surface.artifacts.length}
            </div>
            <div className="stat-label">Artifacts</div>
          </div>
        </div>
      </Card>

      {/* ── Gate Timeline ── */}
      {gates.length > 0 ? (
        <Card title="门禁时间线 Gate Timeline">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Gate Type</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Retries</th>
                </tr>
              </thead>
              <tbody>
                {gates
                  .slice()
                  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                  .map((gate) => (
                    <tr key={gate.id}>
                      <td className="cell-mono">{gate.nodeId}</td>
                      <td className="cell-primary">{gate.gateType}</td>
                      <td>
                        <StatusBadge status={gate.status} size="sm" />
                      </td>
                      <td className="cell-mono">
                        {gate.durationMs < 1000
                          ? `${gate.durationMs}ms`
                          : `${(gate.durationMs / 1000).toFixed(1)}s`}
                      </td>
                      <td className="cell-mono">
                        {gate.retries > 0 ? gate.retries : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
