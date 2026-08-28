// ---------------------------------------------------------------------------
// Route path constants and helpers
//
// Phase 3 3d: the human-first Session UI is the default (`/` → sessions). The
// legacy run-centric Cockpit is preserved under `/advanced/*` (report C2 —
// dual-track, nothing deleted). Old routes keep working, just prefixed.
// ---------------------------------------------------------------------------

const ADV = '/advanced';

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

