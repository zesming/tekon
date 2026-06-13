import type { ApiRoleItem } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// RoleDetailPanel — slide-in side panel showing role details
//
// SECURITY: systemPrompt is intentionally NOT displayed to prevent
// leaking agent instructions through the web UI.
// ---------------------------------------------------------------------------

interface RoleDetailPanelProps {
  role: ApiRoleItem;
  onClose: () => void;
}

/** Map well-known role IDs to human-friendly descriptions. */
const roleDescriptions: Record<string, string> = {
  pm: 'Product Manager — scope definition, requirements, PRD',
  rd: 'Research & Development — design, implementation, fix',
  qa: 'Quality Assurance — test planning, validation, signoff',
  reviewer: 'Independent code and design review',
  pmo: 'Project Management Office — delivery checkpoint',
};

export function RoleDetailPanel({ role, onClose }: RoleDetailPanelProps) {
  const description = roleDescriptions[role.id];

  return (
    <div
      className="detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="detail-panel">
        {/* ── Header ── */}
        <div className="detail-panel-header">
          <div>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '20px',
                fontWeight: 600,
              }}
            >
              {role.name}
            </div>
            <div className="text-sm text-muted" style={{ marginTop: '2px' }}>
              {role.id}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        <div className="detail-panel-body">
          {/* Overview */}
          {description !== undefined && (
            <div className="detail-section">
              <div className="detail-section-title">概述 Overview</div>
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--text-s)',
                  lineHeight: 1.7,
                }}
              >
                {description}
              </p>
            </div>
          )}

          {/* Properties */}
          <div className="detail-section">
            <div className="detail-section-title">属性 Properties</div>
            <dl className="detail-kv">
              <dt>ID</dt>
              <dd className="text-mono">{role.id}</dd>
              <dt>Name</dt>
              <dd>{role.name}</dd>
              <dt>Source</dt>
              <dd className="text-mono">.tekon/roles/{role.id}/</dd>
              <dt>System Prompt</dt>
              <dd>
                {role.hasSystemPrompt ? (
                  <span
                    style={{ color: 'var(--text-t)', fontStyle: 'italic' }}
                  >
                    configured (hidden)
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-t)' }}>not configured</span>
                )}
              </dd>
            </dl>
          </div>

          {/* Security Notice */}
          <div
            className="detail-section"
            style={{
              padding: '12px 16px',
              background: '#fffbeb',
              borderRadius: 'var(--r-sm)',
              border: '1px solid #fde68a',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: '#92400e',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '6px',
              }}
            >
              ⚠ Security Notice
            </div>
            <div style={{ fontSize: '12px', color: '#92400e' }}>
              System prompts are not exposed through the web UI for security
              reasons. To view or edit role prompts, access the role directory
              directly.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
