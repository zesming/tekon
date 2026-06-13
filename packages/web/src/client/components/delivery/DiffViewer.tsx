import type { ApiReviewDiffSummary } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// DiffViewer — diff summary with changed files
// ---------------------------------------------------------------------------

interface DiffViewerProps {
  diff: ApiReviewDiffSummary;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  if (!diff.available) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <div style={{ color: 'var(--text-t)', fontSize: '13px' }}>
          {diff.reason ?? 'Diff not available'}
        </div>
      </div>
    );
  }

  return (
    <div className="card-body">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '12px',
          fontSize: '12px',
          color: 'var(--text-s)',
          fontFamily: 'var(--font-m)',
        }}
      >
        <span>{diff.branch}</span>
        <span style={{ color: 'var(--text-t)' }}>→</span>
        <span>{diff.baseBranch}</span>
        <span style={{ marginLeft: 'auto' }}>
          {diff.changedFiles.length} file
          {diff.changedFiles.length !== 1 ? 's' : ''}
        </span>
      </div>

      {diff.stat ? (
        <div
          style={{
            fontFamily: 'var(--font-m)',
            fontSize: '12px',
            color: 'var(--text-s)',
            marginBottom: '12px',
            padding: '8px 12px',
            background: 'var(--surface-h)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          {diff.stat}
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: '6px' }}>
        {diff.changedFiles.map((file) => (
          <div
            key={file}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
            }}
          >
            <span
              className="text-mono text-muted"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {file}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
