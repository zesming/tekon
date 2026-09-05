import { createHash } from 'node:crypto';
import type { GateConfig, Node, Phase, GateResult, Role, AuditEvent } from '../types/domain.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AdmissionStore } from '../db/admission-store.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  type WorkflowGateConfig,
  type WorkflowTemplate,
  type WorkflowTemplateNode,
  type WorkflowTemplatePhase,
  normalizeExecutableTemplate,
} from './template.js';
import {
  type ExecutableNode,
  type ExecutionPlan,
  gatesWithStableKeys,
  scopedId,
  resolveMaxReworkAttempts,
} from './workflow-runtime.js';
import {
  canonicalJson,
  computeLegacyV1RunPlanDigest,
  projectRunPlanV3,
  validateRunPlanV2,
  validateRunPlanV3,
  type RunPlan,
  type RunPlanV3,
} from './run-plan.js';
import { materializeBoundGate, normalizeRepoCommands, type BoundRepoCommand } from './repo-command-binding.js';

/**
 * Convert a workflow template into an executable plan by scoping all IDs
 * to the given runId and resolving inter-node references.
 */
export function templateToPlan(
  template: WorkflowTemplate,
  runId: string,
): ExecutionPlan {
  const nodeIdByTemplateId = new Map<string, string>();
  for (const phase of template.phases) {
    for (const node of phase.nodes) {
      nodeIdByTemplateId.set(node.id, scopedId(runId, node.id));
    }
  }

  return {
    phases: template.phases.map((phase) => ({
      id: scopedId(runId, phase.id),
      name: phase.name,
      nodes: phase.nodes.map((node) =>
        templateNodeToExecutable(runId, phase, node, nodeIdByTemplateId),
      ),
    })),
  };
}

/** 原模板先确定Gate身份；v3随后物化命令并清除运行时引用。 */
export function runPlanToExecutionPlan(plan: RunPlan, runId: string): ExecutionPlan {
  const execution = templateToPlan(plan.template, runId);
  if (plan.digestVersion === 3) {
    for (const phase of execution.phases) {
      for (const node of phase.nodes) {
        node.gates = node.gates.map(gate => materializeBoundGate(gate, plan.repoCommands));
      }
    }
  }
  return execution;
}

function templateNodeToExecutable(
  runId: string,
  phase: WorkflowTemplatePhase,
  node: WorkflowTemplateNode,
  nodeIdByTemplateId: Map<string, string>,
): ExecutableNode {
  return {
    id: scopedId(runId, node.id),
    role: node.role,
    phaseId: scopedId(runId, phase.id),
    inputs: node.inputs.map((input) => ({
      ...input,
      fromNodeId: nodeIdByTemplateId.get(input.fromNodeId) ?? input.fromNodeId,
    })),
    outputs: structuredClone(node.outputs),
    gates: gatesWithStableKeys(structuredClone(node.gates), node.id),
    dependsOn: node.dependsOn.map(
      (dependency) => nodeIdByTemplateId.get(dependency) ?? dependency,
    ),
  };
}

/**
 * Persist an execution plan to the repository database (phases + nodes).
 */
