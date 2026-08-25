import { z } from 'zod';
import { draftShapeSchema, sessionStatusSchema } from '@tekon/core';

// ---------------------------------------------------------------------------
// Shared sub-schemas (domain building blocks)
// ---------------------------------------------------------------------------

export const approvalImpactStatusSchema = z.enum([
  'available',
  'none',
  'unavailable',
]);

export const workReadinessSeveritySchema = z.enum(['required', 'recommended']);

export const reviewEvidenceLinkKindSchema = z.enum([
  'artifact',
  'gate-log',
  'audit-event',
  'pr-body',
  'pr-package',
  'diff',
]);

export const reviewGateRetryRecommendationSchema = z.enum([
  'after-fix',
  'after-approval',
  'not-recommended',
]);

export const reviewEvidenceGroupStatusSchema = z.enum([
  'failed',
  'warning',
  'info',
]);

export const reviewEvidenceGroupSeveritySchema = z.enum([
  'required',
  'recommended',
  'context',
]);

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const tokenRunInputSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
});

export const projectRunInputSchema = z.object({
  demandText: z.string(),
  token: z.string().min(1),
  // 4b: 'goal' runs the built-in single-node goal template (ignores template);
  // omitted/'workflow' keeps the governed delivery-workflow path.
  mode: z.enum(['workflow', 'goal']).optional(),
  // 4d: session profile. autonomous-delivery unlocks auto-prepare delivery
  // (never PR creation — governance red line). Omitted → human-web. review-only
  // is intentionally NOT accepted here: starting a run is itself a mutation, so
  // a run cannot create a read-only session; review-only enforcement is
  // deferred until a dedicated review-only entry point exists (design §1.2.3).
  profile: z.enum(['human-web', 'autonomous-delivery']).optional(),
  template: z.string().optional(),
  agent: z.string().optional(),
  allowDirtyBase: z.boolean().optional(),
  demandShapePath: z.string().optional(),
  timeoutMs: z.number().optional(),
  noProgressTimeoutMs: z.number().optional(),
  progressHeartbeatMs: z.number().optional(),
});

export const draftShapeInputSchema = z.object({
  demandText: z.string(),
  token: z.string().min(1),
});

export const draftShapeApproveInputSchema = z.object({
  shapePath: z.string().min(1),
  token: z.string().min(1),
  actor: z.string().optional(),
});

// 4f-2: plan flow. generatePlan freezes the draft's plan view (hasPlan=true);
// planApprove is a SEPARATE approval from demand approve. planApprove carries an
// actor (who approved the plan); generatePlan does not.
export const draftShapeGeneratePlanInputSchema = z.object({
  shapePath: z.string().min(1),
  token: z.string().min(1),
});

export const draftShapePlanApproveInputSchema = z.object({
  shapePath: z.string().min(1),
  token: z.string().min(1),
  actor: z.string().optional(),
});

export const projectCleanInputSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
  confirm: z.literal('delete-run-dir'),
});

export const deliveryCreatePrInputSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
  approveHuman: z.literal(true),
});

export const decisionInputSchema = z.object({
  runId: z.string().min(1),
  decisionId: z.string().min(1),
  actor: z.string().min(1),
  note: z.string().optional(),
  token: z.string().min(1),
});

export const projectDetailInputSchema = z.object({
  projectId: z.string().min(1),
});

export const runIdInputSchema = z.object({
  runId: z.string().min(1),
});

export const auditListInputSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().optional(),
  gateId: z.string().optional(),
  role: z.string().optional(),
});

export const reviewGetInputSchema = z.object({
  runId: z.string().min(1),
  maxContentChars: z.number().optional(),
});

export const deliveryCiStatusInputSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
  selector: z.string().optional(),
});

export const progressListInputSchema = z.object({
  runId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Output schemas — must match mappers.ts output shapes exactly
// ---------------------------------------------------------------------------

export const apiProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    repoPath: z.string(),
    createdAt: z.string(),
  })
  .strict(); // strict: project metadata must not carry extra fields

export const apiWorkflowSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    demandId: z.string(),
    // Human-readable request title + real provider for run lists / detail
    // (report §6.3/§6.4, P1.3/P1.4). Null when not resolvable (e.g. the
    // run/resume mutation return path, which maps from the domain object).
    demandTitle: z.string().nullable(),
    provider: z.string().nullable(),
    status: z.string(),
    currentNodeId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict(); // strict: workflow/run state must not carry unexpected fields

