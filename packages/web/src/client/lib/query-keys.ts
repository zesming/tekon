// ---------------------------------------------------------------------------
// Centralized query key factory with auth-scoped keys
// ---------------------------------------------------------------------------

const MAX_AUTH_SCOPE_TOKENS = 128;
const tokenScopes = new Map<string, string>();
let nextAuthScopeId = 1;

/**
 * Assign a process-local opaque cache scope to an auth token. A bounded token
 * map avoids putting credentials in query keys while guaranteeing that two
 * distinct retained tokens cannot collide. Evicted tokens receive a fresh,
 * never-reused scope if seen again, which causes a safe cache miss.
 */
export function authScope(token: string | null): string {
  if (!token) return 'anon';

  const existing = tokenScopes.get(token);
  if (existing) {
    tokenScopes.delete(token);
    tokenScopes.set(token, existing);
    return existing;
  }

  if (tokenScopes.size >= MAX_AUTH_SCOPE_TOKENS) {
    const oldestToken = tokenScopes.keys().next().value;
    if (oldestToken !== undefined) tokenScopes.delete(oldestToken);
  }
  const scope = `auth-${(nextAuthScopeId++).toString(36)}`;
  tokenScopes.set(token, scope);
  return scope;
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
  projectHealth: (scope: string) => `project.health.${scope}`,
  projectProviderHealth: (provider: string, scope: string) =>
    `project.providerHealth.${provider}.${scope}`,
  projectOverview: (scope: string) => `project.overview.${scope}`,
  projectDetail: (projectId: string, scope: string) =>
    `project.detail.${projectId}.${scope}`,
  runList: (scope: string) => `run.list.${scope}`,
  runDetail: (runId: string, scope: string) =>
    `run.detail.${runId}.${scope}`,
  sessionList: (scope: string) => `session.list.${scope}`,
  sessionDetail: (sessionId: string, scope: string) =>
    `session.detail.${sessionId}.${scope}`,
  gateResults: (runId: string, scope: string) =>
    `gate.results.${runId}.${scope}`,
  reviewDetail: (runId: string, scope: string) =>
    `review.${runId}.${scope}`,
  deliveryCiStatus: (runId: string, scope: string) =>
    `delivery.ciStatus.${runId}.${scope}`,

  // ── Session-independent keys ────────────────────────────────────────────
  artifacts: (runId: string, nodeId?: string) =>
    `artifacts.${runId}.${nodeId ?? 'all'}`,
  auditLog: (runId: string) => `audit.${runId}`,
  readiness: (runId: string) => `readiness.${runId}`,
  deliveryStatus: (runId: string) => `delivery.${runId}`,
  humanDecisions: (runId: string) => `human.decisions.${runId}`,
  progress: (runId: string) => `progress.${runId}`,
  draftShapeDetail: (shapePath: string) =>
    `draftShape.detail.${shapePath}`,
  roles: () => 'roles',
  workflows: () => 'workflows',
  workflowPlan: (
    mode?: string,
    template?: string,
    agent?: string,
    profile?: string,
    allowDirtyBase?: boolean,
    timeoutMs?: number,
    noProgressTimeoutMs?: number,
    progressHeartbeatMs?: number,
  ) =>
    `workflow.plan.${mode ?? 'default'}.${template ?? 'default'}.${agent ?? 'default'}.${profile ?? 'default'}.${allowDirtyBase ? 'dirty' : 'clean'}.${timeoutMs ?? 'default'}.${noProgressTimeoutMs ?? 'default'}.${progressHeartbeatMs ?? 'default'}`,
  settings: () => 'settings',
};
