import {
  type AuditEvent,
  auditEventSchema,
  type Artifact,
  type ArtifactType,
  artifactSchema,
  type DeliveryPullRequest,
  deliveryPullRequestSchema,
  type Demand,
  demandSchema,
  type GateResult,
  type GateStatus,
  gateResultSchema,
  type HumanDecision,
  humanDecisionSchema,
  type Node,
  type NodeInput,
  nodeSchema,
  type NodeStatus,
  type Phase,
  phaseSchema,
  type Project,
  projectSchema,
  type RoleRun,
  roleRunSchema,
  type RunProviderConfig,
  runProviderConfigSchema,
  type WorkflowInstance,
  type WorkflowStatus,
  workflowInstanceSchema,
} from '../types/domain.js';
import { type WorktreeLease, worktreeLeaseSchema } from '../types/config.js';
import type { TekonDatabase } from './connection.js';
import { createWriteQueue, type WriteQueue } from './write-queue.js';

type NodeRow = {
  id: string;
  run_id: string;
  phase_id: string | null;
  role: Node['role'];
  status: Node['status'];
  inputs: string;
  outputs: string;
  gates: string;
  dependencies: string;
  created_at: string;
  updated_at: string;
};

type GateResultRow = {
  id: string;
  run_id: string;
  node_id: string;
  gate_type: GateResult['gateType'];
  gate_key: string | null;
  status: GateResult['status'];
  output_path: string | null;
  duration_ms: number;
  retries: number;
  fix_attempt_id: string | null;
  failure_classification: string | null;
  created_at: string;
};

type WorkflowInstanceRow = {
  id: string;
  project_id: string;
  demand_id: string;
  status: WorkflowInstance['status'];
  current_node_id: string | null;
  created_at: string;
  updated_at: string;
};

type PhaseRow = {
  id: string;
  run_id: string;
  name: string;
  status: Phase['status'];
  phase_order: number;
  created_at: string;
  updated_at: string;
};

type AuditEventRow = {
  id: string;
  run_id: string;
  type: string;
  payload: string;
  prev_hash: string | null;
  hash: string;
  created_at: string;
};

type RoleRunRow = {
  id: string;
  run_id: string;
  node_id: string;
  role: RoleRun['role'];
  status: RoleRun['status'];
  started_at: string;
  completed_at: string | null;
  interrupted_at: string | null;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  node_id: string;
  type: Artifact['type'];
  version: number;
  path: string;
  sha256: string;
  size_bytes: number;
  summary: string | null;
  created_at: string;
};

type HumanDecisionRow = {
  id: string;
  run_id: string;
  node_id: string;
  gate_result_id: string | null;
  status: HumanDecision['status'];
  actor: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
};

type WorktreeLeaseRow = {
  id: string;
  run_id: string;
  node_id: string;
  role: WorktreeLease['role'];
  repo_path: string;
  worktree_path: string;
  branch_name: string;
  base_head: string | null;
  created_at: string;
  released_at: string | null;
};