export const apiArtifactSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    type: z.string(),
    version: z.number(),
    path: z.string(),
    sha256: z.string(),
    sizeBytes: z.number(),
    summary: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict(); // strict: artifacts must not expose internal build metadata

export const apiGateSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    gateType: z.string(),
    status: z.string(),
    outputPath: z.string().nullable(),
    durationMs: z.number(),
    retries: z.number(),
    fixAttemptId: z.string().nullable(),
    failureClassification: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict(); // strict: gate records must not leak internal diagnostics

export const apiAuditEventSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    nodeId: z.string().nullable(),
    gateId: z.string().nullable(),
    role: z.string().nullable(),
    prevHash: z.string().nullable(),
    hash: z.string(),
    createdAt: z.string(),
  })
  .strict(); // strict: audit events must not carry hidden metadata

// --- Nested types from @tekon/core used in HumanDecisionOutput ---

export const workReadinessCheckSchema = z.object({
  id: z.string(),
  severity: workReadinessSeveritySchema,
  passed: z.boolean(),
  evidence: z.string(),
});

export const reviewEvidenceLinkSchema = z.object({
  kind: reviewEvidenceLinkKindSchema,
  label: z.string(),
  href: z.string(),
  summary: z.string(),
});

export const approvalSummaryCheckSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  evidence: z.string(),
});

export const approvalSummaryEvaluationSchema = z.object({
  ready: z.boolean(),
  score: z.number(),
  checks: z.array(approvalSummaryCheckSchema),
});

export const humanApprovalSummarySchema = z.object({
  decisionId: z.string(),
  decisionStatus: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  nodeRole: z.string().nullable(),
  workflowStatus: z.string(),
  demandTitle: z.string(),
  gate: z
    .object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      failureClassification: z.string().nullable(),
    })
    .nullable(),
  riskLabel: z.string(),
  exactCommand: z.string(),
  requestContext: z.string(),
  impact: z.object({
    status: approvalImpactStatusSchema,
    files: z.array(z.string()),
    reason: z.string().nullable(),
  }),
  readinessFailed: z.array(workReadinessCheckSchema),
  evidenceLinks: z.array(reviewEvidenceLinkSchema),
  approveCommand: z.string(),
  rejectCommand: z.string(),
  webActionHint: z.string(),
  summaryText: z.string(),
});

export const apiHumanDecisionContextGateSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  nodeId: z.string(),
  outputPath: z.string().nullable(),
  failureClassification: z.string().nullable(),
});

export const apiHumanDecisionContextSchema = z.object({
  request: z.string(),
  exactCommand: z.string(),
  riskLabel: z.string(),
  nodeRole: z.string().nullable(),
  approvalSummary: humanApprovalSummarySchema.nullable(),
  approvalEvaluation: approvalSummaryEvaluationSchema.nullable(),
  gate: apiHumanDecisionContextGateSchema.nullable(),
});

export const apiHumanDecisionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    gateResultId: z.string().nullable(),
    status: z.string(),
    actor: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
    context: apiHumanDecisionContextSchema,
  })
  .strict(); // strict: decision records must not leak extra fields

// --- Audit verification ---

export const auditVerificationSchema = z.union([
  z.object({ valid: z.literal(true) }),
  z.object({ valid: z.literal(false), brokenEventId: z.string() }),
]);

// --- Review surface sub-schemas ---

export const textPreviewSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  truncated: z.boolean(),
  sizeBytes: z.number(),
});

export const workReadinessEvaluationSchema = z.object({
  runId: z.string(),
  ready: z.boolean(),
  score: z.number(),
  checks: z.array(workReadinessCheckSchema),
});

export const prePullRequestReadinessCheckSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  evidence: z.string(),
});

export const prePullRequestReadinessSchema = z.object({
  runId: z.string(),
  ready: z.boolean(),
  checks: z.array(prePullRequestReadinessCheckSchema),
});

export const reviewArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  type: z.string(),
  version: z.number(),
  path: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  summary: z.string().optional(),
  createdAt: z.string(),
  content: textPreviewSchema,
});

export const reviewGateSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  gateType: z.string(),
  gateKey: z.string().nullable().optional(),
  status: z.string(),
  outputPath: z.string().nullable().optional(),
  durationMs: z.number(),
  retries: z.number(),
  fixAttemptId: z.string().nullable().optional(),
  failureClassification: z.string().nullable().optional(),
  createdAt: z.string(),
  output: textPreviewSchema.nullable(),
});

