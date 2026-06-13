import { useNavigate } from 'react-router';

import type { DemandShape } from '@tekon/core';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

import { useMutation } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { routes } from '../../lib/route-paths.js';
import { AcceptanceCriteria } from './AcceptanceCriteria.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DemandShapeCardProps {
  /** The shaped demand to display. */
  shape: DemandShape;
  /** Server path to the persisted shape file (needed for approve). */
  shapePath: string;
  /** Whether this card reflects an approved state. */
  approved?: boolean;
  /** Called after a successful approve mutation with the updated shape. */
  onApproved?: (
    result: RpcProcedureMap['demand.approve']['output'],
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RISK_CLASS: Record<DemandShape['risk']['level'], string> = {
  low: 'risk-low',
  medium: 'risk-medium',
  high: 'risk-high',
};

const RISK_LABEL: Record<DemandShape['risk']['level'], string> = {
  low: 'low risk',
  medium: 'medium risk',
  high: 'high risk',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a clarified demand shape as a rich card, matching the design mockup.
 *
 * Includes classification tags, risk assessment, acceptance criteria,
 * non-goals, and action buttons for approval and starting a run.
 */
export function DemandShapeCard({
  shape,
  shapePath,
  approved = false,
  onApproved,
}: DemandShapeCardProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();
  const navigate = useNavigate();

  // ── Approve mutation ──
  const approveMutation = useMutation<
    RpcProcedureMap['demand.approve']['input'],
    RpcProcedureMap['demand.approve']['output']
  >((input) => rpc.call('demand.approve', input), {
    invalidateKeys: ['project.detail'],
  });

  const isApproved = approved || shape.approved;

  const handleApprove = async () => {
    if (!token) {
      addFlash('warning', 'Please set your session token first');
      return;
    }
    try {
      const result = await approveMutation.mutate({ shapePath, token });
      addFlash('success', '需求已批准 Demand approved');
      onApproved?.(result);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to approve demand',
      );
    }
  };

  const handleStartRun = () => {
    // Navigate to Runs with shapePath so StartRunForm can fetch demand detail
    const params = new URLSearchParams();
    params.set('shapePath', shapePath);
    params.set('template', shape.recommendedTemplate);
    navigate(`${routes.runs}?${params.toString()}`);
  };

  return (
    <div className="card mb-6">
      {/* ── Header ── */}
      <div className="card-header">
        <div className="flex items-center gap-3">
          <span className="card-title">{shape.title}</span>
          {isApproved && (
            <span className="badge badge-passed badge-sm">approved</span>
          )}
          {!isApproved && shape.readyForRun && (
            <span className="badge badge-running badge-sm">ready</span>
          )}
          {!isApproved && !shape.readyForRun && (
            <span className="badge badge-pending badge-sm">
              needs review
            </span>
          )}
        </div>
        <span className="text-mono text-muted" style={{ fontSize: 11 }}>
          {shape.id.length > 16
            ? `${shape.id.slice(0, 8)}…${shape.id.slice(-4)}`
            : shape.id}
        </span>
      </div>

      {/* ── Body ── */}
      <div className="card-body">
        <div className="shape-card">
          {/* ── Classification ── */}
          <div className="shape-section">
            <div className="shape-section-title">
              分类 Classification
            </div>
            <div style={{ marginBottom: 8 }}>
              <span className="shape-tag category">{shape.category}</span>
              <span
                className={`shape-tag ${RISK_CLASS[shape.risk.level]}`}
              >
                {RISK_LABEL[shape.risk.level]}
              </span>
              <span className="shape-tag template">
                {shape.recommendedTemplate}
              </span>
            </div>
            <div
              className="text-sm text-muted"
              style={{ marginTop: 8 }}
            >
              <div style={{ marginBottom: 4 }}>
                推荐模板 Recommended:{' '}
                <strong>{shape.recommendedTemplate}</strong>
              </div>
              <div>
                可发起运行 Ready:{' '}
                <strong
                  style={{
                    color: shape.readyForRun
                      ? 'var(--pass)'
                      : 'var(--pend)',
                  }}
                >
                  {shape.readyForRun ? 'true' : 'false'}
                </strong>
              </div>
            </div>
          </div>

          {/* ── Risk Assessment ── */}
          <div className="shape-section">
            <div className="shape-section-title">
              风险评估 Risk
            </div>
            <div className="text-sm text-muted">
              <div style={{ marginBottom: 4 }}>
                Level:{' '}
                <strong
                  style={{
                    color:
                      shape.risk.level === 'high'
                        ? 'var(--fail)'
                        : shape.risk.level === 'medium'
                          ? '#B45309'
                          : 'var(--pass)',
                  }}
                >
                  {shape.risk.level}
                </strong>
              </div>
              {shape.risk.tags.length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  Tags:{' '}
                  {shape.risk.tags.map((tag) => (
                    <span
                      key={tag}
                      className="shape-tag risk"
                      style={{ fontSize: 10 }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div>
                需人工审批 Human Approval:{' '}
                <strong>
                  {shape.risk.requiresHumanApproval ? 'yes' : 'no'}
                </strong>
              </div>
              {shape.risk.reasons.length > 0 && (
                <ul className="shape-reasons">
                  {shape.risk.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Acceptance Criteria (full width) ── */}
          <div className="shape-section" style={{ gridColumn: '1 / -1' }}>
            <div className="shape-section-title">
              验收标准 Acceptance Criteria ({shape.acceptanceCriteria.length})
            </div>
            <AcceptanceCriteria criteria={shape.acceptanceCriteria} />
          </div>

          {/* ── Non-Goals (full width) ── */}
          <div className="shape-section" style={{ gridColumn: '1 / -1' }}>
            <div className="shape-section-title">
              非目标 Non-Goals
            </div>
            <div className="text-sm text-muted">
              {shape.nonGoals.map((goal) => (
                <span key={goal} className="shape-tag neutral">
                  {goal}
                </span>
              ))}
            </div>
          </div>

          {/* ── Open Questions (full width, only if present) ── */}
          {shape.openQuestions.length > 0 && (
            <div
              className="shape-section"
              style={{ gridColumn: '1 / -1' }}
            >
              <div className="shape-section-title">
                待确认问题 Open Questions (
                {shape.openQuestions.length})
              </div>
              <ul className="shape-open-questions">
                {shape.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Assumptions (full width, only if present) ── */}
          {shape.assumptions.length > 0 && (
            <div
              className="shape-section"
              style={{ gridColumn: '1 / -1' }}
            >
              <div className="shape-section-title">
                假设 Assumptions
              </div>
              <div className="text-sm text-muted">
                {shape.assumptions.map((assumption) => (
                  <span key={assumption} className="shape-tag neutral">
                    {assumption}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Actions ── */}
        <div
          className="flex gap-2 mt-4"
          style={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          {!isApproved && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={approveMutation.isPending}
              onClick={handleApprove}
            >
              {approveMutation.isPending
                ? '⏳ 批准中…'
                : '✓ 批准需求 Approve'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleStartRun}
          >
            ▶ 使用此需求发起运行
          </button>
        </div>

        {approveMutation.error && (
          <p
            className="text-sm"
            style={{ color: 'var(--fail)', marginTop: 8 }}
          >
            {approveMutation.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
