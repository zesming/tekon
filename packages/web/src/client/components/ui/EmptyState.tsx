// ---------------------------------------------------------------------------
// EmptyState — placeholder for missing data
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  message?: string;
  hint?: string;
}

export function EmptyState({
  message = '暂无数据',
  hint,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        gap: '8px',
      }}
    >
      <div style={{ fontSize: '28px', opacity: 0.3, marginBottom: '4px' }}>
        ∅
      </div>
      <div style={{ color: 'var(--text-s)', fontSize: '14px', fontWeight: 600 }}>
        {message}
      </div>
      {hint !== undefined ? (
        <div style={{ color: 'var(--text-t)', fontSize: '12px' }}>{hint}</div>
      ) : null}
    </div>
  );
}
