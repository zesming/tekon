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

type GateListOutput = RpcProcedureMap['gate.list']['output'];

// ---------------------------------------------------------------------------
// ApprovalSummaryTab
// ---------------------------------------------------------------------------

/**
 * ApprovalSummaryTab — displays approval evaluation for decisions in a run.
 *
 * Uses the `gate.list` procedure which returns pending decisions, each of
 * which may contain an `approvalEvaluation` in its context with ready/score/checks.
 */
export function ApprovalSummaryTab() {
  // ── Local state ──
  const [runId, setRunId] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch gate list (includes pending decisions) ──
  const { data: gateData, isLoading, error: queryError, refetch: refetchGate } = useQuery<GateListOutput>(
    activeRunId ? `gate.list:${activeRunId}` : null,
    () => rpc.call('gate.list', { runId: activeRunId! }),
  );

  const handleEvaluate = () => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      setError('Please enter a run ID');
      return;
    }
    setError(null);
    setActiveRunId(targetRunId);
  };

  // ── Extract approval evaluations from pending decisions ──
  const decisionsWithEval =
    gateData?.pendingDecisions.filter(
      (d) => d.context.approvalEvaluation != null,
    ) ?? [];

  return (
    <>
      {/* ── Input Section ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="approval-run-id"
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
                id="approval-run-id"
                className="input"
                type="text"
                placeholder="Enter run ID…"
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
        <ErrorBanner error={queryError} onRetry={refetchGate} />
      )}

      {/* ── Loading State ── */}
      {isLoading && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              Loading approval evaluation…
            </p>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {!isLoading && decisionsWithEval.length > 0 && (
        <>
          {decisionsWithEval.map((decision) => {
            const eval_ = decision.context.approvalEvaluation!;
            return (
              <div key={decision.id} style={{ marginBottom: 20 }}>
                {/* Score Card */}
                <div style={{ marginBottom: 16 }}>
                  <EvalScoreCard
                    score={eval_.score}
                    ready={eval_.ready}
                    label={`Approval Evaluation — ${decision.nodeId}`}
                  />
                </div>

                {/* Decision info */}
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="card-header">
                    <span className="card-title">Decision Context</span>
                    <span
                      className={`badge ${
                        decision.status === 'approved'
                          ? 'badge-passed'
                          : decision.status === 'rejected'
                            ? 'badge-failed'
                            : 'badge-pending'
                      }`}
                    >
                      {decision.status}
                    </span>
                  </div>
                  <div className="card-body">
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 1fr',
                        gap: '8px 12px',
                        fontSize: 13,
                      }}
                    >
                      <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                        Decision ID
                      </span>
                      <span style={{ fontFamily: 'var(--font-m)', fontSize: 12 }}>
                        {decision.id}
                      </span>
                      <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                        Node
                      </span>
                      <span>{decision.nodeId}</span>
                      {decision.actor && (
                        <>
                          <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                            Actor
                          </span>
                          <span>{decision.actor}</span>
                        </>
                      )}
                      {decision.note && (
                        <>
                          <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                            Note
                          </span>
                          <span>{decision.note}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Approval Checks */}
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">
                      Approval Checks
                      <span
                        style={{
                          fontFamily: 'var(--font-m)',
                          fontSize: 11,
                          color: 'var(--text-t)',
                          fontWeight: 500,
                          marginLeft: 8,
                        }}
                      >
                        {eval_.checks.filter((c) => c.passed).length}/
                        {eval_.checks.length} passed
                      </span>
                    </span>
                  </div>
                  <div className="card-body compact">
                    <CheckList
                      items={eval_.checks.map((c) => ({
                        id: c.id,
                        passed: c.passed,
                        evidence: c.evidence,
                      }))}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* ── No approval evaluations found ── */}
      {!isLoading && activeRunId && decisionsWithEval.length === 0 && gateData && !queryError && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              No approval evaluations found for this run. Approval evaluations
              appear when decisions require human review.
            </p>
          </div>
        </div>
      )}

      {/* ── Empty State ── */}
      {!gateData && !isLoading && !error && !queryError && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              Enter a run ID and click &quot;Evaluate&quot; to view approval
              evaluation results.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
