// ---------------------------------------------------------------------------
// Route path constants and helpers
//
// Phase 3 3d: the human-first Session UI is the default (`/` → sessions). The
// legacy run-centric Cockpit is preserved under `/advanced/*` (report C2 —
// dual-track, nothing deleted). Old routes keep working, just prefixed.
// ---------------------------------------------------------------------------

const ADV = '/advanced';

/** 将 Core 的证据语义锚点接到当前 Web 路由，不改变 Core 合同。 */
export function evidenceHref(runId: string, link: { kind: string; href: string }): string | null {
  const ids = {
    'audit-event': { prefix: '#audit-', path: routes.audit(runId), query: 'event' },
    artifact: { prefix: '#artifact-', path: routes.runArtifacts(runId), query: 'artifact' },
    'gate-log': { prefix: '#gate-log-', path: routes.runGates(runId), query: 'gate' },
  };
  const target = ids[link.kind as keyof typeof ids];
  if (target && link.href.startsWith(target.prefix) && link.href.length > target.prefix.length) {
    return `${target.path}?${target.query}=${encodeURIComponent(link.href.slice(target.prefix.length))}`;
  }
  const sections = { 'pr-body': '#pr-body', 'pr-package': '#pr-package', diff: '#delivery-diff' };
  if (Object.hasOwn(sections, link.kind) && sections[link.kind as keyof typeof sections] === link.href) {
    return `${routes.runDelivery(runId)}?section=${link.kind}`;
  }
  return null;
}

export const routes = {
  home: '/',
  sessions: '/',
  session: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}` as const,
  // Legacy Cockpit, now under /advanced.
  advanced: ADV,
  runs: `${ADV}/runs`,
  run: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}` as const,
  review: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/review` as const,
  runArtifacts: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/artifacts` as const,
  runGates: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/gates` as const,
  audit: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/audit` as const,
  runDelivery: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/delivery` as const,
  runProgress: (runId: string) => `${ADV}/runs/${encodeURIComponent(runId)}/progress` as const,
  approvals: `${ADV}/approvals`,
  delivery: `${ADV}/delivery`,
  demand: `${ADV}/demand`,
  config: `${ADV}/config`,
  configRoles: `${ADV}/config/roles`,
  configWorkflows: `${ADV}/config/workflows`,
  configConstraints: `${ADV}/config/constraints`,
  eval: `${ADV}/eval`,
  evalReadiness: `${ADV}/eval/readiness`,
  evalDemandShape: `${ADV}/eval/demand-shape`,
  evalApprovalSummary: `${ADV}/eval/approval-summary`,
  evalWorkflowSelection: `${ADV}/eval/workflow-selection`,
} as const;

/**
 * Parse a run ID from a pathname like /advanced/runs/{runId} or
 * /advanced/runs/{runId}/review.
 */
export function parseRunId(pathname: string): string | null {
  const match = pathname.match(/\/runs\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
