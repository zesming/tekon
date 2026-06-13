// ---------------------------------------------------------------------------
// CheckList — pass/fail checklist with evidence and optional severity
// ---------------------------------------------------------------------------

interface CheckItem {
  id: string;
  passed: boolean;
  evidence: string;
  severity?: 'required' | 'recommended' | 'context';
}

interface CheckListProps {
  items: CheckItem[];
}

export function CheckList({ items }: CheckListProps) {
  return (
    <div className="check-list">
      {items.map((check) => (
        <div key={check.id} className="check-item">
          <span className={`check-icon ${check.passed ? 'pass' : 'fail'}`}>
            {check.passed ? '✓' : '✕'}
          </span>
          <span className="check-label">
            {check.id}
            {check.severity && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  fontWeight: 500,
                  color:
                    check.severity === 'required'
                      ? 'var(--fail)'
                      : 'var(--text-t)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {check.severity}
              </span>
            )}
          </span>
          <span
            className="check-evidence"
            style={check.passed ? undefined : { color: 'var(--fail)' }}
            title={check.evidence}
          >
            {check.evidence}
          </span>
        </div>
      ))}
    </div>
  );
}
