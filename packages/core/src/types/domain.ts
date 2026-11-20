import { z } from 'zod';

export const isoDateStringSchema = z.string().datetime();

// PD-06：角色与产物类型开放命名（kebab-case 标识符）。内置枚举保留为常量，
// 供内置 payload/评审映射维持穷尽性检查；schema 本身不再拒绝自定义名字。
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/u;
export const identifierSchema = z
  .string()
  .min(1)
  .regex(
    IDENTIFIER_PATTERN,
    'identifier must be a kebab-case token: lowercase letters, digits and hyphens, starting with a letter',
  );

export const BUILT_IN_ROLE_IDS = [
  'pm',
  'rd',
  'qa',
  'reviewer',
  'pmo',
  'goal',
] as const;
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

export const GENERAL_ROLE_IDS = [
  'explorer',
  'designer',
  'reviewer',
  'coder',
  'orchestrator',
] as const;
export type GeneralRoleId = (typeof GENERAL_ROLE_IDS)[number];

export const nodeContextModeSchema = z.enum([
  'auto',
  'full',
  'isolated',
  'reuse',
]);
export type NodeContextMode = z.infer<typeof nodeContextModeSchema>;

export const workflowPauseReasonSchema = z.enum([
  'user_pause',
  'confirm_checkpoint',
  'blueprint_review',
]);
export type WorkflowPauseReason = z.infer<typeof workflowPauseReasonSchema>;

export const blueprintStatusSchema = z.enum([
  'planning',
  'review',
  'locked',
  'failed',
]);
export type BlueprintStatus = z.infer<typeof blueprintStatusSchema>;

export const roleSchema = identifierSchema;
export type Role = z.infer<typeof roleSchema>;

// CD-09：节点工作区三态。worktree=隔离工作树（历史默认）；in-place=直接在
// 仓库工作区执行（支持非 git 目录）；none=禁止改源码。
export const nodeWorkspaceSchema = z.enum(['worktree', 'in-place', 'none']);
export type NodeWorkspace = z.infer<typeof nodeWorkspaceSchema>;

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

export const BUILT_IN_ARTIFACT_TYPES = [
  'ac-evidence',
  'demand-card',
  'demand-review',
  'prd',
  'tech-design',
  'implementation-plan',
  'requirement-interface-review',
  'technical-review',
  'code-changes',
  'code-review',
  'test-plan',
  'test-plan-review',
  'test-report',
  'qa-release-signoff',
  'qa-release-signoff-review',
  'review-report',
  'security-report',
  'rollback-plan',
  'process-checkpoint',
  'delivery-package',
  'ci-status',
] as const;
export type BuiltInArtifactType = (typeof BUILT_IN_ARTIFACT_TYPES)[number];

// 交付侧自产、agent 不得在产物清单里声明的保留类型。开放命名后用显式拒绝
// 取代旧封闭枚举的意外保护，防止 provider 伪造交付事实。
export const RESERVED_ARTIFACT_TYPES = ['ci-status'] as const;
export type ReservedArtifactType = (typeof RESERVED_ARTIFACT_TYPES)[number];

// 开放字符串：自定义产物类型（如 essay、weekly-report）与内置类型同等可声明，
// 专用 payload 校验只对已注册的内置类型生效，其余回落通用 Markdown 校验。
export const artifactTypeSchema = identifierSchema;
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// agent 产物清单专用：开放命名但拒绝交付保留类型。
export const agentArtifactTypeSchema = identifierSchema.refine(
  (type) =>
    !(RESERVED_ARTIFACT_TYPES as readonly string[]).includes(type),
  {
    message:
      'this artifact type is reserved for Tekon delivery and cannot be produced by agents',
  },
);

export const gateTypeSchema = z.enum([
  'ac-evidence',
  'build',
  'test',
  'lint',
  'e2e-pass',
  'schema',
  'independent-review',
  'role-scope',
  'qa-signoff',
  'process-completeness',
  'security-scan',
  'human',
]);
export type GateType = z.infer<typeof gateTypeSchema>;

// PD-21：门禁类型的类别元组下沉到本叶子模块（仅依赖 zod），供 delivery 声明
// schema 与 readiness 共用；gate/registry.ts 从此 re-export，避免 template 经
// registry→runners→execution-plan 形成 ESM 循环依赖。顺序即命令/治理门禁集合。
export const COMMAND_GATE_TYPES = [
  'build',
  'test',
  'lint',
  'e2e-pass',
] as const satisfies readonly GateType[];

