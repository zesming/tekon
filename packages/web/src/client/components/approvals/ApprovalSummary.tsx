import type { ApiHumanDecision } from '../../../shared/api-types.js';
import { checkLabel, getReadinessLabel } from '../../lib/check-labels.js';

// ---------------------------------------------------------------------------
// ApprovalSummary — renders the pre-formatted summary text for a decision
// ---------------------------------------------------------------------------

interface ApprovalSummaryProps {
  decision: ApiHumanDecision;
}

export function ApprovalSummary({ decision }: ApprovalSummaryProps) {
  const summary = decision.context.approvalSummary;
  const evaluation = decision.context.approvalEvaluation;
  const summaryText = summary?.summaryText ?? null;

  return (
    <div className="approval-summary-section">
      {/* Evaluation score bar */}
      {evaluation !== null ? (
        <div style={{ marginBottom: '12px' }}>
          <div
            className="flex justify-between items-center"
            style={{ marginBottom: '6px' }}
          >
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--text-t)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              就绪度评分
            </span>
            <span
              style={{
                fontSize: '13px',
                fontWeight: 700,
                fontFamily: 'var(--font-m)',
                color: evaluation.ready ? 'var(--pass)' : 'var(--fail)',
              }}
            >
              {Math.round(evaluation.score * 100)}% — {getReadinessLabel(evaluation.ready)}
            </span>
          </div>
          <div className="readiness-bar">
            <div
              className={`readiness-fill ${evaluation.score >= 0.7 ? 'high' : evaluation.score >= 0.4 ? 'medium' : 'low'}`}
              style={{ width: `${Math.round(evaluation.score * 100)}%` }}
            />
          </div>

          {/* Check items */}
          {evaluation.checks.length > 0 ? (
            <div style={{ marginTop: '10px' }}>
              {evaluation.checks.map((check) => (
                <div
                  key={check.id}
                  className="flex items-center gap-2"
                  style={{
                    padding: '4px 0',
                    fontSize: '12px',
                    borderBottom: '1px solid var(--border-l)',
                  }}
                >
                  <span
                    style={{
                      color: check.passed ? 'var(--pass)' : 'var(--fail)',
                      fontSize: '13px',
                      flexShrink: 0,
                      width: '16px',
                    }}
                  >
                    {check.passed ? '✓' : '✗'}
                  </span>
                  <span
                    style={{ fontWeight: 600, minWidth: '100px' }}
                    title={check.id}
                  >
                    {checkLabel(check.id)}
                  </span>
                  <span style={{ color: 'var(--text-s)', flex: 1 }}>
                    {check.evidence}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Pre-formatted summary text */}
      {summaryText !== null ? (
        <div className="approval-summary-text">{summaryText}</div>
      ) : null}

      {/* Evidence links */}
      {summary?.evidenceLinks && summary.evidenceLinks.length > 0 ? (
        <div style={{ marginTop: '10px' }}>
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-t)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '6px',
            }}
          >
            证据链接
          </div>
          <div className="link-strip">
            {summary.evidenceLinks.map((link, i) => (
              <a
                key={`${link.kind}-${i}`}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '3px 10px',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--border)',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--accent)',
                  background: 'var(--surface)',
                  textDecoration: 'none',
                }}
                title={link.summary}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
