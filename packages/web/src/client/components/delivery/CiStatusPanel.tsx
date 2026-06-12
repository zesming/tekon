import type { ApiReviewGate } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// CiStatusPanel — gate results table acting as CI status overview
// ---------------------------------------------------------------------------

interface CiStatusPanelProps {
  gates: ApiReviewGate[];
}

const statusIcon: Record<string, string> = {
  passed: '✓',
  failed: '✗',
  pending: '◌',
  running: '◉',
  skipped: '–',
};

const statusColor: Record<string, string> = {
  passed: 'var(--pass)',
  failed: 'var(--fail)',
  pending: 'var(--pend)',
  running: 'var(--run)',
  skipped: 'var(--text-t)',
};

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

export function CiStatusPanel({ gates }: CiStatusPanelProps) {
  if (gates.length === 0) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <div style={{ color: 'var(--text-t)', fontSize: '13px' }}>
          No gate results available
        </div>
      </div>
    );
  }

  const passedCount = gates.filter((g) => g.status === 'passed').length;
  const failedCount = gates.filter((g) => g.status === 'failed').length;
  const totalCount = gates.length;

  return (
    <div>
      {/* Summary bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 20px',
          borderBottom: '1px solid var(--border-l)',
          fontSize: '12px',
          color: 'var(--text-s)',
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {passedCount}/{totalCount} passed
        </span>
        {failedCount > 0 ? (
          <span style={{ color: 'var(--fail)', fontWeight: 600 }}>
            {failedCount} failed
          </span>
        ) : null}
        <div
          className="readiness-bar"
          style={{ flex: 1, margin: 0, maxWidth: '160px', marginLeft: 'auto' }}
        >
          <div
            className={`readiness-fill ${passedCount / totalCount >= 0.6 ? 'high' : passedCount / totalCount >= 0.3 ? 'medium' : 'low'}`}
            style={{
              width: `${Math.round((passedCount / totalCount) * 100)}%`,
            }}
          />
        </div>
      </div>

      {/* Gate table */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Gate</th>
              <th>Node</th>
              <th>Duration</th>
              <th>Retries</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.id}>
                <td>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontWeight: 600,
                      fontSize: '12px',
                      color: statusColor[gate.status] ?? 'var(--text-s)',
                    }}
                  >
                    <span
                      style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        background: `${statusColor[gate.status] ?? 'var(--text-t)'}18`,
                        color: statusColor[gate.status] ?? 'var(--text-t)',
                      }}
                    >
                      {statusIcon[gate.status] ?? '–'}
                    </span>
                    {gate.status}
                  </span>
                </td>
                <td className="cell-primary">{gate.gateType}</td>
                <td className="cell-mono">{gate.nodeId}</td>
                <td className="cell-mono">{formatDuration(gate.durationMs)}</td>
                <td className="cell-mono">
                  {gate.retries > 0 ? (
                    <span style={{ color: 'var(--pend)' }}>{gate.retries}</span>
                  ) : (
                    <span style={{ color: 'var(--text-t)' }}>0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
