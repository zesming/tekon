import type { ApiWorkflowItem } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// WorkflowDetailPanel — slide-in side panel showing workflow template details
// ---------------------------------------------------------------------------

interface WorkflowDetailPanelProps {
  workflow: ApiWorkflowItem;
  onClose: () => void;
}

/** Extract a relative path display from the full filesystem path. */
function relativePath(fullPath: string): string {
  const idx = fullPath.indexOf('workflows/');
  if (idx >= 0) return fullPath.slice(idx);
  const segments = fullPath.split('/');
  return segments.slice(-2).join('/');
}

export function WorkflowDetailPanel({
  workflow,
  onClose,
}: WorkflowDetailPanelProps) {
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
              {workflow.name}
            </div>
            <div className="text-sm text-muted" style={{ marginTop: '2px' }}>
              {workflow.id}
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
          {/* Properties */}
          <div className="detail-section">
            <div className="detail-section-title">属性 Properties</div>
            <dl className="detail-kv">
              <dt>ID</dt>
              <dd className="text-mono">{workflow.id}</dd>
              <dt>Name</dt>
              <dd>{workflow.name}</dd>
              <dt>Source</dt>
              <dd className="text-mono">{relativePath(workflow.path)}</dd>
            </dl>
          </div>

          {/* Actions */}
          <div className="detail-section">
            <div className="detail-section-title">操作 Actions</div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm">
                📄 查看 YAML
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
