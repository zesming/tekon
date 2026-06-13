import { useState } from 'react';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

import { EvalScoreCard } from '../../components/eval/EvalScoreCard.js';
import { CheckList } from '../../components/eval/CheckList.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReviewOutput = RpcProcedureMap['review.get']['output'];

// ---------------------------------------------------------------------------
// ReadinessTab
// ---------------------------------------------------------------------------

/**
 * ReadinessTab — displays work readiness evaluation for a given run.
 *
 * Uses the `review.get` procedure which returns readiness data including
 * score, ready status, and individual check results.
 */
export function ReadinessTab() {
  // ── Get latest run from overview to pre-fill runId ──
  const { data: overview } = useQuery<
    RpcProcedureMap['project.overview']['output']
  >('project.overview', () => rpc.call('project.overview'));

  const latestRunId = overview?.latestRun?.id ?? '';

  // ── Local state ──
  const [runId, setRunId] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch review data when activeRunId is set ──
  const { data: review, isLoading, error: queryError, refetch: refetchReview } = useQuery<ReviewOutput>(
    activeRunId ? `review.get:${activeRunId}` : null,
    () => rpc.call('review.get', { runId: activeRunId! }),
  );

  const handleEvaluate = async () => {
    const targetRunId = runId.trim() || latestRunId;
    if (!targetRunId) {
      setError('Please enter a run ID');
      return;
    }
    setError(null);
    setActiveRunId(targetRunId);
  };

  const handleUseLatest = () => {
    if (latestRunId) {
      setRunId(latestRunId);
      setError(null);
      setActiveRunId(latestRunId);
    }
  };

  // ── Derive readiness data ──
  const readiness = review?.readiness;
  const prePrReadiness = review?.prePullRequestReadiness;

  return (
    <>
      {/* ── Input Section ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="readiness-run-id"
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--text-s)',
                  marginBottom: 4,
                }}
              >
                Run ID
              </label>
              <input
                id="readiness-run-id"
                className="input"
                type="text"
                placeholder={latestRunId || 'Enter run ID…'}
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleEvaluate();
                }}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleEvaluate}
              disabled={isLoading}
            >
              {isLoading ? 'Loading…' : 'Evaluate'}
            </button>
            {latestRunId && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleUseLatest}
              >
                Use Latest
              </button>
            )}
          </div>
          {error && (
            <p style={{ color: 'var(--fail)', fontSize: 12, marginTop: 6 }}>
              {error}
            </p>
          )}
        </div>
      </div>

      {/* ── Query Error Banner ── */}
      {queryError && (
        <ErrorBanner error={queryError} onRetry={refetchReview} />
      )}

      {/* ── Loading State ── */}
      {isLoading && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              Loading readiness evaluation…
            </p>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {readiness && !isLoading && (
        <>
          {/* Score Card */}
          <div style={{ marginBottom: 20 }}>
            <EvalScoreCard
              score={readiness.score}
              ready={readiness.ready}
              label="工作就绪度"
            />
          </div>

          {/* Readiness Checks */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <span className="card-title">
                Readiness Checks
                <span
                  style={{
                    fontFamily: 'var(--font-m)',
                    fontSize: 11,
                    color: 'var(--text-t)',
                    fontWeight: 500,
                    marginLeft: 8,
                  }}
                >
                  {readiness.checks.filter((c) => c.passed).length}/
                  {readiness.checks.length} passed
                </span>
              </span>
            </div>
            <div className="card-body compact">
              <CheckList
                items={readiness.checks.map((c) => ({
                  id: c.id,
                  passed: c.passed,
                  evidence: c.evidence,
                  severity: c.severity,
                }))}
              />
            </div>
          </div>

          {/* Pre-PR Readiness (if available) */}
          {prePrReadiness && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">
                  Pre-Pull Request Readiness
                  <span
                    className={`badge ${prePrReadiness.ready ? 'badge-passed' : 'badge-failed'}`}
                    style={{ marginLeft: 8 }}
                  >
                    {prePrReadiness.ready ? '就绪' : '未就绪'}
                  </span>
                </span>
              </div>
              <div className="card-body compact">
                <CheckList
                  items={prePrReadiness.checks.map((c) => ({
                    id: c.id,
                    passed: c.passed,
                    evidence: c.evidence,
                  }))}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Empty State ── */}
      {!review && !isLoading && !error && !queryError && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              Enter a run ID and click &quot;Evaluate&quot; to view readiness
              evaluation results.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
