import { useCallback } from 'react';
import type { ApiHumanDecision } from '../../../shared/api-types.js';
import { ApprovalSummary } from './ApprovalSummary.js';
import { DecisionForm } from './DecisionForm.js';

// ---------------------------------------------------------------------------
// DecisionCard — renders a single pending human decision
// ---------------------------------------------------------------------------

interface DecisionCardProps {
  decision: ApiHumanDecision;
  isPending: boolean;
  onApprove: (decisionId: string, note: string) => void | Promise<void>;
  onReject: (decisionId: string, note: string) => void | Promise<void>;
}

/** Map a risk-label string to a CSS class suffix. */
function riskClass(riskLabel: string): string {
  const lower = riskLabel.toLowerCase();
  if (lower.includes('high') || lower.includes('critical')) return 'risk-high';
  if (lower.includes('medium') || lower.includes('moderate')) return 'risk-medium';
  return 'risk-low';
}

/** Derive a short title from the decision context. */
function decisionTitle(decision: ApiHumanDecision): string {
  const summary = decision.context.approvalSummary;
  if (summary?.demandTitle) return summary.demandTitle;
  if (decision.context.request) return decision.context.request;
  return `Decision ${decision.id}`;
}

export function DecisionCard({
  decision,
  isPending,
  onApprove,
  onReject,
}: DecisionCardProps) {
  const { context } = decision;
  const risk = context.riskLabel;
  const title = decisionTitle(decision);
  const evaluation = context.approvalEvaluation;

  const handleApprove = useCallback(
    async (note: string) => {
      await onApprove(decision.id, note);
    },
    [decision.id, onApprove],
  );

  const handleReject = useCallback(
    async (note: string) => {
      await onReject(decision.id, note);
    },
    [decision.id, onReject],
  );

  return (
    <div className="approval-card">
      {/* Header: title + risk label */}
      <div className="approval-header">
        <div>
          <div className="approval-title">{title}</div>
          <div
            className="text-mono text-muted"
            style={{ marginTop: '4px', fontSize: '11px' }}
          >
            {decision.id}
          </div>
        </div>
        <span className={`risk-label ${riskClass(risk)}`}>{risk || 'unknown'}</span>
      </div>

      {/* Meta grid: command, node role, readiness score */}
      <div className="approval-meta">
        <div className="approval-meta-item">
          <div className="approval-meta-label">Exact Command</div>
          <div
            className="approval-meta-value text-mono"
            style={{ fontSize: '12px', wordBreak: 'break-all' }}
          >
            {context.exactCommand || '—'}
          </div>
        </div>
        <div className="approval-meta-item">
          <div className="approval-meta-label">Node Role</div>
          <div className="approval-meta-value">
            {context.nodeRole ?? '—'}
          </div>
        </div>
        <div className="approval-meta-item">
          <div className="approval-meta-label">Readiness Score</div>
          <div
            className="approval-meta-value"
            style={{
              color:
                evaluation !== null
                  ? evaluation.ready
                    ? 'var(--pass)'
                    : 'var(--fail)'
                  : 'var(--text-t)',
            }}
          >
            {evaluation !== null
              ? `${Math.round(evaluation.score * 100)}%`
              : '—'}
          </div>
        </div>
      </div>

      {/* Approval summary (checks, text, evidence links) */}
      <ApprovalSummary decision={decision} />

      {/* Decision form */}
      <DecisionForm
        riskLabel={risk}
        isPending={isPending}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  );
}
