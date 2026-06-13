// ---------------------------------------------------------------------------
// Route path constants and helpers
// ---------------------------------------------------------------------------

export const routes = {
  home: '/',
  projects: '/projects',
  projectDetail: (projectId: string) => `/projects/${encodeURIComponent(projectId)}` as const,
  runs: '/runs',
  run: (runId: string) => `/runs/${encodeURIComponent(runId)}` as const,
  review: (runId: string) => `/runs/${encodeURIComponent(runId)}/review` as const,
  runArtifacts: (runId: string) => `/runs/${encodeURIComponent(runId)}/artifacts` as const,
  runGates: (runId: string) => `/runs/${encodeURIComponent(runId)}/gates` as const,
  audit: (runId: string) => `/runs/${encodeURIComponent(runId)}/audit` as const,
  runDelivery: (runId: string) => `/runs/${encodeURIComponent(runId)}/delivery` as const,
  runProgress: (runId: string) => `/runs/${encodeURIComponent(runId)}/progress` as const,
  artifacts: (runId: string) => `/runs/${encodeURIComponent(runId)}/artifacts` as const,
  gates: (runId: string) => `/runs/${encodeURIComponent(runId)}/gates` as const,
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
  roles: '/roles',
  workflows: '/workflows',
} as const;

/**
 * Parse a run ID from a pathname like /runs/{runId} or /runs/{runId}/review.
 */
export function parseRunId(pathname: string): string | null {
  const match = pathname.match(/^\/runs\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Parse a project ID from a pathname like /projects/{projectId}.
 */
export function parseProjectId(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
