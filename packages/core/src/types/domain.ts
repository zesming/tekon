import { z } from 'zod';

export const isoDateStringSchema = z.string().datetime();

export const roleSchema = z.enum(['pm', 'rd', 'qa', 'reviewer', 'pmo']);
export type Role = z.infer<typeof roleSchema>;

export const workflowStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'passed',
  'blocked',
  'failed',
  'interrupted',
  'cancelled',
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const nodeStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-gate',
  'paused',
  'passed',
  'needs-revision',
  'blocked',
  'failed',
  'interrupted',
  'skipped',
]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const artifactTypeSchema = z.enum([
  'demand-card',
  'prd',
  'tech-design',
  'code-changes',
  'test-report',
  'review-report',
  'security-report',
  'rollback-plan',
  'delivery-package',
  'ci-status',
]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const gateTypeSchema = z.enum([
  'build',
  'test',
  'lint',
  'e2e-pass',
  'schema',
  'security-scan',
  'human',
]);
export type GateType = z.infer<typeof gateTypeSchema>;

export const gateStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'blocked',
  'skipped',
]);
export type GateStatus = z.infer<typeof gateStatusSchema>;

export const commandInvocationSchema = z.object({
  tool: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});
export type CommandInvocation = z.infer<typeof commandInvocationSchema>;

export const demandSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().optional(),
  createdAt: isoDateStringSchema,
});
export type Demand = z.infer<typeof demandSchema>;

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  createdAt: isoDateStringSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const gateConfigSchema = z.object({
  type: gateTypeSchema,
  command: commandInvocationSchema.optional(),
  commandRef: z
    .enum(['build', 'typecheck', 'lint', 'test', 'e2e', 'security'])
    .optional(),
  artifactType: artifactTypeSchema.optional(),
  requiresHumanApproval: z.boolean().default(false),
  maxRetries: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().positive().optional(),
});
export type GateConfig = z.infer<typeof gateConfigSchema>;

const nodeArtifactOutputRefSchema = z.object({
  id: z.string().min(1),
  type: artifactTypeSchema,
});

const nodeArtifactInputRefSchema = nodeArtifactOutputRefSchema.extend({
  fromNodeId: z.string().min(1),
});

export const phaseSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().min(1),
  status: nodeStatusSchema,
  order: z.number().int().min(0),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type Phase = z.infer<typeof phaseSchema>;

export const nodeSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phaseId: z.string().min(1).optional(),
  role: roleSchema,
  status: nodeStatusSchema,
  inputs: z.array(nodeArtifactInputRefSchema).default([]),
  outputs: z.array(nodeArtifactOutputRefSchema).default([]),
  gates: z.array(gateConfigSchema).default([]),
  dependencies: z.array(z.string()).default([]),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type NodeInput = z.input<typeof nodeSchema>;
export type Node = z.infer<typeof nodeSchema>;

export const workflowInstanceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  demandId: z.string().min(1),
  status: workflowStatusSchema,
  currentNodeId: z.string().nullable().optional(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;

export const roleRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  role: roleSchema,
  status: nodeStatusSchema,
  startedAt: isoDateStringSchema,
  completedAt: isoDateStringSchema.nullable().optional(),
  interruptedAt: isoDateStringSchema.nullable().optional(),
});
export type RoleRun = z.infer<typeof roleRunSchema>;

export const artifactRefSchema = z.object({
  id: z.string().min(1),
  type: artifactTypeSchema,
  version: z.number().int().positive(),
  path: z.string().min(1),
  sha256: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const artifactSchema = artifactRefSchema.extend({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  summary: z.string().optional(),
  createdAt: isoDateStringSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

export const gateResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  gateType: gateTypeSchema,
  status: gateStatusSchema,
  outputPath: z.string().nullable().optional(),
  durationMs: z.number().int().min(0),
  retries: z.number().int().min(0),
  fixAttemptId: z.string().nullable().optional(),
  failureClassification: z.string().nullable().optional(),
  createdAt: isoDateStringSchema,
});
export type GateResult = z.infer<typeof gateResultSchema>;

export const humanDecisionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  gateResultId: z.string().nullable().optional(),
  status: z.enum(['pending', 'approved', 'rejected']),
  actor: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  createdAt: isoDateStringSchema,
  decidedAt: isoDateStringSchema.nullable().optional(),
});
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

export const deliveryPullRequestStatusSchema = z.enum([
  'prepared',
  'awaiting-approval',
  'branch-pushed',
  'creating-pr',
  'created',
  'failed',
]);
export type DeliveryPullRequestStatus = z.infer<
  typeof deliveryPullRequestStatusSchema
>;

export const deliveryPullRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  title: z.string().min(1),
  bodyPath: z.string().nullable().optional(),
  remoteName: z.string().nullable().optional(),
  remoteUrl: z.string().nullable().optional(),
  status: deliveryPullRequestStatusSchema,
  prUrl: z.string().url().nullable().optional(),
  approvedBy: z.string().nullable().optional(),
  approvedAt: isoDateStringSchema.nullable().optional(),
  branchPushedAt: isoDateStringSchema.nullable().optional(),
  prCreatedAt: isoDateStringSchema.nullable().optional(),
  failureStage: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  attemptCount: z.number().int().min(0),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type DeliveryPullRequest = z.infer<typeof deliveryPullRequestSchema>;

export const runProviderConfigSchema = z.object({
  runId: z.string().min(1),
  provider: z.enum(['mock', 'claude-code', 'custom']),
  configSummary: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateStringSchema,
});
export type RunProviderConfig = z.infer<typeof runProviderConfigSchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string().min(1),
  createdAt: isoDateStringSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const runSummarySchema = z.object({
  runId: z.string().min(1),
  status: workflowStatusSchema,
  artifacts: z.array(artifactRefSchema),
  gates: z.array(gateResultSchema),
  auditHead: z.string().nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
