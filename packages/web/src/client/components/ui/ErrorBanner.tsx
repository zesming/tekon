// ---------------------------------------------------------------------------
// ErrorBanner — error message with retry button
// ---------------------------------------------------------------------------

interface ErrorBannerProps {
  error: Error;
  onRetry?: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  return (
    <div
      style={{
        padding: '16px 20px',
        background: 'var(--fail-bg)',
        border: '1px solid #fecaca',
        borderRadius: 'var(--r-md)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '16px',
      }}
    >
      <div>
        <div style={{ fontWeight: 600, color: 'var(--fail)', fontSize: '13px' }}>
          Something went wrong
        </div>
        <div style={{ color: 'var(--text-s)', fontSize: '12px', marginTop: '4px' }}>
          {error.message}
        </div>
      </div>
      {onRetry !== undefined ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onRetry}
        >
          ↻ Retry
        </button>
      ) : null}
    </div>
  );
}
