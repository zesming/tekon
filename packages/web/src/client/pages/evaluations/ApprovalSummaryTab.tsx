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
  const scope = useAuthScope();

  // ── Local state ──
  const [runId, setRunId] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch gate list (includes pending decisions) ──
  const { data: gateData, isLoading, error: queryError, refetch: refetchGate } = useQuery<GateListOutput>(
    activeRunId ? queryKeys.gateResults(activeRunId, scope) : null,
    () => rpc.call('gate.list', { runId: activeRunId! }),
  );

  const handleEvaluate = () => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      setError('请输入运行 ID');
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
                运行 ID
              </label>
              <input
                id="approval-run-id"
                className="input"
                type="text"
                placeholder="输入运行 ID…"
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
              加载审批评估中…
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
                    label={`审批评估 — ${decision.nodeId}`}
                  />
                </div>

                {/* Decision info */}
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="card-header">
                    <span className="card-title">决策上下文</span>
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
                        决策 ID
                      </span>
                      <span style={{ fontFamily: 'var(--font-m)', fontSize: 12 }}>
                        {decision.id}
                      </span>
                      <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                        节点
                      </span>
                      <span>{decision.nodeId}</span>
                      {decision.actor && (
                        <>
                          <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                            执行者
                          </span>
                          <span>{decision.actor}</span>
                        </>
                      )}
                      {decision.note && (
                        <>
                          <span style={{ color: 'var(--text-t)', fontWeight: 500 }}>
                            备注
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
                      审批检查
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
                        {eval_.checks.length} 通过
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
              未找到该运行的审批评估。审批评估
              在决策需要人工审阅时显示。
            </p>
          </div>
        </div>
      )}

      {/* ── Empty State ── */}
      {!gateData && !isLoading && !error && !queryError && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              输入运行 ID 并点击"评估"查看审批
              结果。
            </p>
          </div>
        </div>
      )}
    </>
  );
}
