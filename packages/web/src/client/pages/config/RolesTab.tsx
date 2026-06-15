import { useState } from 'react';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { RoleListOutput, ApiRoleItem } from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { RoleDetailPanel } from '../../components/config/RoleDetailPanel.js';

// ---------------------------------------------------------------------------
// RolesTab — role configuration table with side-panel detail view
// ---------------------------------------------------------------------------

/** Static descriptions for well-known role IDs. */
const roleDescriptions: Record<string, string> = {
  pm: 'Product Manager — scope definition, requirements, PRD',
  rd: 'Research & Development — design, implementation, fix',
  qa: 'Quality Assurance — test planning, validation, signoff',
  reviewer: 'Independent code and design review',
  pmo: 'Project Management Office — delivery checkpoint',
};

export function RolesTab() {
  const [selectedRole, setSelectedRole] = useState<ApiRoleItem | null>(null);

  const query = useQuery<RoleListOutput>(queryKeys.roles(), () =>
    rpc.call('role.list'),
  );

  const roles = query.data?.roles ?? [];

  // ── Loading ──────────────────────────────────────────────────────────────
  if (query.isLoading) {
    return <LoadingState message="Loading roles..." />;
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (query.error) {
    return <ErrorBanner error={query.error} onRetry={query.refetch} />;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <Card
        title="角色列表 Roles"
        headerRight={
          <span className="text-sm text-muted">
            {roles.length} role{roles.length !== 1 ? 's' : ''}
          </span>
        }
        full
        compact
      >
        {roles.length === 0 ? (
          <EmptyState
            message="No roles configured"
            hint="Create role directories under .tekon/roles/ to define agent roles."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Prompt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td className="cell-mono">{role.id}</td>
                    <td className="cell-primary">{role.name}</td>
                    <td className="cell-secondary">
                      {roleDescriptions[role.id] ?? '—'}
                    </td>
                    <td>
                      {role.hasSystemPrompt ? (
                        <span className="badge-tag pass">configured</span>
                      ) : (
                        <span className="badge-tag muted">none</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setSelectedRole(role)}
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
      {selectedRole !== null && (
        <RoleDetailPanel
          role={selectedRole}
          onClose={() => setSelectedRole(null)}
        />
      )}
    </>
  );
}