type DeliveryPullRequestRow = {
  id: string;
  run_id: string;
  branch: string;
  base_branch: string;
  title: string;
  body_path: string | null;
  remote_name: string | null;
  remote_url: string | null;
  status: DeliveryPullRequest['status'];
  pr_url: string | null;
  approved_by: string | null;
  approved_at: string | null;
  branch_pushed_at: string | null;
  pr_created_at: string | null;
  failure_stage: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

type RunProviderConfigRow = {
  run_id: string;
  provider: RunProviderConfig['provider'];
  config_summary: string;
  created_at: string;
};

export interface RecoverableRun {
  runId: string;
  nodeId: string;
  role: Node['role'];
  interruptedRoleRunId: string | null;
}

export interface TekonRepositories {
  createDemand(demand: Demand): Promise<Demand>;
  getDemand(demandId: string): Promise<Demand | null>;
  createProject(project: Project): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  createWorkflowInstance(instance: WorkflowInstance): Promise<WorkflowInstance>;
  getWorkflowInstance(runId: string): Promise<WorkflowInstance | null>;
  recordRunProviderConfig(
    config: RunProviderConfig,
  ): Promise<RunProviderConfig>;
  getRunProviderConfig(runId: string): Promise<RunProviderConfig | null>;
  updateWorkflowInstanceStatus(
    runId: string,
    status: WorkflowStatus,
    currentNodeId?: string | null,
  ): Promise<WorkflowInstance | null>;
  createPhase(phase: Phase): Promise<Phase>;
  listPhases(runId: string): Promise<Phase[]>;
  createNode(node: NodeInput): Promise<Node>;
  getNode(nodeId: string): Promise<Node | null>;
  listNodes(runId: string): Promise<Node[]>;
  transitionNode(nodeId: string, status: NodeStatus): Promise<void>;
  recordGateResult(gateResult: GateResult): Promise<GateResult>;
  updateGateResultStatus(
    gateResultId: string,
    patch: { status: GateStatus; failureClassification?: string | null },
  ): Promise<GateResult | null>;
  listGateResults(runId: string): Promise<GateResult[]>;
  appendAuditEvent(event: AuditEvent): Promise<AuditEvent>;
  listAuditEvents(runId: string): Promise<AuditEvent[]>;
  recordArtifact(artifact: Artifact): Promise<Artifact>;
  listArtifacts(
    runId: string,
    nodeId?: string,
    type?: ArtifactType,
  ): Promise<Artifact[]>;
  createHumanDecision(decision: HumanDecision): Promise<HumanDecision>;
  updateHumanDecision(
    decisionId: string,
    patch: Pick<HumanDecision, 'status' | 'actor' | 'note' | 'decidedAt'>,
  ): Promise<HumanDecision | null>;
  getHumanDecision(decisionId: string): Promise<HumanDecision | null>;
  listHumanDecisions(runId: string): Promise<HumanDecision[]>;
  recordWorktreeLease(lease: WorktreeLease): Promise<WorktreeLease>;
  releaseWorktreeLease(
    leaseId: string,
    releasedAt: string,
  ): Promise<WorktreeLease | null>;
  getWorktreeLease(leaseId: string): Promise<WorktreeLease | null>;
  listWorktreeLeases(runId: string): Promise<WorktreeLease[]>;
  upsertDeliveryPullRequest(
    delivery: DeliveryPullRequest,
  ): Promise<DeliveryPullRequest>;
  getDeliveryPullRequest(runId: string): Promise<DeliveryPullRequest | null>;
  markDeliveryPullRequestCreated(input: {
    runId: string;
    prUrl: string;
    remoteName?: string | null;
    remoteUrl?: string | null;
    createdAt: string;
  }): Promise<DeliveryPullRequest | null>;
  markDeliveryPullRequestFailed(input: {
    runId: string;
    failureStage: string;
    lastError: string;
    failedAt: string;
  }): Promise<DeliveryPullRequest | null>;
  createRoleRun(roleRun: RoleRun): Promise<RoleRun>;
  getRoleRun(roleRunId: string): Promise<RoleRun | null>;
  markRoleRunCompleted(input: {
    roleRunId: string;
    completedAt: string;
  }): Promise<RoleRun | null>;
  getLatestRoleRunForNode(
    runId: string,
    nodeId: string,
  ): Promise<RoleRun | null>;
  findRecoverableRun(runId?: string): Promise<RecoverableRun | null>;
}

export function createRepositories(
  db: TekonDatabase,
  writeQueue: WriteQueue = createWriteQueue(),
): TekonRepositories {
  const now = () => new Date().toISOString();

  return {
    async createDemand(input) {
      const demand = demandSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into demands (id, title, body, source, created_at)
           values (@id, @title, @body, @source, @createdAt)`,
        ).run({ ...demand, source: demand.source ?? null });
        return demand;
      });
    },

    async getDemand(demandId) {
      const row = db
        .prepare('select * from demands where id = ?')
        .get(demandId) as
        | {
            id: string;
            title: string;
            body: string;
            source: string | null;
            created_at: string;
          }
        | undefined;
      return row
        ? demandSchema.parse({
            id: row.id,
            title: row.title,
            body: row.body,
            source: row.source ?? undefined,
            createdAt: row.created_at,
          })
        : null;
    },

    async createProject(input) {
      const project = projectSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into projects (id, name, repo_path, created_at)
           values (@id, @name, @repoPath, @createdAt)`,
        ).run(project);
        return project;
      });
    },

    async getProject(projectId) {
      const row = db
        .prepare('select * from projects where id = ?')
        .get(projectId) as
        | {
            id: string;
            name: string;
            repo_path: string;
            created_at: string;
          }
        | undefined;
      return row
        ? projectSchema.parse({
            id: row.id,
            name: row.name,
            repoPath: row.repo_path,
            createdAt: row.created_at,
          })
        : null;
    },

    async createWorkflowInstance(input) {
      const instance = workflowInstanceSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into workflow_instances (
             id, project_id, demand_id, status, current_node_id, created_at, updated_at
           ) values (@id, @projectId, @demandId, @status, @currentNodeId, @createdAt, @updatedAt)`,
        ).run({ ...instance, currentNodeId: instance.currentNodeId ?? null });
        return instance;
      });
    },

    async getWorkflowInstance(runId) {
      const row = db
        .prepare('select * from workflow_instances where id = ?')
        .get(runId) as WorkflowInstanceRow | undefined;
      return row ? mapWorkflowInstance(row) : null;
    },

    async recordRunProviderConfig(input) {
      const config = runProviderConfigSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into run_provider_configs (
             run_id, provider, config_summary, created_at
           ) values (
             @runId, @provider, @configSummary, @createdAt
           )
           on conflict(run_id) do update set
             provider = excluded.provider,
             config_summary = excluded.config_summary,
             created_at = excluded.created_at`,
        ).run(toRunProviderConfigParams(config));
        return config;
      });
    },

    async getRunProviderConfig(runId) {
      const row = db
        .prepare('select * from run_provider_configs where run_id = ?')
        .get(runId) as RunProviderConfigRow | undefined;
      return row ? mapRunProviderConfig(row) : null;
    },

    async updateWorkflowInstanceStatus(runId, status, currentNodeId) {
      return writeQueue.enqueue(() => {
        if (currentNodeId === undefined) {
          db.prepare(
            'update workflow_instances set status = ?, updated_at = ? where id = ?',
          ).run(status, now(), runId);
        } else {
          db.prepare(
            `update workflow_instances
             set status = ?, current_node_id = ?, updated_at = ?
             where id = ?`,
          ).run(status, currentNodeId, now(), runId);
        }

        const row = db
          .prepare('select * from workflow_instances where id = ?')
          .get(runId) as WorkflowInstanceRow | undefined;
        return row ? mapWorkflowInstance(row) : null;
      });
    },

    async createPhase(input) {
      const phase = phaseSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into phases (
             id, run_id, name, status, phase_order, created_at, updated_at
           ) values (
             @id, @runId, @name, @status, @order, @createdAt, @updatedAt
           )`,
        ).run(phase);
        return phase;
      });
    },

    async listPhases(runId) {
      return (
        db
          .prepare(
            'select * from phases where run_id = ? order by phase_order, id',
          )
          .all(runId) as PhaseRow[]
      ).map(mapPhase);
    },

    async createNode(input) {
      const node = nodeSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into nodes (
             id, run_id, phase_id, role, status, inputs, outputs, gates, dependencies, created_at, updated_at
           ) values (
             @id, @runId, @phaseId, @role, @status, @inputs, @outputs, @gates, @dependencies, @createdAt, @updatedAt
           )`,
        ).run({
          ...node,
          phaseId: node.phaseId ?? null,
          inputs: JSON.stringify(node.inputs),
          outputs: JSON.stringify(node.outputs),
          gates: JSON.stringify(node.gates),
          dependencies: JSON.stringify(node.dependencies),
        });
        return node;
      });
    },

    async getNode(nodeId) {
      const row = db.prepare('select * from nodes where id = ?').get(nodeId) as
        | NodeRow
        | undefined;
      return row ? mapNode(row) : null;
    },

    async listNodes(runId) {
      const rows = db
        .prepare(
          `select n.*
           from nodes n
           left join phases p on p.id = n.phase_id
           where n.run_id = ?
           order by coalesce(p.phase_order, 999999), n.created_at, n.id`,
        )
        .all(runId) as NodeRow[];
      return rows.map(mapNode);
    },

    async transitionNode(nodeId, status) {
      return writeQueue.enqueue(() => {
        db.prepare(
          'update nodes set status = ?, updated_at = ? where id = ?',
        ).run(status, now(), nodeId);
      });
    },

    async recordGateResult(input) {
      const gateResult = gateResultSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into gate_results (
             id, run_id, node_id, gate_type, gate_key, status, output_path, duration_ms, retries,
             fix_attempt_id, failure_classification, created_at
           ) values (
             @id, @runId, @nodeId, @gateType, @gateKey, @status, @outputPath, @durationMs, @retries,
             @fixAttemptId, @failureClassification, @createdAt
           )`,
        ).run({
          ...gateResult,
          gateKey: gateResult.gateKey ?? null,
          outputPath: gateResult.outputPath ?? null,
          fixAttemptId: gateResult.fixAttemptId ?? null,
          failureClassification: gateResult.failureClassification ?? null,
        });
        return gateResult;
      });
    },

    async updateGateResultStatus(gateResultId, patch) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `update gate_results
           set status = ?,
               failure_classification = ?
           where id = ?`,
        ).run(patch.status, patch.failureClassification ?? null, gateResultId);
        const row = db
          .prepare('select * from gate_results where id = ?')
          .get(gateResultId) as GateResultRow | undefined;
        return row ? mapGateResult(row) : null;
      });
    },

    async listGateResults(runId) {
      return (
        db
          .prepare(
            'select * from gate_results where run_id = ? order by created_at, id',
          )
          .all(runId) as GateResultRow[]
      ).map(mapGateResult);
    },

    async appendAuditEvent(input) {
      const event = auditEventSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into audit_events (id, run_id, type, payload, prev_hash, hash, created_at)
           values (@id, @runId, @type, @payload, @prevHash, @hash, @createdAt)`,
        ).run({
          ...event,
          payload: JSON.stringify(event.payload),
          prevHash: event.prevHash ?? null,
        });
        return event;
      });
    },

    async listAuditEvents(runId) {
      return (
        db
          .prepare(
            'select * from audit_events where run_id = ? order by created_at, id',
          )
          .all(runId) as AuditEventRow[]
      ).map(mapAuditEvent);
    },

    async recordArtifact(input) {
      const artifact = artifactSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into artifacts (
             id, run_id, node_id, type, version, path, sha256, size_bytes, summary, created_at
           ) values (
             @id, @runId, @nodeId, @type, @version, @path, @sha256, @sizeBytes, @summary, @createdAt
           )`,
        ).run({ ...artifact, summary: artifact.summary ?? null });
        return artifact;
      });
    },

    async listArtifacts(runId, nodeId, type) {
      const rows = db
        .prepare(
          `select * from artifacts
           where run_id = ?
             and (? is null or node_id = ?)
             and (? is null or type = ?)
           order by node_id, type, version`,
        )
        .all(
          runId,
          nodeId ?? null,
          nodeId ?? null,
          type ?? null,
          type ?? null,
        ) as ArtifactRow[];
      return rows.map(mapArtifact);
    },

    async createHumanDecision(input) {
      const decision = humanDecisionSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into human_decisions (
             id, run_id, node_id, gate_result_id, status, actor, note, created_at, decided_at
           ) values (
             @id, @runId, @nodeId, @gateResultId, @status, @actor, @note, @createdAt, @decidedAt
           )`,
        ).run({
          ...decision,
          gateResultId: decision.gateResultId ?? null,
          actor: decision.actor ?? null,
          note: decision.note ?? null,
          decidedAt: decision.decidedAt ?? null,
        });
        return decision;
      });
    },

    async updateHumanDecision(decisionId, patch) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `update human_decisions
           set status = @status, actor = @actor, note = @note, decided_at = @decidedAt
           where id = @decisionId`,
        ).run({
          decisionId,
          status: patch.status,
          actor: patch.actor ?? null,
          note: patch.note ?? null,
          decidedAt: patch.decidedAt ?? null,
        });
        const row = db
          .prepare('select * from human_decisions where id = ?')
          .get(decisionId) as HumanDecisionRow | undefined;
        return row ? mapHumanDecision(row) : null;
      });
    },

    async getHumanDecision(decisionId) {
      const row = db
        .prepare('select * from human_decisions where id = ?')
        .get(decisionId) as HumanDecisionRow | undefined;
      return row ? mapHumanDecision(row) : null;
    },

    async listHumanDecisions(runId) {
      const rows = db
        .prepare(
          'select * from human_decisions where run_id = ? order by created_at, id',
        )
        .all(runId) as HumanDecisionRow[];
      return rows.map(mapHumanDecision);
    },

    async recordWorktreeLease(input) {
      const lease = worktreeLeaseSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into worktree_leases (
             id, run_id, node_id, role, repo_path, worktree_path, branch_name, base_head, created_at, released_at
           ) values (
             @id, @runId, @nodeId, @role, @repoPath, @worktreePath, @branchName, @baseHead, @createdAt, @releasedAt
           )`,
        ).run({
          ...lease,
          baseHead: lease.baseHead ?? null,
          releasedAt: lease.releasedAt ?? null,
        });
        return lease;
      });
    },

    async releaseWorktreeLease(leaseId, releasedAt) {
      return writeQueue.enqueue(() => {
        db.prepare(
          'update worktree_leases set released_at = ? where id = ?',
        ).run(releasedAt, leaseId);
        const row = db
          .prepare('select * from worktree_leases where id = ?')
          .get(leaseId) as WorktreeLeaseRow | undefined;
        return row ? mapWorktreeLease(row) : null;
      });
    },

    async getWorktreeLease(leaseId) {
      const row = db
        .prepare('select * from worktree_leases where id = ?')
        .get(leaseId) as WorktreeLeaseRow | undefined;
      return row ? mapWorktreeLease(row) : null;
    },

    async listWorktreeLeases(runId) {
      const rows = db
        .prepare(
          'select * from worktree_leases where run_id = ? order by created_at, id',
        )
        .all(runId) as WorktreeLeaseRow[];
      return rows.map(mapWorktreeLease);
    },

    async upsertDeliveryPullRequest(input) {
      const delivery = deliveryPullRequestSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into delivery_pull_requests (
             id, run_id, branch, base_branch, title, body_path, remote_name, remote_url,
             status, pr_url, approved_by, approved_at, branch_pushed_at, pr_created_at,
             failure_stage, last_error, attempt_count, created_at, updated_at
           ) values (
             @id, @runId, @branch, @baseBranch, @title, @bodyPath, @remoteName, @remoteUrl,
             @status, @prUrl, @approvedBy, @approvedAt, @branchPushedAt, @prCreatedAt,
             @failureStage, @lastError, @attemptCount, @createdAt, @updatedAt
           )
           on conflict(run_id) do update set
             branch = excluded.branch,
             base_branch = excluded.base_branch,
             title = excluded.title,
             body_path = excluded.body_path,
             remote_name = excluded.remote_name,
             remote_url = excluded.remote_url,
             status = excluded.status,
             pr_url = excluded.pr_url,
             approved_by = excluded.approved_by,
             approved_at = excluded.approved_at,
             branch_pushed_at = excluded.branch_pushed_at,
             pr_created_at = excluded.pr_created_at,
             failure_stage = excluded.failure_stage,
             last_error = excluded.last_error,
             attempt_count = excluded.attempt_count,
             updated_at = excluded.updated_at`,
        ).run(toDeliveryPullRequestParams(delivery));
        return delivery;
      });
    },

    async getDeliveryPullRequest(runId) {
      const row = db
        .prepare('select * from delivery_pull_requests where run_id = ?')
        .get(runId) as DeliveryPullRequestRow | undefined;
      return row ? mapDeliveryPullRequest(row) : null;
    },

    async markDeliveryPullRequestCreated(input) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `update delivery_pull_requests
           set status = 'created',
               pr_url = ?,
               remote_name = coalesce(?, remote_name),
               remote_url = coalesce(?, remote_url),
               pr_created_at = ?,
               failure_stage = null,
               last_error = null,
               updated_at = ?
           where run_id = ?`,
        ).run(
          input.prUrl,
          input.remoteName ?? null,
          input.remoteUrl ?? null,
          input.createdAt,
          input.createdAt,
          input.runId,
        );
        const row = db
          .prepare('select * from delivery_pull_requests where run_id = ?')
          .get(input.runId) as DeliveryPullRequestRow | undefined;
        return row ? mapDeliveryPullRequest(row) : null;
      });
    },

    async markDeliveryPullRequestFailed(input) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `update delivery_pull_requests
           set status = 'failed',
               failure_stage = ?,
               last_error = ?,
               updated_at = ?
           where run_id = ?`,
        ).run(input.failureStage, input.lastError, input.failedAt, input.runId);
        const row = db
          .prepare('select * from delivery_pull_requests where run_id = ?')
          .get(input.runId) as DeliveryPullRequestRow | undefined;
        return row ? mapDeliveryPullRequest(row) : null;
      });
    },

    async createRoleRun(input) {
      const roleRun = roleRunSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into role_runs (
             id, run_id, node_id, role, status, started_at, completed_at, interrupted_at
           ) values (
             @id, @runId, @nodeId, @role, @status, @startedAt, @completedAt, @interruptedAt
           )`,
        ).run({
          ...roleRun,
          completedAt: roleRun.completedAt ?? null,
          interruptedAt: roleRun.interruptedAt ?? null,
        });
        return roleRun;
      });
    },

    async getRoleRun(roleRunId) {
      const row = db
        .prepare('select * from role_runs where id = ?')
        .get(roleRunId) as RoleRunRow | undefined;
      return row ? mapRoleRun(row) : null;
    },

    async markRoleRunCompleted(input) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `update role_runs
           set status = 'passed', completed_at = ?
           where id = ?`,
        ).run(input.completedAt, input.roleRunId);
        const row = db
          .prepare('select * from role_runs where id = ?')
          .get(input.roleRunId) as RoleRunRow | undefined;
        return row ? mapRoleRun(row) : null;
      });
    },

    async getLatestRoleRunForNode(runId, nodeId) {
      const row = db
        .prepare(
          `select * from role_runs
           where run_id = ? and node_id = ?
           order by started_at desc, id desc
           limit 1`,
        )
        .get(runId, nodeId) as RoleRunRow | undefined;
      return row ? mapRoleRun(row) : null;
    },

    async findRecoverableRun(runId) {
      return writeQueue.enqueue(() => {
        const recovery = db
          .prepare(
            `select n.id as node_id, n.run_id, n.role, rr.id as role_run_id
             from nodes n
             join workflow_instances wi on wi.id = n.run_id
             left join role_runs rr on rr.node_id = n.id and rr.status = 'running'
             where n.status = 'running'
               and wi.status in ('running', 'paused')
               and (? is null or n.run_id = ?)
             order by n.updated_at desc
             limit 1`,
          )
          .get(runId ?? null, runId ?? null) as
          | {
              node_id: string;
              run_id: string;
              role: Node['role'];
              role_run_id: string | null;
            }
          | undefined;

        if (!recovery) {
          return null;
        }

        if (recovery.role_run_id) {
          db.prepare(
            `update role_runs
             set status = 'interrupted', interrupted_at = ?
             where id = ? and status = 'running'`,
          ).run(now(), recovery.role_run_id);
        }

        return {
          runId: recovery.run_id,
          nodeId: recovery.node_id,
          role: recovery.role,
          interruptedRoleRunId: recovery.role_run_id,
        };
      });
    },
  };
}

function mapNode(row: NodeRow): Node {
  return nodeSchema.parse({
    id: row.id,
    runId: row.run_id,
    phaseId: row.phase_id ?? undefined,
    role: row.role,
    status: row.status,
    inputs: JSON.parse(row.inputs) as unknown,
    outputs: JSON.parse(row.outputs) as unknown,
    gates: JSON.parse(row.gates) as unknown,
    dependencies: JSON.parse(row.dependencies) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapWorkflowInstance(row: WorkflowInstanceRow): WorkflowInstance {
  return workflowInstanceSchema.parse({
    id: row.id,
    projectId: row.project_id,
    demandId: row.demand_id,
    status: row.status,
    currentNodeId: row.current_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapPhase(row: PhaseRow): Phase {
  return phaseSchema.parse({
    id: row.id,
    runId: row.run_id,
    name: row.name,
    status: row.status,
    order: row.phase_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapGateResult(row: GateResultRow): GateResult {
  return gateResultSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    gateType: row.gate_type,
    gateKey: row.gate_key,
    status: row.status,
    outputPath: row.output_path,
    durationMs: row.duration_ms,
    retries: row.retries,
    fixAttemptId: row.fix_attempt_id,
    failureClassification: row.failure_classification,
    createdAt: row.created_at,
  });
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return auditEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
  });
}

function mapArtifact(row: ArtifactRow): Artifact {
  return artifactSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    type: row.type,
    version: row.version,
    path: row.path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
  });
}

function mapHumanDecision(row: HumanDecisionRow): HumanDecision {
  return humanDecisionSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    gateResultId: row.gate_result_id,
    status: row.status,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  });
}

function mapWorktreeLease(row: WorktreeLeaseRow): WorktreeLease {
  return worktreeLeaseSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    role: row.role,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseHead: row.base_head,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  });
}

function mapRoleRun(row: RoleRunRow): RoleRun {
  return roleRunSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    role: row.role,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    interruptedAt: row.interrupted_at,
  });
}

function mapDeliveryPullRequest(
  row: DeliveryPullRequestRow,
): DeliveryPullRequest {
  return deliveryPullRequestSchema.parse({
    id: row.id,
    runId: row.run_id,
    branch: row.branch,
    baseBranch: row.base_branch,
    title: row.title,
    bodyPath: row.body_path,
    remoteName: row.remote_name,
    remoteUrl: row.remote_url,
    status: row.status,
    prUrl: row.pr_url,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    branchPushedAt: row.branch_pushed_at,
    prCreatedAt: row.pr_created_at,
    failureStage: row.failure_stage,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapRunProviderConfig(row: RunProviderConfigRow): RunProviderConfig {
  return runProviderConfigSchema.parse({
    runId: row.run_id,
    provider: row.provider,
    configSummary: JSON.parse(row.config_summary) as Record<string, unknown>,
    createdAt: row.created_at,
  });
}

function toRunProviderConfigParams(config: RunProviderConfig) {
  return {
    runId: config.runId,
    provider: config.provider,
    configSummary: JSON.stringify(config.configSummary),
    createdAt: config.createdAt,
  };
}

function toDeliveryPullRequestParams(delivery: DeliveryPullRequest) {
  return {
    ...delivery,
    bodyPath: delivery.bodyPath ?? null,
    remoteName: delivery.remoteName ?? null,
    remoteUrl: delivery.remoteUrl ?? null,
    prUrl: delivery.prUrl ?? null,
    approvedBy: delivery.approvedBy ?? null,
    approvedAt: delivery.approvedAt ?? null,
    branchPushedAt: delivery.branchPushedAt ?? null,
    prCreatedAt: delivery.prCreatedAt ?? null,
    failureStage: delivery.failureStage ?? null,
    lastError: delivery.lastError ?? null,
  };
}