export const reviewGateFailureTriageSchema = z.object({
  gateId: z.string(),
  nodeId: z.string(),
  gateType: z.string(),
  status: z.string(),
  classification: z.string(),
  retry: reviewGateRetryRecommendationSchema,
  summary: z.string(),
  suggestedCommand: z.string(),
  logHref: z.string(),
});

export const reviewDiffSummarySchema = z.object({
  branch: z.string(),
  baseBranch: z.string(),
  available: z.boolean(),
  stat: z.string(),
  changedFiles: z.array(z.string()),
  reason: z.string().optional(),
});

export const reviewDeliverySurfaceSchema = z.object({
  status: z.string(),
  prUrl: z.string().nullable(),
  package: textPreviewSchema.nullable(),
  prBody: textPreviewSchema.nullable(),
  diff: reviewDiffSummarySchema,
});

export const reviewEvidenceGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: reviewEvidenceGroupStatusSchema,
  severity: reviewEvidenceGroupSeveritySchema,
  summary: z.string(),
  links: z.array(reviewEvidenceLinkSchema),
});

// NOTE: .strict() intentionally omitted — this is a large, multi-facet review
// surface with many nested arrays. Field drift here is low-risk (read-only UI
// data) and strict validation would be too brittle as sub-schemas evolve.
export const workReviewSurfaceSchema = z.object({
  runId: z.string(),
  workflowStatus: z.string(),
  // Real provider recorded for the run (report §6.4/P1.4: Run Detail derived
  // the agent as a fixed "—"). Optional/nullable: older runs and the core
  // surface builder do not carry it; the web router enriches from the db.
  provider: z.string().nullable().optional(),
  demand: z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  readiness: workReadinessEvaluationSchema,
  prePullRequestReadiness: prePullRequestReadinessSchema,
  artifacts: z.array(reviewArtifactSchema),
  gates: z.array(reviewGateSchema),
  gateFailureTriage: z.array(reviewGateFailureTriageSchema),
  delivery: reviewDeliverySurfaceSchema,
  evidenceGroups: z.array(reviewEvidenceGroupSchema),
  nextCommands: z.array(z.string()),
});

// --- Role and Workflow list items ---

export const roleItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    hasSystemPrompt: z.boolean(),
  })
  .strict(); // strict: must not leak systemPrompt or other internal fields

export const workflowItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});

// ---------------------------------------------------------------------------
// Compound output schemas for each procedure
// ---------------------------------------------------------------------------

export const projectOverviewCountsSchema = z.object({
  artifacts: z.number(),
  gates: z.number(),
  audit: z.number(),
  pendingApprovals: z.number(),
  roles: z.number(),
  workflows: z.number(),
});

export const projectOverviewOutputSchema = z.object({
  project: apiProjectSchema,
  latestRun: apiWorkflowSchema.nullable(),
  counts: projectOverviewCountsSchema,
});

export const projectDetailOutputSchema = z.object({
  project: apiProjectSchema,
  runs: z.array(apiWorkflowSchema),
});

export const runWrapperOutputSchema = z.object({
  run: apiWorkflowSchema,
  // S7b: run/resume enqueue a background job and return immediately; pause/
  // cancel resolve the active job. Optional so legacy shapes still validate.
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
});

export const projectCleanOutputSchema = z.object({
  removedRunDir: z.boolean(),
});

export const draftShapeOutputSchema = z.object({
  shape: draftShapeSchema,
  shapePath: z.string(),
  reviewPath: z.string(),
  runText: z.string(),
});

export const draftShapeDetailInputSchema = z.object({
  shapePath: z.string().min(1),
  token: z.string().min(1),
});

export const draftShapeDetailOutputSchema = z.object({
  shape: draftShapeSchema,
});

export const draftShapeApproveOutputSchema = z.object({
  shape: draftShapeSchema,
  shapePath: z.string(),
});

// 4f-2: generatePlan / planApprove both return the updated shape + its path,
// mirroring the approve output shape.
export const draftShapeGeneratePlanOutputSchema = z.object({
  shape: draftShapeSchema,
  shapePath: z.string(),
});

export const draftShapePlanApproveOutputSchema = z.object({
  shape: draftShapeSchema,
  shapePath: z.string(),
});

