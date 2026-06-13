import { useNavigate } from 'react-router';

import type { DraftShape } from '@tekon/core';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

import { useMutation } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { routes } from '../../lib/route-paths.js';
import { getRiskLabel } from '../../lib/check-labels.js';
import { AcceptanceCriteria } from './AcceptanceCriteria.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DraftCardProps {
  /** The shaped demand to display. */
  shape: DraftShape;
  /** Server path to the persisted shape file (needed for approve). */
  shapePath: string;
  /** Whether this card reflects an approved state. */
  approved?: boolean;
  /** Called after a successful approve mutation with the updated shape. */
  onApproved?: (
    result: RpcProcedureMap['draftShape.approve']['output'],
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RISK_CLASS: Record<DraftShape['risk']['level'], string> = {
  low: 'risk-low',
  medium: 'risk-medium',
  high: 'risk-high',
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
export function DraftCard({
  shape,
  shapePath,
  approved = false,
  onApproved,
}: DraftCardProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();
  const navigate = useNavigate();

  // ── Approve mutation ──
  const approveMutation = useMutation<
    RpcProcedureMap['draftShape.approve']['input'],
    RpcProcedureMap['draftShape.approve']['output']
  >((input) => rpc.call('draftShape.approve', input), {
    invalidateKeys: ['project.detail'],
  });

  const isApproved = approved || shape.approved;

  const handleApprove = async () => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }
    try {
      const result = await approveMutation.mutate({ shapePath, token });
      addFlash('success', '需求已批准');
      onApproved?.(result);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '需求审批失败',
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
            <span className="badge badge-passed badge-sm">已批准</span>
          )}
          {!isApproved && shape.readyForRun && (
            <span className="badge badge-running badge-sm">待审批</span>
          )}
          {!isApproved && !shape.readyForRun && (
            <span className="badge badge-pending badge-sm">
              待审查
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
              分类
            </div>
            <div style={{ marginBottom: 8 }}>
              <span className="shape-tag category">{shape.category}</span>
              <span
                className={`shape-tag ${RISK_CLASS[shape.risk.level]}`}
              >
                {getRiskLabel(shape.risk.level)}
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
                推荐模板:{' '}
                <strong>{shape.recommendedTemplate}</strong>
              </div>
              <div>
                可执行:{' '}
                <strong
                  style={{
                    color: shape.readyForRun
                      ? 'var(--pass)'
                      : 'var(--pend)',
                  }}
                >
                  {shape.readyForRun ? '是' : '否'}
                </strong>
              </div>
            </div>
          </div>

          {/* ── Risk Assessment ── */}
          <div className="shape-section">
            <div className="shape-section-title">
              风险评估
            </div>
            <div className="text-sm text-muted">
              <div style={{ marginBottom: 4 }}>
                级别:{' '}
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
                  标签:{' '}
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
                需人工审批:{' '}
                <strong>
                  {shape.risk.requiresHumanApproval ? '是' : '否'}
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
              验收标准 ({shape.acceptanceCriteria.length})
            </div>
            <AcceptanceCriteria criteria={shape.acceptanceCriteria} />
          </div>

          {/* ── Non-Goals (full width) ── */}
          <div className="shape-section" style={{ gridColumn: '1 / -1' }}>
            <div className="shape-section-title">
              非目标
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
                待确认问题 (
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
                假设
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
                : '✓ 批准需求'}
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

// ---------------------------------------------------------------------------
// Backward-compatible deprecated exports
// ---------------------------------------------------------------------------

/** @deprecated Use DraftCardProps instead */
export type DraftShapeCardProps = DraftCardProps;

/** @deprecated Use DraftCard instead */
export const DraftShapeCard = DraftCard;