export async function persistPlan(
  runId: string,
  plan: ExecutionPlan,
  repositories: TekonRepositories,
): Promise<void> {
  const now = new Date().toISOString();
  for (const [phaseIndex, phase] of plan.phases.entries()) {
    await repositories.createPhase({
      id: phase.id,
      runId,
      name: phase.name,
      status: 'pending',
      order: phaseIndex,
      createdAt: now,
      updatedAt: now,
    });
    for (const [nodeIndex, node] of phase.nodes.entries()) {
      await repositories.createNode({
        id: node.id,
        runId,
        phaseId: phase.id,
        role: node.role,
        status: 'pending',
        inputs: node.inputs,
        outputs: node.outputs,
        gates: node.gates.map((gate) => gate as GateConfig),
        dependencies: node.dependsOn,
        order: nodeIndex,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

/**
 * Reconstruct an execution plan from persisted phases and nodes.
 */
export async function planFromRepository(
  runId: string,
  repositories: TekonRepositories,
): Promise<ExecutionPlan> {
  const phases = await repositories.listPhases(runId);
  const nodes = await repositories.listNodes(runId);
  return {
    phases: phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      nodes: nodes
        .filter((node) => node.phaseId === phase.id)
        .map((node) => persistedNodeToExecutable(node)),
    })),
  };
}

function persistedNodeToExecutable(node: Node): ExecutableNode {
  return {
    id: node.id,
    role: node.role,
    phaseId: node.phaseId,
    inputs: node.inputs,
    outputs: node.outputs,
    gates: gatesWithStableKeys(node.gates as WorkflowGateConfig[], node.id),
    dependsOn: node.dependencies,
  };
}

export const DYNAMIC_NODE_ORDER_OFFSET = 1_000_000;

export function deriveReworkNode(
  targetNode: ExecutableNode,
  reviewNodeId: string,
  attempt: number,
): ExecutableNode {
  return {
    ...structuredClone(targetNode),
    id: `${targetNode.id}_rework_${attempt}`,
    dependsOn: [reviewNodeId],
  };
}

export function deriveRepairNode(
  sourceNodeId: string,
  gateResultId: string,
  fixerRole: Role,
): ExecutableNode {
  return {
    id: `repair_${gateResultId}`,
    role: fixerRole,
    inputs: [],
    outputs: [],
    gates: [],
    dependsOn: [sourceNodeId],
  };
}

export interface PreparedRun {
  template: WorkflowTemplate;
  canonicalPlan: RunPlanV3;
  planSnapshot: string;
  planDigest: string;
  kind: 'workflow' | 'goal';
}

export function buildPreparedRun(
  input: {
    workflowSpec: WorkflowTemplate;
    templateName?: string;
    kind?: 'workflow' | 'goal';
    canonicalPlan?: RunPlan;
    planDigest?: string;
    planSnapshot?: string;
    repoCommands?: BoundRepoCommand[];
  },
  options: {
    agentProvider?: string;
    allowDirtyBase?: boolean;
    profile?: string;
    timeoutMs?: number;
    noProgressTimeoutMs?: number;
    progressHeartbeatMs?: number;
    canonicalPlan?: RunPlan;
    planDigest?: string;
    planSnapshot?: string;
    repoCommands?: BoundRepoCommand[];
  } = {},
): PreparedRun {
  const kind = input.kind ?? 'workflow';
  const template = normalizeExecutableTemplate(input.workflowSpec);
  const repoCommands = normalizeRepoCommands(template, options.repoCommands ?? input.repoCommands ?? []);
  const canonicalPlan = projectRunPlanV3(template, {
    mode: kind,
    agent: options.agentProvider ?? 'codex',
    allowDirtyBase: options.allowDirtyBase,
    profile: options.profile,
    timeoutMs: options.timeoutMs,
    noProgressTimeoutMs: options.noProgressTimeoutMs,
    progressHeartbeatMs: options.progressHeartbeatMs,
    templateId: input.templateName ?? template.id,
  }, repoCommands);
  // 校验每份确认来源；只有运行实际上下文能够生成最终持久化事实。
  const expected = canonicalJson(canonicalPlan);
  for (const [name, source] of [['input', input], ['options', options]] as const) {
    if (source.repoCommands !== undefined && canonicalJson(normalizeRepoCommands(template, source.repoCommands)) !== canonicalJson(repoCommands)) {
      throw new Error(`PLAN_DIGEST_MISMATCH: ${name}.repoCommands`);
    }
    if (source.canonicalPlan !== undefined) {
      const verified = validateRunPlanV3(source.canonicalPlan);
      if (canonicalJson(verified) !== expected) {
        throw new Error(`PLAN_DIGEST_MISMATCH: ${name}.canonicalPlan`);
      }
    }
    if (source.planSnapshot !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(source.planSnapshot); } catch {
        throw new Error(`PLAN_DIGEST_MISMATCH: ${name}.planSnapshot`);
      }
      if (canonicalJson(validateRunPlanV3(parsed)) !== expected) {
        throw new Error(`PLAN_DIGEST_MISMATCH: ${name}.planSnapshot`);
      }
    }
    if (source.planDigest !== undefined && source.planDigest !== canonicalPlan.digest) {
      throw new Error(`PLAN_DIGEST_MISMATCH: ${name}.planDigest`);
    }
  }
  return { template, canonicalPlan, planSnapshot: expected, planDigest: canonicalPlan.digest, kind };
}

function verificationFailed(path: string): never {
  throw new Error(`PLAN_VERIFICATION_FAILED: ${path}`);
}

function same(actual: unknown, expected: unknown, path: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) verificationFailed(path);
}

