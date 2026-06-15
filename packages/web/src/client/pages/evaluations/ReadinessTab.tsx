import { useState } from 'react';

import { useQuery, useAuthScope } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
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
  const scope = useAuthScope();

  // ── Get latest run from overview to pre-fill runId ──
  const { data: overview } = useQuery<
    RpcProcedureMap['project.overview']['output']
  >(queryKeys.projectOverview(scope), () => rpc.call('project.overview'));

  const latestRunId = overview?.latestRun?.id ?? '';

  // ── Local state ──
  const [runId, setRunId] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch review data when activeRunId is set ──
  const { data: review, isLoading, error: queryError, refetch: refetchReview } = useQuery<ReviewOutput>(
    activeRunId ? queryKeys.reviewDetail(activeRunId, scope) : null,
    () => rpc.call('review.get', { runId: activeRunId! }),
  );

  const handleEvaluate = async () => {
    const targetRunId = runId.trim() || latestRunId;
    if (!targetRunId) {
      setError('请输入运行 ID');
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
                运行 ID
              </label>
              <input
                id="readiness-run-id"
                className="input"
                type="text"
                placeholder={latestRunId || '输入运行 ID…'}
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
              {isLoading ? '加载中…' : '评估'}
            </button>
            {latestRunId && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleUseLatest}
              >
                使用最新
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
              加载就绪评估中…
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
                就绪检查
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
                  {readiness.checks.length} 通过
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
                  PR 创建就绪
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
              输入运行 ID 并点击"评估"查看就绪评估结果。
            </p>
          </div>
        </div>
      )}
    </>
  );
}
