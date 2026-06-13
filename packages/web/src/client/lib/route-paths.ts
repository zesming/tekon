// ---------------------------------------------------------------------------
// Route path constants and helpers
// ---------------------------------------------------------------------------

export const routes = {
  home: '/',
  runs: '/runs',
  run: (runId: string) => `/runs/${encodeURIComponent(runId)}` as const,
  review: (runId: string) => `/runs/${encodeURIComponent(runId)}/review` as const,
  runArtifacts: (runId: string) => `/runs/${encodeURIComponent(runId)}/artifacts` as const,
  runGates: (runId: string) => `/runs/${encodeURIComponent(runId)}/gates` as const,
  audit: (runId: string) => `/runs/${encodeURIComponent(runId)}/audit` as const,
  runDelivery: (runId: string) => `/runs/${encodeURIComponent(runId)}/delivery` as const,
  runProgress: (runId: string) => `/runs/${encodeURIComponent(runId)}/progress` as const,
  approvals: '/approvals',
  delivery: '/delivery',
  demand: '/demand',
  config: '/config',
  configRoles: '/config/roles',
  configWorkflows: '/config/workflows',
  configConstraints: '/config/constraints',
  eval: '/eval',
  evalReadiness: '/eval/readiness',
  evalDemandShape: '/eval/demand-shape',
  evalApprovalSummary: '/eval/approval-summary',
  evalWorkflowSelection: '/eval/workflow-selection',
} as const;

/**
 * Parse a run ID from a pathname like /runs/{runId} or /runs/{runId}/review.
 */
export function parseRunId(pathname: string): string | null {
  const match = pathname.match(/^\/runs\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
