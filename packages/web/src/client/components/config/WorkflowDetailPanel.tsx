import { useDialogA11y } from '../../hooks/use-dialog-a11y.js';
import type { ApiWorkflowItem } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// WorkflowDetailPanel — slide-in side panel showing workflow template details
// ---------------------------------------------------------------------------

interface WorkflowDetailPanelProps {
  workflow: ApiWorkflowItem;
  onClose: () => void;
}

/** Extract a relative path display from the full filesystem path. */
function relativePath(fullPath: string | undefined): string {
  if (!fullPath) return '内置模板';
  const idx = fullPath.indexOf('workflows/');
  if (idx >= 0) return fullPath.slice(idx);
  const segments = fullPath.split('/');
  return segments.slice(-2).join('/');
}

export function WorkflowDetailPanel({
  workflow,
  onClose,
}: WorkflowDetailPanelProps) {
  const panelRef = useDialogA11y<HTMLDivElement>({ onClose });
  const titleId = `workflow-detail-title-${workflow.id}`;

  return (
    <div
      className="detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* ── Header ── */}
        <div className="detail-panel-header">
          <div>
            <div
              id={titleId}
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
            aria-label="关闭工作流详情"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        <div className="detail-panel-body">
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
        </div>
      </div>
    </div>
  );
}
