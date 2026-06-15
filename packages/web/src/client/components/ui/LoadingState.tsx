// ---------------------------------------------------------------------------
// LoadingState — centered spinner with optional message
// ---------------------------------------------------------------------------

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = '加载中...' }: LoadingStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        gap: '12px',
      }}
    >
      <div
        style={{
          width: '28px',
          height: '28px',
          border: '3px solid var(--border)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
      <span style={{ color: 'var(--text-t)', fontSize: '13px' }}>{message}</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