/** 不通过 repository 的 Zod 默认值补全/字段裁剪读取 v2 执行事实。 */
async function readExecutionRows(runId: string, repositories: TekonRepositories): Promise<{
  phases: Array<Pick<Phase, 'id' | 'runId' | 'name' | 'order'>>;
  nodes: Array<Pick<Node, 'id' | 'runId' | 'phaseId' | 'role' | 'inputs' | 'outputs' | 'gates' | 'dependencies' | 'order'>>;
}> {
  const db = repositories.getDatabase?.();
  if (!db) verificationFailed('repository.rawExecutionRows');
  type RawPhase = { id: string; run_id: string; name: string; phase_order: number };
  type RawNode = {
    id: string; run_id: string; phase_id: string | null; role: Role;
    inputs: string; outputs: string; gates: string; dependencies: string; node_order: number;
  };
  const phases = (db.prepare('select * from phases where run_id = ? order by phase_order, id').all(runId) as RawPhase[])
    .map(row => ({ id: row.id, runId: row.run_id, name: row.name, order: row.phase_order }));
  const nodes = (db.prepare('select * from nodes where run_id = ?').all(runId) as RawNode[])
    .map(row => ({
      id: row.id, runId: row.run_id, phaseId: row.phase_id ?? undefined, role: row.role,
      inputs: JSON.parse(row.inputs), outputs: JSON.parse(row.outputs), gates: JSON.parse(row.gates),
      dependencies: JSON.parse(row.dependencies), order: row.node_order,
    }));
  return { phases, nodes };
}

type ExecutionRow = Awaited<ReturnType<typeof readExecutionRows>>['nodes'][number];

function checkNode(row: ExecutionRow, expected: ExecutableNode, runId: string, order: number): void {
  same(row, {
    id: expected.id, runId, phaseId: expected.phaseId, role: expected.role,
    inputs: expected.inputs, outputs: expected.outputs, gates: expected.gates,
    dependencies: expected.dependsOn, order,
  }, 'nodes.fields');
}

function verifyCapturedAudit(events: AuditEvent[], runId: string): void {
  let prevHash: string | null = null;
  for (const event of events) {
    const { hash, ...content } = event;
    if (event.runId !== runId || event.prevHash !== prevHash ||
      createHash('sha256').update(canonicalJson(content)).digest('hex') !== hash) {
      verificationFailed('audit.chain');
    }
    prevHash = hash;
  }
}

export async function validateAndBuildExecutionPlan(
  runId: string,
  repositories: TekonRepositories,
  audit: AuditLogger,
  admissionStore: AdmissionStore | undefined = repositories.admissionStore,
): Promise<ExecutionPlan> {
  try {
    return await validateExecutionPlan(runId, repositories, audit, admissionStore);
  } catch (error) {
    // JSON/Zod/数据库异常可能包含原文；只允许本模块的固定字段路径对外返回。
    if (error instanceof Error && /^PLAN_VERIFICATION_FAILED: [\w.]+$/.test(error.message)) throw error;
    return verificationFailed('persistedRecords');
  }
}

