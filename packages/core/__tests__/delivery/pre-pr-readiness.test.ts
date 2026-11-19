import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPrePullRequestReady,
  createAuditLogger,
  createRepositories,
  evaluatePrePullRequestReadiness,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';
import type { AuditLogger, GateResult, TekonRepositories } from '../../src/index.js';
import {
  canonicalJson,
  captureRunPlan,
  computeRunPlanDigest,
  projectRunPlanV2,
} from '../../src/workflow/run-plan.js';
import {
  loadBuiltInWorkflowTemplate,
  loadWorkflowTemplate,
  parseWorkflowTemplate,
  type BuiltInWorkflowTemplateId,
  type WorkflowTemplate,
} from '../../src/workflow/template.js';

// PD-21：readiness 只认冻结 plan_snapshot 里的 delivery 声明。所有 fixture
// 都经 captureRunPlan 构造真实 V3 快照写入 workflow_instances（设计 §7 S1）。

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: ReturnType<typeof openTekonDatabase>;
let repos: TekonRepositories;
let audit: AuditLogger;
let repoPath: string;
/** IDs of gates created during fixture setup so artifacts can reference them. */
let gateIds: string[];

function setupDb() {
  db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  repos = createRepositories(db);
  audit = createAuditLogger({ repositories: repos });
  gateIds = [];
}

function cleanupDb() {
  db.close();
}

function setupRepoDir() {
  repoPath = mkdtempSync(join(tmpdir(), 'tekon-readiness-'));
}

function cleanupRepoDir() {
  rmSync(repoPath, { recursive: true, force: true });
}

async function createBaseFixtures(overrides?: {
  workflowStatus?: string;
  template?: BuiltInWorkflowTemplateId;
  /** 直接注入快照字符串，模拟 M4 的 null/V1/损坏/篡改场景。 */
  snapshotOverride?: string | null;
  digestOverride?: string | null;
}) {
  const templateId = overrides?.template ?? 'standard-delivery';
  await repos.createDemand({
    id: 'demand_1',
    title: 'Test demand',
    body: 'Body of test demand.',
    createdAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath,
    createdAt: '2026-06-13T00:00:00.000Z',
  });

  const template = loadBuiltInWorkflowTemplate(templateId);
  const frozenPlan = captureRunPlan(repoPath, template, { agent: 'codex' });

  await repos.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: overrides?.workflowStatus ?? 'passed',
    currentNodeId: 'node_1',
    planSnapshot:
      overrides?.snapshotOverride === undefined
        ? canonicalJson(frozenPlan)
        : overrides.snapshotOverride,
    planDigest:
      overrides?.digestOverride === undefined
        ? frozenPlan.digest
        : overrides.digestOverride,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createNode({
    id: 'node_2',
    runId: 'run_1',
    role: 'rd',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });

  // Audit events -- at least one for hash chain; run.started for traceability
  await audit.append({
    runId: 'run_1',
    type: 'run.started',
    payload: { templateId },
    createdAt: '2026-06-13T00:00:00.000Z',
  });
  await audit.append({
    runId: 'run_1',
    type: 'workflow.completed',
    payload: { status: 'passed' },
    createdAt: '2026-06-13T00:00:01.000Z',
  });
}

