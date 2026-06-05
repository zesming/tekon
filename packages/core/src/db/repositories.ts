import {
  type AuditEvent,
  auditEventSchema,
  type Artifact,
  type ArtifactType,
  artifactSchema,
  type Demand,
  demandSchema,
  type GateResult,
  gateResultSchema,
  type HumanDecision,
  humanDecisionSchema,
  type Node,
  nodeSchema,
  type NodeStatus,
  type Project,
  projectSchema,
  type RoleRun,
  roleRunSchema,
  type WorkflowInstance,
  workflowInstanceSchema,
} from '../types/domain.js';
import {
  type WorktreeLease,
  worktreeLeaseSchema,
} from '../types/config.js';
import type { DonkeyDatabase } from './connection.js';
import { createWriteQueue, type WriteQueue } from './write-queue.js';

type NodeRow = {
  id: string;
  run_id: string;
  phase_id: string | null;
  role: Node['role'];
  status: Node['status'];
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
  status: GateResult['status'];
  output_path: string | null;
  duration_ms: number;
  retries: number;
  fix_attempt_id: string | null;
  failure_classification: string | null;
  created_at: string;
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
  created_at: string;
  released_at: string | null;
};

export interface RecoverableRun {
  runId: string;
  nodeId: string;
  role: Node['role'];
  interruptedRoleRunId: string | null;
}

export interface DonkeyRepositories {
  createDemand(demand: Demand): Promise<Demand>;
  createProject(project: Project): Promise<Project>;
  createWorkflowInstance(instance: WorkflowInstance): Promise<WorkflowInstance>;
  createNode(node: Node): Promise<Node>;
  getNode(nodeId: string): Promise<Node | null>;
  transitionNode(nodeId: string, status: NodeStatus): Promise<void>;
  recordGateResult(gateResult: GateResult): Promise<GateResult>;
  listGateResults(runId: string): Promise<GateResult[]>;
  appendAuditEvent(event: AuditEvent): Promise<AuditEvent>;
  listAuditEvents(runId: string): Promise<AuditEvent[]>;
  recordArtifact(artifact: Artifact): Promise<Artifact>;
  listArtifacts(runId: string, nodeId?: string, type?: ArtifactType): Promise<Artifact[]>;
  createHumanDecision(decision: HumanDecision): Promise<HumanDecision>;
  updateHumanDecision(
    decisionId: string,
    patch: Pick<HumanDecision, 'status' | 'actor' | 'note' | 'decidedAt'>,
  ): Promise<HumanDecision | null>;
  getHumanDecision(decisionId: string): Promise<HumanDecision | null>;
  listHumanDecisions(runId: string): Promise<HumanDecision[]>;
  recordWorktreeLease(lease: WorktreeLease): Promise<WorktreeLease>;
  releaseWorktreeLease(leaseId: string, releasedAt: string): Promise<WorktreeLease | null>;
  getWorktreeLease(leaseId: string): Promise<WorktreeLease | null>;
  listWorktreeLeases(runId: string): Promise<WorktreeLease[]>;
  createRoleRun(roleRun: RoleRun): Promise<RoleRun>;
  getRoleRun(roleRunId: string): Promise<RoleRun | null>;
  findRecoverableRun(runId?: string): Promise<RecoverableRun | null>;
}

export function createRepositories(
  db: DonkeyDatabase,
  writeQueue: WriteQueue = createWriteQueue(),
): DonkeyRepositories {
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

    async createNode(input) {
      const node = nodeSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into nodes (
             id, run_id, phase_id, role, status, gates, dependencies, created_at, updated_at
           ) values (
             @id, @runId, @phaseId, @role, @status, @gates, @dependencies, @createdAt, @updatedAt
           )`,
        ).run({
          ...node,
          phaseId: node.phaseId ?? null,
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

    async transitionNode(nodeId, status) {
      return writeQueue.enqueue(() => {
        db.prepare('update nodes set status = ?, updated_at = ? where id = ?').run(
          status,
          now(),
          nodeId,
        );
      });
    },

    async recordGateResult(input) {
      const gateResult = gateResultSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into gate_results (
             id, run_id, node_id, gate_type, status, output_path, duration_ms, retries,
             fix_attempt_id, failure_classification, created_at
           ) values (
             @id, @runId, @nodeId, @gateType, @status, @outputPath, @durationMs, @retries,
             @fixAttemptId, @failureClassification, @createdAt
           )`,
        ).run({
          ...gateResult,
          outputPath: gateResult.outputPath ?? null,
          fixAttemptId: gateResult.fixAttemptId ?? null,
          failureClassification: gateResult.failureClassification ?? null,
        });
        return gateResult;
      });
    },

    async listGateResults(runId) {
      return (
        db
          .prepare('select * from gate_results where run_id = ? order by created_at, id')
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
          .prepare('select * from audit_events where run_id = ? order by created_at, id')
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
        .all(runId, nodeId ?? null, nodeId ?? null, type ?? null, type ?? null) as ArtifactRow[];
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
        const row = db.prepare('select * from human_decisions where id = ?').get(decisionId) as
          | HumanDecisionRow
          | undefined;
        return row ? mapHumanDecision(row) : null;
      });
    },

    async getHumanDecision(decisionId) {
      const row = db.prepare('select * from human_decisions where id = ?').get(decisionId) as
        | HumanDecisionRow
        | undefined;
      return row ? mapHumanDecision(row) : null;
    },

    async listHumanDecisions(runId) {
      const rows = db
        .prepare('select * from human_decisions where run_id = ? order by created_at, id')
        .all(runId) as HumanDecisionRow[];
      return rows.map(mapHumanDecision);
    },

    async recordWorktreeLease(input) {
      const lease = worktreeLeaseSchema.parse(input);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into worktree_leases (
             id, run_id, node_id, role, repo_path, worktree_path, branch_name, created_at, released_at
           ) values (
             @id, @runId, @nodeId, @role, @repoPath, @worktreePath, @branchName, @createdAt, @releasedAt
           )`,
        ).run({ ...lease, releasedAt: lease.releasedAt ?? null });
        return lease;
      });
    },

    async releaseWorktreeLease(leaseId, releasedAt) {
      return writeQueue.enqueue(() => {
        db.prepare('update worktree_leases set released_at = ? where id = ?').run(
          releasedAt,
          leaseId,
        );
        const row = db.prepare('select * from worktree_leases where id = ?').get(leaseId) as
          | WorktreeLeaseRow
          | undefined;
        return row ? mapWorktreeLease(row) : null;
      });
    },

    async getWorktreeLease(leaseId) {
      const row = db.prepare('select * from worktree_leases where id = ?').get(leaseId) as
        | WorktreeLeaseRow
        | undefined;
      return row ? mapWorktreeLease(row) : null;
    },

    async listWorktreeLeases(runId) {
      const rows = db
        .prepare('select * from worktree_leases where run_id = ? order by created_at, id')
        .all(runId) as WorktreeLeaseRow[];
      return rows.map(mapWorktreeLease);
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
      const row = db.prepare('select * from role_runs where id = ?').get(roleRunId) as
        | RoleRunRow
        | undefined;
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
          | { node_id: string; run_id: string; role: Node['role']; role_run_id: string | null }
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
    gates: JSON.parse(row.gates) as unknown,
    dependencies: JSON.parse(row.dependencies) as unknown,
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