export const deliveryPrepareOutputSchema = z.object({
  runId: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  packagePath: z.string(),
  prBodyPath: z.string(),
  requiresHumanApproval: z.boolean(),
});

export const deliveryCreatePrOutputSchema = z.object({
  runId: z.string(),
  deliveryStatus: z.string(),
  requiresHumanApproval: z.boolean(),
  prUrl: z.string().nullable(),
  failureStage: z.string().nullable(),
  lastError: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
});

export const artifactListOutputSchema = z.object({
  artifacts: z.array(apiArtifactSchema),
});

export const gateListOutputSchema = z.object({
  gates: z.array(apiGateSchema),
  pendingDecisions: z.array(apiHumanDecisionSchema),
});

export const decisionOutputSchema = z.object({
  decision: apiHumanDecisionSchema,
  // S7d/M9: gate.approve resumes the run asynchronously via the job runner and
  // returns the bound session + enqueued job so the client can follow it. reject
  // stays synchronous (blocked) and omits both.
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
});

export const auditListOutputSchema = z.object({
  verification: auditVerificationSchema,
  events: z.array(apiAuditEventSchema),
});

export const roleListOutputSchema = z.object({
  roles: z.array(roleItemSchema),
});

export const workflowListOutputSchema = z.object({
  workflows: z.array(workflowItemSchema),
});

// --- Delivery dry-run and CI status ---

export const deliveryDryRunOutputSchema = z.object({
  runId: z.string(),
  workflowStatus: z.string(),
  artifacts: z.number(),
  gates: z.object({
    total: z.number(),
    passed: z.number(),
  }),
  pendingHumanDecisions: z.number(),
  deliveryStatus: z.string(),
  readyForPrepare: z.boolean(),
  dryRun: z.literal(true),
});

