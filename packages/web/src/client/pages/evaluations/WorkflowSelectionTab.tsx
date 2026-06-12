// ---------------------------------------------------------------------------
// WorkflowSelectionTab — placeholder (no eval procedure in RPC contract yet)
// ---------------------------------------------------------------------------

/**
 * WorkflowSelectionTab — workflow selection evaluation.
 *
 * No dedicated `eval.workflowSelection` procedure exists in the RPC contract
 * yet. This tab shows a placeholder directing users to the CLI.
 */
export function WorkflowSelectionTab() {
  return (
    <>
      {/* ── Placeholder ── */}
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div
            style={{
              fontSize: 40,
              marginBottom: 16,
              opacity: 0.5,
            }}
          >
            🚧
          </div>
          <h3
            style={{
              fontFamily: 'var(--font-d)',
              fontSize: 18,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Coming Soon
          </h3>
          <p
            style={{
              color: 'var(--text-s)',
              fontSize: 14,
              maxWidth: 400,
              margin: '0 auto 16px',
              lineHeight: 1.5,
            }}
          >
            Workflow selection evaluation is not yet available in the web UI.
            Use the CLI for now.
          </p>
          <code
            style={{
              display: 'inline-block',
              fontFamily: 'var(--font-m)',
              fontSize: 12,
              padding: '8px 16px',
              background: 'var(--border-l)',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text-s)',
            }}
          >
            tekon eval workflow-selection
          </code>
        </div>
      </div>
    </>
  );
}
