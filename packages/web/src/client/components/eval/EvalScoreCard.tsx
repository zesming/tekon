// ---------------------------------------------------------------------------
// EvalScoreCard — score gauge with badge and progress bar
// ---------------------------------------------------------------------------

interface EvalScoreCardProps {
  score: number; // 0–100
  ready: boolean;
  label?: string;
}

/**
 * Displays an evaluation score as a large number, a ready/partial badge,
 * and a progress bar indicating the score percentage.
 */
export function EvalScoreCard({ score, ready, label }: EvalScoreCardProps) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const fillClass =
    clampedScore >= 80 ? 'high' : clampedScore >= 50 ? 'medium' : 'low';

  return (
    <div className="card">
      <div className="card-body" style={{ textAlign: 'center', padding: '28px 20px' }}>
        {/* Label */}
        {label && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-s)',
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {label}
          </div>
        )}

        {/* Large score number */}
        <div
          style={{
            fontFamily: 'var(--font-d)',
            fontSize: 56,
            fontWeight: 700,
            lineHeight: 1,
            color: ready ? 'var(--pass)' : 'var(--fail)',
            marginBottom: 12,
          }}
        >
          {clampedScore}
        </div>

        {/* Ready / Partial badge */}
        <span
          className={`badge ${ready ? 'badge-passed' : 'badge-failed'}`}
          style={{ marginBottom: 16 }}
        >
          {ready ? 'Ready' : 'Not Ready'}
        </span>

        {/* Progress bar */}
        <div className="readiness-bar" style={{ marginTop: 12 }}>
          <div
            className={`readiness-fill ${fillClass}`}
            style={{ width: `${clampedScore}%` }}
          />
        </div>

        {/* Score caption */}
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-t)',
            marginTop: 6,
          }}
        >
          {clampedScore}/100
        </div>
      </div>
    </div>
  );
}