async function validateExecutionPlan(
  runId: string,
  repositories: TekonRepositories,
  audit: AuditLogger,
  admissionStore: AdmissionStore | undefined,
): Promise<ExecutionPlan> {
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) verificationFailed('workflow');
  const admission = await admissionStore?.getAdmissionByRunId(runId);

  if (!workflow.planSnapshot && !workflow.planDigest) {
    if (admission) verificationFailed('admission.plan');
    return planFromRepository(runId, repositories);
  }
  if (!workflow.planSnapshot || !workflow.planDigest) verificationFailed('plan.missing');
  let snapshot: unknown;
  try { snapshot = JSON.parse(workflow.planSnapshot); } catch { verificationFailed('plan.json'); }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) verificationFailed('plan');
  const raw = snapshot as Record<string, unknown>;
  if (!Object.hasOwn(raw, 'digestVersion')) {
    if (admission) verificationFailed('admission.digestVersion');
    const digest = computeLegacyV1RunPlanDigest(raw);
    if (workflow.planDigest !== digest || (Object.hasOwn(raw, 'digest') && raw.digest !== digest)) {
      verificationFailed('legacy.digest');
    }
    return planFromRepository(runId, repositories);
  }
  const canonical = raw.digestVersion === 2
    ? validateRunPlanV2(raw, 'PLAN_VERIFICATION_FAILED')
    : validateRunPlanV3(raw, 'PLAN_VERIFICATION_FAILED');
  same(workflow.planDigest, canonical.digest, 'plan.digest');
  same(workflow.kind ?? 'workflow', canonical.mode, 'plan.mode');
  const plan = runPlanToExecutionPlan(canonical, runId);

  let rows: Awaited<ReturnType<typeof readExecutionRows>>;
  try { rows = await readExecutionRows(runId, repositories); } catch (error) {
    if (error instanceof Error && error.message.startsWith('PLAN_VERIFICATION_FAILED:')) throw error;
    verificationFailed('nodes.json');
  }
  same(rows.phases, plan.phases.map((phase, order) => ({
    id: phase.id, runId, name: phase.name, order,
  })), 'phases.fields');
  const dbNodes = new Map(rows.nodes.map(node => [node.id, node]));
  if (dbNodes.size !== rows.nodes.length) verificationFailed('nodes.duplicate');
  const proven = new Map<string, ExecutableNode>();
  for (const phase of plan.phases) {
    for (const [order, node] of phase.nodes.entries()) {
      const row = dbNodes.get(node.id);
      if (!row) verificationFailed('nodes.missing');
      checkNode(row, node, runId, order);
      proven.set(node.id, node);
    }
  }

  if (!(await audit.verify(runId)).valid) verificationFailed('audit.chain');
  const events = await repositories.listAuditEvents(runId);
  // verify() 与读取可能跨过 await；再次校验本次实际用于授权的同一事件数组。
  verifyCapturedAudit(events, runId);
  const results = new Map((await repositories.listGateResults(runId)).map(result => [result.id, result]));
  const reworkEvents = new Map<string, Set<string>>();

  function sourceNode(id: unknown): ExecutableNode {
    if (typeof id !== 'string') verificationFailed('authorization.source');
    const node = proven.get(id);
    if (!node || !dbNodes.has(id)) verificationFailed('authorization.source');
    return node;
  }
  function failedGate(id: unknown, node: ExecutableNode): { result: GateResult; gate: WorkflowGateConfig } {
    if (typeof id !== 'string') verificationFailed('authorization.gateResult');
    const result = results.get(id);
    if (!result || result.runId !== runId || result.nodeId !== node.id ||
      result.status === 'passed' || result.status === 'skipped') verificationFailed('authorization.gateResult');
    const gate = node.gates.find(g => g.type === result.gateType && g.gateKey === result.gateKey);
    if (!gate || !result.gateKey) verificationFailed('authorization.gateKey');
    return { result, gate };
  }
  function attempt(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
      verificationFailed('authorization.attempt');
    }
    return value;
  }
  function authorize(node: ExecutableNode, order: number): void {
    if (proven.has(node.id)) verificationFailed('authorization.duplicate');
    proven.set(node.id, node);
    const row = dbNodes.get(node.id);
    if (!row) return; // 已有创建前意图、尚未落节点是合法中断窗口。
    checkNode(row, node, runId, order);
    if (node.phaseId) {
      const phase = plan.phases.find(item => item.id === node.phaseId);
      if (!phase) verificationFailed('authorization.phase');
      phase.nodes.push(node);
    }
  }

  for (const event of events) {
    if (!['gate.rework.needs-revision', 'gate.rework.attempt', 'gate.repair.intent'].includes(event.type)) continue;
    const payload = event.payload;
    if (event.type === 'gate.repair.intent') {
      const source = sourceNode(payload.sourceNodeId);
      const { result, gate } = failedGate(payload.gateResultId, source);
      if (!gate.autoFix || gate.maxRetries <= 0) verificationFailed('repair.autoFix');
      attempt(payload.attempt, gate.maxRetries);
      same(payload.maxAttempts, gate.maxRetries, 'repair.maxAttempts');
      same(payload.gateType, gate.type, 'repair.gateType');
      same(payload.gateKey, gate.gateKey, 'repair.gateKey');
      same(payload.fixerRole, source.role, 'repair.fixerRole');
      const derived = deriveRepairNode(source.id, result.id, source.role);
      same(payload.repairNodeId, derived.id, 'repair.nodeId');
      // repair 是无 phase 的执行记录，不加入 workflow 调度。
      authorize(derived, 0);
      continue;
    }
    const review = sourceNode(payload.reviewNodeId);
    const target = sourceNode(payload.targetNodeId);
    const { result, gate } = failedGate(payload.gateResultId, review);
    if (gate.type !== 'independent-review' || result.failureClassification !== 'changes-requested') {
      verificationFailed('rework.gateResult');
    }
    const count = attempt(payload.attempt, resolveMaxReworkAttempts(gate.maxRetries));
    const derived = deriveReworkNode(target, review.id, count);
    const key = canonicalJson([review.id, target.id, result.id, count]);
    if (event.type === 'gate.rework.attempt') {
      same(payload.reworkNodeId, derived.id, 'rework.nodeId');
      if (payload.maxAttempts !== undefined) same(payload.maxAttempts, resolveMaxReworkAttempts(gate.maxRetries), 'rework.maxAttempts');
    }
    const pair = reworkEvents.get(key) ?? new Set<string>();
    if (pair.has(event.type)) verificationFailed('rework.duplicate');
    pair.add(event.type);
    reworkEvents.set(key, pair);
    if (pair.size !== 2) continue;
    authorize(derived, DYNAMIC_NODE_ORDER_OFFSET);
  }

  // 检查所有节点，包括没有 phase、无法分组、具有可信前缀的孤立记录。
  for (const row of rows.nodes) {
    if (!proven.has(row.id)) verificationFailed('nodes.unproven');
  }
  return plan;
}
