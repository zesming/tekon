import { useParams } from 'react-router';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import type {
  GateListOutput,
  ApiWorkReviewSurface,
} from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { StatusBadge } from '../../components/ui/StatusBadge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const remSec = Math.round(seconds % 60);
  return `${mins}m ${remSec}s`;
}

function gateIconSymbol(status: string): string {
  switch (status) {
    case 'passed':
      return '✓';
    case 'failed':
      return '✕';
    case 'pending':
    case 'running':
      return '◌';
    default:
      return '—';
  }
}

function gateIconClass(status: string): string {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

// ---------------------------------------------------------------------------
// GatesTab — grid of gate results with status, node, duration
// ---------------------------------------------------------------------------

export function GatesTab() {
  const { runId } = useParams<{ runId: string }>();

  const gateQuery = useQuery<GateListOutput>(
    runId ? `gates:${runId}` : null,
    () => rpc.call('gate.list', { runId: runId! }),
  );

  // Also fetch review surface to get failure triage and classification
  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    runId ? `review:${runId}` : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  if (gateQuery.isLoading)
    return <LoadingState message="Loading gates..." />;
  if (gateQuery.error)
    return <ErrorBanner error={gateQuery.error} onRetry={gateQuery.refetch} />;

  const gates = gateQuery.data?.gates ?? [];
  const pendingDecisions = gateQuery.data?.pendingDecisions ?? [];
  const reviewGates = reviewQuery.data?.gates ?? [];
  const triageMap = new Map(
    (reviewQuery.data?.gateFailureTriage ?? []).map((t) => [t.gateId, t]),
  );

  // Merge classification from review surface into gate list
  const reviewGateMap = new Map(reviewGates.map((g) => [g.id, g]));

  const passedCount = gates.filter((g) => g.status === 'passed').length;
  const failedCount = gates.filter((g) => g.status === 'failed').length;
  const pendingCount = gates.filter(
    (g) => g.status !== 'passed' && g.status !== 'failed',
  ).length;

  return (
    <>
      {/* ── Summary ── */}
      <div className="section">
        <div className="section-title">
          门禁结果 Gates{' '}
          <span className="count">
            {passedCount} passed
            {failedCount > 0 ? ` · ${failedCount} failed` : ''}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
          </span>
        </div>

        {gates.length === 0 ? (
          <Card>
            <EmptyState
              message="No gates yet"
              hint="Gate results will appear here as the workflow runs."
            />
          </Card>
        ) : (
          <Card compact>
            <div className="gate-grid">
              {gates.map((gate) => {
                const reviewGate = reviewGateMap.get(gate.id);
                const triage = triageMap.get(gate.id);
                const classification =
                  gate.failureClassification ??
                  reviewGate?.failureClassification ??
                  null;
                const isFailed = gate.status === 'failed';

                return (
                  <div
                    key={gate.id}
                    className="gate-item"
                    style={
                      isFailed
                        ? {
                            borderColor: '#fecaca',
                            background: 'var(--fail-bg)',
                          }
                        : undefined
                    }
                  >
                    <div
                      className={`gate-icon ${gateIconClass(gate.status)}`}
                    >
                      {gateIconSymbol(gate.status)}
                    </div>
                    <div>
                      <div className="gate-name">{gate.gateType}</div>
                      <div
                        className="gate-meta"
                        style={
                          isFailed ? { color: 'var(--fail)' } : undefined
                        }
                      >
                        {isFailed
                          ? `failed${classification ? ` · ${classification}` : ''}`
                          : gate.status === 'pending'
                            ? 'pending'
                            : `${gate.nodeId} · ${formatDurationMs(gate.durationMs)}`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>

      {/* ── Pending Decisions ── */}
      {pendingDecisions.length > 0 ? (
        <div className="section">
          <div className="section-title">
            待决策 Pending Decisions{' '}
            <span className="count">{pendingDecisions.length}</span>
          </div>
          <Card compact>
            <div style={{ padding: '12px 20px' }}>
              {pendingDecisions.map((decision) => (
                <div
                  key={decision.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 0',
                    borderBottom: '1px solid var(--border-l)',
                    fontSize: '13px',
                  }}
                >
                  <StatusBadge status="pending" size="sm" />
                  <span style={{ fontWeight: 600 }}>
                    {decision.context.request}
                  </span>
                  <span className="text-mono text-muted">
                    {decision.id.slice(0, 12)}…
                  </span>
                  <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                    {decision.context.riskLabel}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
