import { useState } from 'react';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import type {
  WorkflowListOutput,
  ApiWorkflowItem,
} from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { WorkflowDetailPanel } from '../../components/config/WorkflowDetailPanel.js';

// ---------------------------------------------------------------------------
// WorkflowsTab — workflow template table with side-panel detail view
// ---------------------------------------------------------------------------

/** Derive a human-readable source label from the file path. */
function sourceLabel(path: string): string {
  if (/\.ya?ml$/u.test(path)) return 'yaml';
  const ext = path.split('.').pop();
  return ext ?? 'file';
}

export function WorkflowsTab() {
  const [selected, setSelected] = useState<ApiWorkflowItem | null>(null);

  const query = useQuery<WorkflowListOutput>('config:workflows', () =>
    rpc.call('workflow.list'),
  );

  const workflows = query.data?.workflows ?? [];

  // ── Loading ──────────────────────────────────────────────────────────────
  if (query.isLoading) {
    return <LoadingState message="Loading workflows..." />;
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (query.error) {
    return <ErrorBanner error={query.error} onRetry={query.refetch} />;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <Card
        title="工作流模板 Workflow Templates"
        headerRight={
          <span className="text-sm text-muted">
            {workflows.length} template{workflows.length !== 1 ? 's' : ''}
          </span>
        }
        full
        compact
      >
        {workflows.length === 0 ? (
          <EmptyState
            message="No workflows configured"
            hint="Add YAML workflow definitions under .tekon/workflows/."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {workflows.map((wf) => (
                  <tr key={wf.id}>
                    <td className="cell-mono">{wf.id}</td>
                    <td className="cell-primary">{wf.name}</td>
                    <td>
                      <span className="source-badge">
                        {sourceLabel(wf.path)}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setSelected(wf)}
                      >
                        查看 →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Detail side panel ── */}
      {selected !== null && (
        <WorkflowDetailPanel
          workflow={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