export const deliveryCiCheckSchema = z.object({
  name: z.string(),
  state: z.string().nullable(),
  bucket: z.string().nullable(),
  workflow: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

export const deliveryCiStatusOutputSchema = z.object({
  runId: z.string(),
  status: z.string(),
  checks: z.array(deliveryCiCheckSchema),
  prUrl: z.string().nullable().optional(),
  error: z.string().optional(),
});

// --- Progress list ---

// NOTE: .strict() intentionally omitted — 17 fields including activity metadata
// and risk assessment; high churn surface where strict would be too brittle.
export const progressFileSchema = z.object({
  nodeId: z.string().nullable(),
  status: z.string(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  elapsedMs: z.number(),
  timeoutMs: z.number().nullable(),
  noProgressTimeoutMs: z.number(),
  timeoutReason: z.string().nullable(),
  // Activity metadata (NOT full content)
  lastOutputAt: z.string().nullable(),
  stdoutBytes: z.number(),
  stderrBytes: z.number(),
  lastOutputDirAt: z.string().nullable(),
  outputDirFileCount: z.number(),
  heartbeatCount: z.number(),
  // Risk assessment
  approachingTimeout: z.boolean(),
  secondsRemaining: z.number(),
  // Redacted command
  redactedCommand: z.string(),
});

export const progressListOutputSchema = z.object({
  runId: z.string(),
  progressFiles: z.array(progressFileSchema),
});

// Phase 3 3a: session read-path. A session entry mirrors the core Session
// metadata plus the run_id column (the frozen Session schema has no runId).
// Reuses core's sessionStatusSchema to avoid a drifting duplicate enum.
export const apiSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  profile: z.string(),
  status: sessionStatusSchema,
  runId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// session.list takes no client input: the server resolves the current
// workspace from projectRoot and returns its id (M2 — the client has no
// workspaceId to supply).
export const sessionListOutputSchema = z.object({
  workspaceId: z.string(),
  sessions: z.array(apiSessionSchema),
});

export const sessionGetInputSchema = z.object({
  sessionId: z.string().min(1),
});

export const sessionGetOutputSchema = z.object({
  session: apiSessionSchema,
});

// ---------------------------------------------------------------------------
// Procedure specs — the single source of truth for every RPC endpoint
// ---------------------------------------------------------------------------

export const procedureSpecs = {
  'project.list': {
    auth: 'none' as const,
    input: z.undefined(),
    output: z.array(apiProjectSchema),
  },
  'project.overview': {
    auth: 'none' as const,
    input: z.undefined(),
    output: projectOverviewOutputSchema,
  },
  'project.detail': {
    auth: 'none' as const,
    input: projectDetailInputSchema,
    output: projectDetailOutputSchema,
  },
  'project.pause': {
    auth: 'token' as const,
    input: tokenRunInputSchema,
    output: runWrapperOutputSchema,
  },
  'project.run': {
    auth: 'token' as const,
    input: projectRunInputSchema,
    output: runWrapperOutputSchema,
  },
  'project.resume': {
    auth: 'token' as const,
    input: tokenRunInputSchema,
    output: runWrapperOutputSchema,
  },
  'project.cancel': {
    auth: 'token' as const,
    input: tokenRunInputSchema,
    output: runWrapperOutputSchema,
  },
  'project.clean': {
    auth: 'token' as const,
    input: projectCleanInputSchema,
    output: projectCleanOutputSchema,
  },

  'draftShape.shape': {
    auth: 'token' as const,
    input: draftShapeInputSchema,
    output: draftShapeOutputSchema,
  },
  'draftShape.detail': {
    auth: 'token' as const,
    input: draftShapeDetailInputSchema,
    output: draftShapeDetailOutputSchema,
  },
  'draftShape.approve': {
    auth: 'token' as const,
    input: draftShapeApproveInputSchema,
    output: draftShapeApproveOutputSchema,
  },
  // 4f-2: plan flow. generatePlan freezes the plan view; planApprove is a
  // SEPARATE approval from demand approve. project.run gates a run on plan
  // approval only when hasPlan is set (old drafts exempt — backward compatible).
  'draftShape.generatePlan': {
    auth: 'token' as const,
    input: draftShapeGeneratePlanInputSchema,
    output: draftShapeGeneratePlanOutputSchema,
  },
  'draftShape.planApprove': {
    auth: 'token' as const,
    input: draftShapePlanApproveInputSchema,
    output: draftShapePlanApproveOutputSchema,
  },

  'delivery.prepare': {
    auth: 'token' as const,
    input: tokenRunInputSchema,
    output: deliveryPrepareOutputSchema,
  },
  'delivery.createPr': {
    auth: 'token' as const,
    input: deliveryCreatePrInputSchema,
    output: deliveryCreatePrOutputSchema,
  },
  'delivery.dryRun': {
    auth: 'token' as const,
    input: tokenRunInputSchema,
    output: deliveryDryRunOutputSchema,
  },
  'delivery.ciStatus': {
    auth: 'token' as const,
    input: deliveryCiStatusInputSchema,
    output: deliveryCiStatusOutputSchema,
  },

  'artifact.list': {
    auth: 'session' as const,
    input: runIdInputSchema,
    output: artifactListOutputSchema,
  },

  'gate.list': {
    auth: 'session' as const,
    input: runIdInputSchema,
    output: gateListOutputSchema,
  },
  'gate.approve': {
    auth: 'token' as const,
    input: decisionInputSchema,
    output: decisionOutputSchema,
  },
  'gate.reject': {
    auth: 'token' as const,
    input: decisionInputSchema,
    output: decisionOutputSchema,
  },

  'audit.list': {
    auth: 'session' as const,
    input: auditListInputSchema,
    output: auditListOutputSchema,
  },

  'review.get': {
    auth: 'session' as const,
    input: reviewGetInputSchema,
    output: workReviewSurfaceSchema,
  },

  'role.list': {
    auth: 'none' as const,
    input: z.undefined(),
    output: roleListOutputSchema,
  },

  'workflow.list': {
    auth: 'none' as const,
    input: z.undefined(),
    output: workflowListOutputSchema,
  },

  'progress.list': {
    auth: 'session' as const,
    input: progressListInputSchema,
    output: progressListOutputSchema,
  },

  // Phase 3 3a: session read-path. Both are auth:'session' (require the
  // x-session-token header) — the client's rpc-client must send it (M1 fix).
  'session.list': {
    auth: 'session' as const,
    input: z.undefined(),
    output: sessionListOutputSchema,
  },
  'session.get': {
    auth: 'session' as const,
    input: sessionGetInputSchema,
    output: sessionGetOutputSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// Derived type utilities
// ---------------------------------------------------------------------------

export type ProcedureName = keyof typeof procedureSpecs;

export type RpcProcedureMap = {
  [P in ProcedureName]: {
    input: z.input<(typeof procedureSpecs)[P]['input']>;
    output: z.output<(typeof procedureSpecs)[P]['output']>;
  };
};