interface GateInput {
  nodeId?: string;
  gateType: string;
  gateKey?: string | null;
  status: string;
  failureClassification?: string | null;
  createdAt?: string;
}
async function addGate(input: GateInput): Promise<GateResult> {
  const gate = await repos.recordGateResult({
    id: `gate_${input.gateType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    runId: 'run_1',
    nodeId: input.nodeId ?? 'node_1',
    gateType: input.gateType,
    gateKey: input.gateKey ?? null,
    status: input.status as never,
    outputPath: null,
    durationMs: 100,
    retries: 0,
    fixAttemptId: null,
    failureClassification: input.failureClassification ?? null,
    createdAt: input.createdAt ?? '2026-06-13T00:00:02.000Z',
  });
  gateIds.push(gate.id);
  return gate;
}

async function addHumanDecision(overrides?: { status?: string }) {
  return repos.createHumanDecision({
    id: `hd_${Math.random().toString(36).slice(2, 6)}`,
    runId: 'run_1',
    nodeId: 'node_1',
    gateResultId: null,
    status: (overrides?.status ?? 'approved') as
      | 'pending'
      | 'approved'
      | 'rejected',
    actor: 'test-user',
    note: null,
    createdAt: '2026-06-13T00:00:00.000Z',
    decidedAt: '2026-06-13T00:00:01.000Z',
    gateType: '',
  });
}

interface ArtifactInput {
  type: string;
  path: string;
  nodeId?: string;
}
async function addArtifact(input: ArtifactInput) {
  return repos.recordArtifact({
    id: `artifact_${input.type}_${Math.random().toString(36).slice(2, 6)}`,
    type: input.type as never,
    version: 1,
    path: input.path,
    sha256: 'abc123',
    runId: 'run_1',
    nodeId: input.nodeId ?? 'node_1',
    sizeBytes: 100,
    summary: '',
    createdAt: '2026-06-13T00:00:00.000Z',
  });
}

function writeRepoFile(relPath: string, content: string) {
  const fullPath = join(repoPath, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

/**
 * Create the minimal evidence artifacts that make acceptance-evidenced,
 * qa-release-signoff-passed, and security-scans-passed checks pass.
 * Pre-condition: a passed build gate exists so gateIds[0] is referenceable.
 */
async function seedEvidenceArtifacts() {
  // Artifact 1: demand-card – registers acceptance criteria
  await addArtifact({
    type: 'demand-card',
    path: 'artifacts/demand-card/v1/demand.json',
  });
  writeRepoFile(
    'artifacts/demand-card/v1/demand.json',
    JSON.stringify({
      title: 'Test Demand',
      body: 'Demand body for testing.',
      acceptanceCriteria: [
        { id: 'ac_1', description: 'Acceptance criterion 1' },
      ],
    }),
  );

  // Artifact 2: test-report – criteriaEvidence references the passed build gate.
  const passedGateId = gateIds[0];
  await addArtifact({
    type: 'test-report',
    path: 'artifacts/test-report/v1/report.json',
  });
  writeRepoFile(
    'artifacts/test-report/v1/report.json',
    JSON.stringify({
      title: 'Test Report',
      body: 'All tests passed.',
      criteriaEvidence: [
        {
          criterionId: 'ac_1',
          status: 'passed',
          evidence: 'Criteria met.',
          gateResultIds: [passedGateId],
        },
      ],
    }),
  );

  // Artifact 3: qa-release-signoff – 字段名必须是 criterionId（schema 强制）。
  await addArtifact({
    type: 'qa-release-signoff',
    path: 'artifacts/qa-release-signoff/v1/signoff.json',
  });
  writeRepoFile(
    'artifacts/qa-release-signoff/v1/signoff.json',
    JSON.stringify({
      title: 'QA Signoff',
      body: 'QA signoff body.',
      criteriaEvidence: [
        { criterionId: 'ac_1', status: 'passed', evidence: 'QA verified.' },
      ],
      targetRef: 'main',
      validatedRef: 'main',
      overallStatus: 'passed',
    }),
  );

  // QA validation ref audit event (sets expectedRef for signoff match)
  await audit.append({
    runId: 'run_1',
    type: 'qa.validation.ref',
    payload: { ref: 'main' },
    createdAt: '2026-06-13T00:00:30.000Z',
  });
}

/** standard-delivery 全集声明所需的全部门禁与证据（happy path）。 */
async function seedStandardDeliveryFixtures() {
  await createBaseFixtures();

  // 声明的命令门：build/lint/test（build 在前，gateIds[0] 供证据引用）
  for (const gateType of ['build', 'test', 'lint']) {
    await addGate({ gateType, status: 'passed', createdAt: '2026-06-13T00:00:10.000Z' });
  }
  // 声明的 5 类治理门
  for (const gateType of [
    'independent-review',
    'role-scope',
    'ac-evidence',
    'qa-signoff',
    'process-completeness',
  ]) {
    await addGate({ gateType, status: 'passed', createdAt: '2026-06-13T00:00:20.000Z' });
  }
  // 安全扫描门 + 证据
  await addGate({ gateType: 'security-scan', status: 'passed', createdAt: '2026-06-13T00:00:25.000Z' });
  await seedEvidenceArtifacts();
}

const readiness = () =>
  evaluatePrePullRequestReadiness({
    repositories: repos,
    audit,
    runId: 'run_1',
    repoPath,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluatePrePullRequestReadiness（PD-21 声明驱动）', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('standard-delivery 全集声明满足时 ready=true，九项检查全绿', async () => {
    await seedStandardDeliveryFixtures();

    const result = await readiness();
    expect(result.runId).toBe('run_1');
    expect(result.ready).toBe(true);
    expect(result.checks).toHaveLength(9);
    for (const check of result.checks) {
      expect(check.passed, `check "${check.id}" should pass`).toBe(true);
    }
  });

  it('D5 新旧等价：声明式 (id,passed) 与旧硬编码九项（含改名映射）逐项相同', async () => {
    await seedStandardDeliveryFixtures();
    const result = await readiness();

    // Nit4：旧 id → 新 id 显式映射表，只比对 (id, passed)，evidence 文案允许变化。
    const legacyIdMap: Record<string, string> = {
      'standard-delivery-template': 'delivery-declared',
      'standard-governance-gates-passed': 'governance-gates-satisfied',
    };
    const legacyExpectation = [
      'standard-delivery-template',
      'workflow-passed',
      'audit-valid',
      'validation-gates-passed',
      'no-pending-human-gates',
      'acceptance-criteria-evidenced',
      'qa-release-signoff-passed',
      'standard-governance-gates-passed',
      'security-scans-passed',
    ].map((legacyId) => [legacyIdMap[legacyId] ?? legacyId, true] as const);

    const actual = result.checks.map(
      (check) => [check.id, check.passed] as const,
    );
    expect(actual.sort()).toEqual([...legacyExpectation].sort());
  });

  it('run 不存在时抛错（区别于快照 fail-closed 的不抛错路径）', async () => {
    await createBaseFixtures();
    await expect(
      evaluatePrePullRequestReadiness({
        repositories: repos,
        audit,
        runId: 'nonexistent',
        repoPath,
      }),
    ).rejects.toThrow('run not found: nonexistent');
  });

  it.each([
    ['bugfix', ['build', 'test', 'lint']],
    ['standard-feature', ['build', 'test', 'lint']],
  ] as const)(
    '%s 无治理门/无验收证据要求时仍可交付，未要求项发绿标注「模板未要求」',
    async (template, commandGates) => {
      await createBaseFixtures({ template });
      for (const gateType of commandGates) {
        await addGate({ gateType, status: 'passed' });
      }
      await addGate({ gateType: 'security-scan', status: 'passed' });
      await addGate({ gateType: 'qa-signoff', status: 'passed' });
      await seedEvidenceArtifacts();

      const result = await readiness();
      expect(result.ready).toBe(true);
      const byId = new Map(result.checks.map((check) => [check.id, check]));
      expect(byId.get('governance-gates-satisfied')?.passed).toBe(true);
      expect(byId.get('governance-gates-satisfied')?.evidence).toBe('模板未要求');
      expect(byId.get('acceptance-criteria-evidenced')?.evidence).toBe(
        '模板未要求',
      );
      // 命令门证据只统计声明的三类，不含 yaml 里不存在的 e2e。
      expect(byId.get('validation-gates-passed')?.evidence).toContain('3/3');
    },
  );

  it('test-improvement 声明 e2e-pass：缺结果判 missing 发红，补齐后转绿', async () => {
    await createBaseFixtures({ template: 'test-improvement' });
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await addGate({ gateType: 'qa-signoff', status: 'passed' });
    await seedEvidenceArtifacts();

    const missing = await readiness();
    expect(missing.ready).toBe(false);
    const commandCheck = missing.checks.find(
      (check) => check.id === 'validation-gates-passed',
    );
    expect(commandCheck?.passed).toBe(false);
    expect(commandCheck?.evidence).toContain('e2e-pass');

    await addGate({ gateType: 'e2e-pass', status: 'passed' });
    const green = await readiness();
    expect(green.ready).toBe(true);
  });

  it('docs-update 只声明 build/lint：无 test 门结果不挡交付', async () => {
    await createBaseFixtures({ template: 'docs-update' });
    await addGate({ gateType: 'build', status: 'passed' });
    await addGate({ gateType: 'lint', status: 'passed' });
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await addGate({ gateType: 'qa-signoff', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(true);
    const commandCheck = result.checks.find(
      (check) => check.id === 'validation-gates-passed',
    );
    expect(commandCheck?.passed).toBe(true);
    expect(commandCheck?.evidence).toContain('2/2');
  });

  it.each([['plan-only'], ['lightweight-delivery']] as const)(
    '%s 快照无 delivery 声明：仅返回 delivery-not-declared',
    async (template) => {
      await createBaseFixtures({ template });

      const result = await readiness();
      expect(result.ready).toBe(false);
      expect(result.checks).toEqual([
        {
          id: 'delivery-not-declared',
          passed: false,
          evidence: expect.stringContaining(template),
        },
      ]);
    },
  );

  it('goal 模板快照无 delivery 声明：同样仅返回 delivery-not-declared', async () => {
    // goal 不在 BuiltInWorkflowTemplateId 联合内，按名加载后手工冻结注入。
    const goalTemplate = loadWorkflowTemplate({ name: 'goal' });
    expect(goalTemplate.delivery).toBeUndefined();
    const frozen = captureRunPlan(repoPath, goalTemplate, { agent: 'codex' });
    await createBaseFixtures({
      snapshotOverride: canonicalJson(frozen),
      digestOverride: frozen.digest,
    });

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      {
        id: 'delivery-not-declared',
        passed: false,
        evidence: expect.stringContaining('goal'),
      },
    ]);
  });

  it('T3：裁决只跟 DB 中的冻结快照走——换快照即换结论，模板对象变化不影响在途 run', async () => {
    await seedStandardDeliveryFixtures();
    const before = await readiness();
    expect(before.ready).toBe(true);

    // 模拟「运行中改 yaml」的真实持久化效果：把该 run 的冻结快照换成
    // 不可交付模板（lightweight-delivery）的快照并同步 digest。
    const nonDeliverable = loadBuiltInWorkflowTemplate('lightweight-delivery');
    const replacement = captureRunPlan(repoPath, nonDeliverable, {
      agent: 'codex',
    });
    db.prepare(
      'update workflow_instances set plan_snapshot = ?, plan_digest = ? where id = ?',
    ).run(canonicalJson(replacement), replacement.digest, 'run_1');

    const swapped = await readiness();
    expect(swapped.ready).toBe(false);
    expect(swapped.checks).toEqual([
      {
        id: 'delivery-not-declared',
        passed: false,
        evidence: expect.stringContaining('lightweight-delivery'),
      },
    ]);

    // 同一 run 换回原可交付快照（重放/修复语义），裁决立即恢复，证明每次
    // 评估都实时读取快照列而非任何缓存或模板对象。
    const original = captureRunPlan(
      repoPath,
      loadBuiltInWorkflowTemplate('standard-delivery'),
      { agent: 'codex' },
    );
    db.prepare(
      'update workflow_instances set plan_snapshot = ?, plan_digest = ? where id = ?',
    ).run(canonicalJson(original), original.digest, 'run_1');

    const restored = await readiness();
    expect(restored.ready).toBe(true);
    expect(
      restored.checks.some((check) => check.id === 'delivery-declared'),
    ).toBe(true);
  });

  it('显式 deliverable:false 的合法快照按 not-declared 处理并给出精确证据', async () => {
    const template: WorkflowTemplate = parseWorkflowTemplate({
      id: 'explicitly-non-deliverable',
      delivery: { deliverable: false },
      phases: [
        {
          id: 'impl',
          nodes: [
            {
              id: 'rd-1',
              role: 'rd',
              outputs: [],
              gates: [{ type: 'build' }],
            },
          ],
        },
      ],
    });
    const frozen = captureRunPlan(repoPath, template, { agent: 'codex' });
    await createBaseFixtures({
      snapshotOverride: canonicalJson(frozen),
      digestOverride: frozen.digest,
    });

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('deliverable=false');
  });

  it('M1：两个节点同名命令门一败一成，必须发红（禁止集合抵消）', async () => {
    await createBaseFixtures({ template: 'bugfix' });
    await addGate({ nodeId: 'node_1', gateType: 'build', status: 'passed' });
    await addGate({ nodeId: 'node_2', gateType: 'build', status: 'failed' });
    for (const gateType of ['test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await addGate({ gateType: 'qa-signoff', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    const commandCheck = result.checks.find(
      (check) => check.id === 'validation-gates-passed',
    );
    expect(commandCheck?.passed).toBe(false);
    // 两个节点的 build 各算一条（1 过 1 败），加 test/lint 共 4 条、3 条满足。
    expect(commandCheck?.evidence).toContain('3/4');
  });

  it('workflow 未通过时 workflow-passed 发红', async () => {
    await createBaseFixtures({ workflowStatus: 'failed' });
    const result = await readiness();
    expect(result.ready).toBe(false);
    const check = result.checks.find((item) => item.id === 'workflow-passed');
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('failed');
  });

  it('审计哈希链被篡改时 audit-valid 发红，且不影响快照声明读取', async () => {
    await seedStandardDeliveryFixtures();
    const events = await repos.listAuditEvents('run_1');
    const lastEvent = events.at(-1);
    expect(lastEvent).toBeDefined();
    db.prepare('update audit_events set payload = ? where id = ?').run(
      JSON.stringify({ tampered: true }),
      lastEvent!.id,
    );

    const result = await readiness();
    expect(result.ready).toBe(false);
    const auditCheck = result.checks.find((item) => item.id === 'audit-valid');
    expect(auditCheck?.passed).toBe(false);
    expect(auditCheck?.evidence).toContain('broken');
    // 声明仍从冻结快照正常读出，没有退化成 delivery-not-declared。
    expect(result.checks.some((item) => item.id === 'delivery-declared')).toBe(
      true,
    );
  });

  it('存在待审批人工决策时 no-pending-human-gates 发红', async () => {
    await seedStandardDeliveryFixtures();
    await addHumanDecision({ status: 'pending' });

    const result = await readiness();
    expect(result.ready).toBe(false);
    const check = result.checks.find(
      (item) => item.id === 'no-pending-human-gates',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('1 pending');
  });

  it('治理门缺失时 governance-gates-satisfied 发红并指明缺哪类', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    // 只补部分治理门，缺 process-completeness 与 role-scope
    for (const gateType of ['independent-review', 'ac-evidence', 'qa-signoff']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    const govCheck = result.checks.find(
      (item) => item.id === 'governance-gates-satisfied',
    );
    expect(govCheck?.passed).toBe(false);
    expect(govCheck?.evidence).toMatch(/process-completeness|role-scope/);
  });

  it('治理门有记录但失败时 governance-gates-satisfied 发红（区别于缺失场景）', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    // 五类治理门都有记录，但 independent-review 失败。
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]) {
      await addGate({
        gateType,
        status: gateType === 'independent-review' ? 'failed' : 'passed',
      });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    const govCheck = result.checks.find(
      (item) => item.id === 'governance-gates-satisfied',
    );
    expect(govCheck?.passed).toBe(false);
    expect(govCheck?.evidence).toContain('independent-review');
  });

  it('qa-signoff 门未通过时 qa-release-signoff-passed 发红', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'process-completeness',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'qa-signoff', status: 'failed' });
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(
      result.checks.find((item) => item.id === 'qa-release-signoff-passed')
        ?.passed,
    ).toBe(false);
  });

  // TS-01：qaSignoffCheck 工件侧负向分支（门 passed 之后的复合谓词）。
  it('TS-01：qa-signoff 门 passed 但无签署工件时发红并给 missing 证据', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    // 故意不调用 seedEvidenceArtifacts：没有任何 qa-release-signoff 工件。
    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'qa-release-signoff-passed',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('QA release signoff missing');
  });

  it('TS-01：签署工件的 ref 与 qa.validation.ref 不符时发红', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    // demand-card 带验收准则，但签署单指向与审计期望 ref 不同的分支。
    await addArtifact({
      type: 'demand-card',
      path: 'artifacts/demand-card/v1/demand.json',
    });
    writeRepoFile(
      'artifacts/demand-card/v1/demand.json',
      JSON.stringify({
        title: 'Test Demand',
        body: 'Demand body.',
        acceptanceCriteria: [{ id: 'ac_1', description: 'criterion 1' }],
      }),
    );
    await addArtifact({
      type: 'qa-release-signoff',
      path: 'artifacts/qa-release-signoff/v1/signoff.json',
    });
    writeRepoFile(
      'artifacts/qa-release-signoff/v1/signoff.json',
      JSON.stringify({
        title: 'QA Signoff',
        body: 'Signoff body.',
        criteriaEvidence: [
          { criterionId: 'ac_1', status: 'passed', evidence: 'ok' },
        ],
        targetRef: 'feature/wrong',
        validatedRef: 'feature/wrong',
        overallStatus: 'passed',
      }),
    );
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { ref: 'main' },
      createdAt: '2026-06-13T00:00:30.000Z',
    });

    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'qa-release-signoff-passed',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('matchedRef=false');
  });

  it('TS-01：签署单只覆盖部分验收准则时发红', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addArtifact({
      type: 'demand-card',
      path: 'artifacts/demand-card/v1/demand.json',
    });
    writeRepoFile(
      'artifacts/demand-card/v1/demand.json',
      JSON.stringify({
        title: 'Test Demand',
        body: 'Demand body.',
        acceptanceCriteria: [
          { id: 'ac_1', description: 'criterion 1' },
          { id: 'ac_2', description: 'criterion 2' },
        ],
      }),
    );
    await addArtifact({
      type: 'qa-release-signoff',
      path: 'artifacts/qa-release-signoff/v1/signoff.json',
    });
    writeRepoFile(
      'artifacts/qa-release-signoff/v1/signoff.json',
      JSON.stringify({
        title: 'QA Signoff',
        body: 'Signoff body.',
        // 只覆盖 ac_1，ac_2 缺失。
        criteriaEvidence: [
          { criterionId: 'ac_1', status: 'passed', evidence: 'ok' },
        ],
        targetRef: 'main',
        validatedRef: 'main',
        overallStatus: 'passed',
      }),
    );
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { ref: 'main' },
      createdAt: '2026-06-13T00:00:30.000Z',
    });

    const result = await readiness();
    expect(
      result.checks.find((item) => item.id === 'qa-release-signoff-passed')
        ?.passed,
    ).toBe(false);
  });

  // TS-02：acceptanceEvidenceCheck 红色分支。
  it('TS-02：声明要求验收证据但零证据时 acceptance 检查发红', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    // 不写任何产物：acceptanceEvidence 为空数组。
    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'acceptance-criteria-evidenced',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('0/0 acceptance criteria evidenced');
  });

  it('TS-02：存在 failed 验收项时 acceptance 检查发红', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addArtifact({
      type: 'demand-card',
      path: 'artifacts/demand-card/v1/demand.json',
    });
    writeRepoFile(
      'artifacts/demand-card/v1/demand.json',
      JSON.stringify({
        title: 'Test Demand',
        body: 'Demand body.',
        acceptanceCriteria: [{ id: 'ac_1', description: 'criterion 1' }],
      }),
    );
    await addArtifact({
      type: 'test-report',
      path: 'artifacts/test-report/v1/report.json',
    });
    writeRepoFile(
      'artifacts/test-report/v1/report.json',
      JSON.stringify({
        title: 'Test Report',
        body: 'All tests executed.',
        criteriaEvidence: [
          {
            criterionId: 'ac_1',
            status: 'failed',
            evidence: 'criterion not met',
            gateResultIds: [gateIds[0] ?? 'gate_build'],
          },
        ],
      }),
    );

    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'acceptance-criteria-evidenced',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('0/1 acceptance criteria evidenced');
  });

  // TS-04：gateKey 去重与治理门 latest-wins。
  it('TS-04：同节点不同 gateKey 的同门结果分别保留（2/2），不被按类型合并', async () => {
    await createBaseFixtures({ template: 'bugfix' });
    await addGate({
      nodeId: 'node_1',
      gateType: 'build',
      gateKey: '00:build',
      status: 'passed',
      createdAt: '2026-06-13T00:00:10.000Z',
    });
    await addGate({
      nodeId: 'node_1',
      gateType: 'build',
      gateKey: '01:build',
      status: 'passed',
      createdAt: '2026-06-13T00:00:11.000Z',
    });
    await addGate({ gateType: 'test', status: 'passed' });
    await addGate({ gateType: 'lint', status: 'passed' });
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await addGate({ gateType: 'qa-signoff', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'validation-gates-passed',
    );
    expect(check?.passed).toBe(true);
    // 两个 gateKey 是两条独立结果（2 build + test + lint = 4 条）；若错误地
    // 按 gateType 合并只会剩 3 条。
    expect(check?.evidence).toContain('4/4');
  });

  it('TS-04：治理门同类型双记录以后一条失败为准（latest-wins），检查发红', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({
      gateType: 'independent-review',
      status: 'passed',
      createdAt: '2026-06-13T00:00:20.000Z',
    });
    await addGate({
      gateType: 'independent-review',
      status: 'failed',
      createdAt: '2026-06-13T00:00:21.000Z',
    });
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    const check = result.checks.find(
      (item) => item.id === 'governance-gates-satisfied',
    );
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('independent-review');
  });

  // PD-05：钉住「零 acceptanceCriteria 时签署检查不能通过」的当前契约。
  it('PD-05：无 demand-card 准则时 qa 签署检查发红（结构性契约特征测试）', async () => {
    await createBaseFixtures();
    for (const gateType of [
      'build',
      'test',
      'lint',
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
      'security-scan',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    // 只有签署工件、没有 demand-card，故 acceptanceCriteria 为空。
    await addArtifact({
      type: 'qa-release-signoff',
      path: 'artifacts/qa-release-signoff/v1/signoff.json',
    });
    writeRepoFile(
      'artifacts/qa-release-signoff/v1/signoff.json',
      JSON.stringify({
        title: 'QA Signoff',
        body: 'Signoff body.',
        // 工件本身合法，但没有 demand-card 提供 acceptanceCriteria，
        // matchingSignoff 的「准则全覆盖」条件无法满足。
        criteriaEvidence: [
          { criterionId: 'ac_orphan', status: 'passed', evidence: 'ok' },
        ],
        targetRef: 'main',
        validatedRef: 'main',
        overallStatus: 'passed',
      }),
    );
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { ref: 'main' },
      createdAt: '2026-06-13T00:00:30.000Z',
    });

    const result = await readiness();
    expect(
      result.checks.find((item) => item.id === 'qa-release-signoff-passed')
        ?.passed,
    ).toBe(false);
  });

  it('安全扫描无 passed 证据时 security-scans-passed 发红', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    const securityCheck = result.checks.find(
      (item) => item.id === 'security-scans-passed',
    );
    expect(securityCheck?.passed).toBe(false);
  });

  it('skipped + not-applicable 视为满足', async () => {
    await createBaseFixtures();
    await addGate({ gateType: 'build', status: 'passed' });
    await addGate({ gateType: 'lint', status: 'passed' });
    await addGate({
      gateType: 'test',
      status: 'skipped',
      failureClassification: 'not-applicable',
    });
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();
    expect((await readiness()).ready).toBe(true);
  });

  it('无 not-applicable 分类的 skipped 不满足，命令门发红', async () => {
    await createBaseFixtures();
    await addGate({ gateType: 'build', status: 'passed' });
    await addGate({ gateType: 'lint', status: 'passed' });
    await addGate({ gateType: 'test', status: 'skipped', failureClassification: null });
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(false);
    const commandCheck = result.checks.find(
      (item) => item.id === 'validation-gates-passed',
    );
    expect(commandCheck?.passed).toBe(false);
    expect(commandCheck?.evidence).toContain('2/3');
  });

  it('同节点同类型门禁以最新结果裁决：先败后胜转绿', async () => {
    await createBaseFixtures();
    await addGate({
      gateType: 'build',
      status: 'failed',
      createdAt: '2026-06-13T00:00:01.000Z',
    });
    await addGate({
      gateType: 'build',
      status: 'passed',
      createdAt: '2026-06-13T00:00:02.000Z',
    });
    await addGate({ gateType: 'test', status: 'passed' });
    await addGate({ gateType: 'lint', status: 'passed' });
    for (const gateType of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await readiness();
    expect(result.ready).toBe(true);
    expect(
      result.checks.find((item) => item.id === 'validation-gates-passed')
        ?.evidence,
    ).toBe('3/3 declared command gates passed or explicitly skipped');
  });
});

describe('M4 快照 fail-closed：一律 delivery-not-declared 且绝不抛错', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('plan_snapshot 为 null', async () => {
    await createBaseFixtures({ snapshotOverride: null, digestOverride: null });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('absent');
  });

  it('TS-06：V2 快照（无 delivery 声明）经 readiness 裁决为 delivery-not-declared', async () => {
    const legacy = loadBuiltInWorkflowTemplate('bugfix');
    delete legacy.delivery;
    const v2Plan = projectRunPlanV2(legacy, { agent: 'codex' });
    await createBaseFixtures({
      snapshotOverride: canonicalJson(v2Plan),
      digestOverride: v2Plan.digest,
    });

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    // 钉住 V2 分支真实走到 not-declared 语义，而非仅 id 巧合一致。
    expect(result.checks[0].evidence).toContain('does not declare');
    expect(result.checks[0].evidence).toContain('bugfix');
  });

  it('V1 旧快照（无 digestVersion）', async () => {
    const v1Snapshot = JSON.stringify({
      mode: 'workflow',
      template: { id: 'legacy' },
      digest: 'legacy',
    });
    await createBaseFixtures({ snapshotOverride: v1Snapshot });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('legacy v1');
  });

  it('损坏的 JSON', async () => {
    await createBaseFixtures({ snapshotOverride: '{not-json' });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('not valid JSON');
  });

  it('快照是 JSON 数组而非对象', async () => {
    await createBaseFixtures({ snapshotOverride: '["not","an","object"]' });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('not an object');
  });

  it('快照是 JSON 原始值而非对象', async () => {
    await createBaseFixtures({ snapshotOverride: '"a bare string"' });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('not an object');
  });

  it('未知 digestVersion 归入快照不可用，不抛错', async () => {
    await createBaseFixtures({
      snapshotOverride: JSON.stringify({
        digestVersion: 99,
        template: { id: 'future-template' },
        digest: 'whatever',
      }),
    });
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('delivery-not-declared');
  });

  it('V3 快照摘要篡改（digest 不自洽）', async () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const frozen = captureRunPlan(repoPath, template, { agent: 'codex' });
    const tampered = canonicalJson({ ...frozen, digest: 'forged-digest' });
    await createBaseFixtures({
      template: 'bugfix',
      snapshotOverride: tampered,
      digestOverride: frozen.digest,
    });

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0].id).toBe('delivery-not-declared');
    expect(result.checks[0].evidence).toContain('digest validation');
  });

  it('V3 快照结构篡改（重算 digest 但投影不一致仍被拒）', async () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const frozen = captureRunPlan(repoPath, template, { agent: 'codex' });
    const forged = { ...frozen, phases: [] };
    forged.digest = computeRunPlanDigest(forged);
    await createBaseFixtures({
      template: 'bugfix',
      snapshotOverride: canonicalJson(forged),
      digestOverride: frozen.digest,
    });

    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0].id).toBe('delivery-not-declared');
  });
});

describe('assertPrePullRequestReady', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('全部满足时返回 readiness 对象', async () => {
    await seedStandardDeliveryFixtures();
    const result = await assertPrePullRequestReady({
      repositories: repos,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(result.ready).toBe(true);
    expect(result.checks).toHaveLength(9);
  });

  it('不满足时抛带失败项的描述性错误', async () => {
    await createBaseFixtures({ workflowStatus: 'failed' });
    await expect(
      assertPrePullRequestReady({
        repositories: repos,
        audit,
        runId: 'run_1',
        repoPath,
      }),
    ).rejects.toThrow(/run is not ready for PR creation/);
  });

  it('不可交付模板抛错信息含 delivery-not-declared', async () => {
    await createBaseFixtures({ template: 'plan-only' });
    await expect(
      assertPrePullRequestReady({
        repositories: repos,
        audit,
        runId: 'run_1',
        repoPath,
      }),
    ).rejects.toThrow(/delivery-not-declared/);
  });
});
