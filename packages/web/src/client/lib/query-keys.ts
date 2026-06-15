// ---------------------------------------------------------------------------
// Centralized query key factory with auth-scoped keys
// ---------------------------------------------------------------------------

/**
 * Compute a short hash of an auth token for cache-key differentiation.
 * Returns `'anon'` for null / empty tokens so unauthenticated queries
 * share a single namespace.
 */
export function authScope(token: string | null): string {
  if (!token) return 'anon';
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/**
 * Factory functions for building cache keys.
 *
 * Keys that accept a `scope` parameter are auth-scoped: they include a
 * token-derived suffix so that data from different sessions never collide.
 * Keys without `scope` are session-independent (e.g. artifacts, audit logs,
 * static configuration).
 */
export const queryKeys = {
  // ── Auth-scoped keys ────────────────────────────────────────────────────
  projectOverview: (scope: string) => `project.overview.${scope}`,
  projectDetail: (projectId: string, scope: string) => `project.detail.${projectId}.${scope}`,
  runList: (scope: string) => `run.list.${scope}`,
  runDetail: (runId: string, scope: string) => `run.detail.${runId}.${scope}`,
  gateResults: (runId: string, scope: string) => `gate.results.${runId}.${scope}`,
  reviewDetail: (runId: string, scope: string) => `review.${runId}.${scope}`,
  deliveryCiStatus: (runId: string, scope: string) => `delivery.ciStatus.${runId}.${scope}`,

  // ── Session-independent keys ────────────────────────────────────────────
  artifacts: (runId: string, nodeId?: string) => `artifacts.${runId}.${nodeId ?? 'all'}`,
  auditLog: (runId: string) => `audit.${runId}`,
  readiness: (runId: string) => `readiness.${runId}`,
  deliveryStatus: (runId: string) => `delivery.${runId}`,
  humanDecisions: (runId: string) => `human.decisions.${runId}`,
  progress: (runId: string) => `progress.${runId}`,
  draftShapeDetail: (shapePath: string) => `draftShape.detail.${shapePath}`,
  roles: () => 'roles',
  workflows: () => 'workflows',
  settings: () => 'settings',
};