export const GOVERNANCE_GATE_TYPES = [
  'independent-review',
  'role-scope',
  'ac-evidence',
  'qa-signoff',
  'process-completeness',
] as const satisfies readonly GateType[];

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
  match: z.enum(['prefix', 'exact']).optional(),
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
  gateKey: z.string().min(1).optional(),
  command: commandInvocationSchema.optional(),
  commandRef: z
    .enum(['build', 'typecheck', 'lint', 'test', 'e2e', 'security'])
    .optional(),
  skipReason: z.string().min(1).optional(),
  artifactType: artifactTypeSchema.optional(),
  requiresHumanApproval: z.boolean().default(false),
  // PD-18：人工驳回返工目标，随节点 gates JSON 持久化，缺省视为不支持驳回返工。
  reworkTargetNodeId: z.string().min(1).optional(),
  maxRetries: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().positive().optional(),
  // Persisted so planFromRepository faithfully reconstructs the gate: the
  // gate-runner reads autoFix + onExhausted to drive the auto-fix/repair and
  // exhaustion paths. Without these the reconstructed plan silently loses the
  // repair behavior (rd/qa in-memory plan had them; a resumed/prepared run
  // did not). retryPolicy is kept for fidelity (schema-loose passthrough).
  autoFix: z.boolean().optional(),
  onExhausted: z.enum(['block', 'pause', 'fail']).optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).optional(),
      maxRetries: z.number().int().min(0).max(9).optional(),
      backoffMs: z.number().int().min(0).optional(),
      strategy: z.enum(['fixed', 'exponential']).optional(),
      onExhausted: z.enum(['block', 'pause', 'fail']).optional(),
    })
    .passthrough()
    .optional(),
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
  // PD-06：节点级提示词，模板声明后随计划落库并注入 agent 提示词。
  prompt: z.string().min(1).optional(),
  // CD-09：工作区隔离模式，旧调用方/旧行默认 worktree，行为零变化。
  workspace: nodeWorkspaceSchema.default('worktree'),
  inputs: z.array(nodeArtifactInputRefSchema).default([]),
  outputs: z.array(nodeArtifactOutputRefSchema).default([]),
  gates: z.array(gateConfigSchema).default([]),
  dependencies: z.array(z.string()).default([]),
  // Intra-phase execution order (persisted). Defaults to 0 so legacy rows
  // and callers that omit it stay stable (id tiebreaker in listNodes).
  order: z.number().int().min(0).default(0),
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
  // 4b: 'workflow' (a governed delivery workflow) | 'goal' (a lightweight
  // single-node agent goal). Default keeps every legacy/omitted row a workflow.
  kind: z.enum(['workflow', 'goal']).default('workflow'),
  // 4c: run-scoped "allow a dirty worktree as the base" policy. Persisted on
  // the run so the async job executor (and cross-process resume) can rebuild
  // the engine with the same lease policy the run was started with — the
  // executor builds a fresh engine from the provider snapshot and would
  // otherwise silently drop this flag. Default false keeps legacy rows strict.
  allowDirtyBase: z.boolean().default(false),
  planSnapshot: z.string().nullable().optional(),
  planDigest: z.string().nullable().optional(),
  currentNodeId: z.string().nullable().optional(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;
/**
 * Creation input: `kind` is optional (schema defaults it to 'workflow'), so
 * legacy callers/fixtures that omit it keep compiling and get a workflow run.
 */
export type WorkflowInstanceInput = z.input<typeof workflowInstanceSchema>;

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
  docKey: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  createdAt: isoDateStringSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

export const gateResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  gateType: gateTypeSchema,
  gateKey: z.string().min(1).nullable().optional(),
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
  /** 人工决策备注（approve/reject 时写入），作为驳回返工的反馈来源。 */
  note: z.string().nullable().optional(),
  /**
   * PD-18：门禁发起时的请求上下文（命令/风险等），与决策备注分离，决策
   * 覆盖 note 不再破坏审批摘要的请求信息。旧行该列为 null。
   */
  requestNote: z.string().nullable().optional(),
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
  provider: z.enum(['mock', 'claude-code', 'codex', 'dsh-headless', 'custom']),
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
