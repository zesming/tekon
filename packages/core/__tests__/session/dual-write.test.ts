import { describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createDualWriteAuditLogger,
  createDualWriteRepositories,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSessionDualWriteBridge,
  createWriteQueue,
  MAPPED_AUDIT_EVENT_TYPES,
  mapAuditEventToSessionEvent,
  migrateDatabase,
  openTekonDatabase,
  type SessionEvent,
  type SessionEventStore,
  type TekonRepositories,
} from '../../src/index.js';

const NOW = '2026-08-21T00:00:00.000Z';
const RUN_ID = 'run_1';
const NODE_ID = 'run_1_node_1';

function setup() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const bus = createSessionEventBus();
  const bridge = createSessionDualWriteBridge({ sessions, bus });
  const dualAudit = createDualWriteAuditLogger(audit, bridge);
  const dualRepositories = createDualWriteRepositories(repositories, bridge);
  return { db, repositories, audit, sessions, bus, dualAudit, dualRepositories };
}

async function seedRun(
  repositories: TekonRepositories,
  runId: string = RUN_ID,
): Promise<string> {
  const nodeId = `${runId}_node_1`;
  await repositories.createDemand({
    id: `demand_${runId}`,
    title: 'Dual-write run',
    body: 'body',
    createdAt: NOW,
  });
  await repositories.createProject({
    id: `project_${runId}`,
    name: 'tekon',
    repoPath: '/tmp/tekon',
    createdAt: NOW,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: `project_${runId}`,
    demandId: `demand_${runId}`,
    status: 'running',
    currentNodeId: nodeId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repositories.createNode({
    id: nodeId,
    runId,
    role: 'rd',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return nodeId;
}

async function seedSession(
  sessions: SessionEventStore,
  runId: string = RUN_ID,
) {
  const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/tekon');
  return sessions.createSession({
    workspaceId: workspace.id,
    title: null,
    profile: 'human-web',
    runId,
  });
}

// ---------------------------------------------------------------------------
// §1.2 audit → session_event 映射表(逐条)
// ---------------------------------------------------------------------------

const AUDIT_MAPPING_CASES = [
  {
    auditType: 'run.started',
    auditPayload: { templateId: 'tpl_1', mode: 'tests' },
    expectedType: 'workflow/started',
    expectedPayload: {
      runId: RUN_ID,
      templateId: 'tpl_1',
      mode: 'tests',
      kind: 'workflow',
    },
  },
  {
    auditType: 'run.resumed',
    auditPayload: {},
    expectedType: 'workflow/started',
    expectedPayload: { runId: RUN_ID, resumed: true, kind: 'workflow' },
  },
  {
    auditType: 'run.passed',
    auditPayload: {},
    expectedType: 'agent/status',
    expectedPayload: { runId: RUN_ID, status: 'passed', kind: 'workflow' },
  },
  {
    auditType: 'node.started',
    auditPayload: { nodeId: NODE_ID, role: 'rd' },
    expectedType: 'workflow/node-started',
    expectedPayload: { runId: RUN_ID, nodeId: NODE_ID, role: 'rd' },
  },
  {
    auditType: 'node.passed',
    auditPayload: { nodeId: NODE_ID, from: 'awaiting-gate', to: 'passed' },
    expectedType: 'workflow/node-ended',
    expectedPayload: { runId: RUN_ID, nodeId: NODE_ID, status: 'passed' },
  },
  {
    auditType: 'node.interrupted',
    auditPayload: { nodeId: NODE_ID, error: 'agent failed' },
    expectedType: 'workflow/node-ended',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 'interrupted',
      error: 'agent failed',
    },
  },
  {
    auditType: 'node.resumed-at-gates',
    auditPayload: { nodeId: NODE_ID, role: 'rd' },
    expectedType: 'workflow/node-started',
    expectedPayload: { runId: RUN_ID, nodeId: NODE_ID, resumed: 'at-gates' },
  },
  {
    auditType: 'node.stale-running-detected',
    auditPayload: { nodeId: NODE_ID, role: 'rd' },
    expectedType: 'workflow/node-ended',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 'interrupted',
      reason: 'stale-running',
    },
  },
  {
    auditType: 'pmo.node-checkpoint',
    auditPayload: {
      nodeId: NODE_ID,
      role: 'rd',
      status: 'passed',
      requiredArtifacts: ['code-changes'],
      missingArtifacts: ['code-changes'],
      gateTypes: [],
      gateKeys: [],
      latestGateStatuses: [],
    },
    expectedType: 'job/checkpointed',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 'passed',
      missingArtifacts: ['code-changes'],
    },
  },
  {
    auditType: 'artifact.dependency.missing',
    auditPayload: {
      nodeId: NODE_ID,
      fromNodeId: 'run_1_node_0',
      artifactType: 'code-changes',
    },
    expectedType: 'agent/status',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 'blocked',
      missing: { fromNodeId: 'run_1_node_0', type: 'code-changes' },
    },
  },
  {
    auditType: 'gate.execution.error',
    auditPayload: { nodeId: NODE_ID, error: 'gate blew up' },
    expectedType: 'agent/error',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      message: 'gate blew up',
    },
  },
  {
    auditType: 'worktree.lease.created',
    auditPayload: {
      nodeId: NODE_ID,
      leaseId: 'lease_1',
      worktreePath: '/tmp/tekon/.tekon/worktrees/run_1',
      branchName: 'tekon/run-1',
    },
    expectedType: 'worktree/leased',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      leaseId: 'lease_1',
      branchName: 'tekon/run-1',
    },
  },
  {
    auditType: 'worktree.lease.finalize.failed',
    auditPayload: { nodeId: NODE_ID, error: 'finalize failed' },
    expectedType: 'agent/error',
    expectedPayload: {
      runId: RUN_ID,
      nodeId: NODE_ID,
      message: 'finalize failed',
    },
  },
];

describe('dual-write audit mapping (§1.2 逐条)', () => {
  it.each(AUDIT_MAPPING_CASES)(
    'maps audit $auditType to $expectedType with exact payload',
    async ({ auditType, auditPayload, expectedType, expectedPayload }) => {
      const { repositories, dualAudit, sessions } = setup();
      await seedRun(repositories);
      const session = await seedSession(sessions);

      await dualAudit.append({
        runId: RUN_ID,
        type: auditType,
        payload: auditPayload,
      });

      const events = await sessions.listEventsSince(session.id, 0);
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.type).toBe(expectedType);
      expect(event.payload).toEqual(expectedPayload);
      // 设计未逐条指定 visibility/modelVisible/correlationId —— 采用契约默认值
      // (治理事件是 UI 可观测脊柱,非模型上下文)。
      expect(event.visibility).toBe('ui-only');
      expect(event.modelVisible).toBe(false);
      expect(event.correlationId).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// §1.2 仓储层写入映射(4 个方法)
// ---------------------------------------------------------------------------

describe('dual-write repository mapping (§1.2)', () => {
  it('maps recordGateResult to gate/result', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    await dualRepositories.recordGateResult({
      id: 'gate_1',
      runId: RUN_ID,
      nodeId: NODE_ID,
      gateType: 'schema',
      gateKey: 'g1',
      status: 'passed',
      durationMs: 100,
      retries: 0,
      createdAt: NOW,
    });

    const events = await sessions.listEventsSince(session.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('gate/result');
    expect(events[0].payload).toEqual({
      runId: RUN_ID,
      nodeId: NODE_ID,
      gateType: 'schema',
      gateKey: 'g1',
      status: 'passed',
      durationMs: 100,
      retries: 0,
    });
  });

  it('maps recordArtifact to artifact/created (path 不进事件)', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    await dualRepositories.recordArtifact({
      id: 'artifact_1',
      runId: RUN_ID,
      nodeId: NODE_ID,
      type: 'code-changes',
      version: 1,
      path: '/tmp/tekon/.tekon/artifacts/run_1/code.patch',
      sha256: 'abc123',
      sizeBytes: 2048,
      summary: 'code changes',
      createdAt: NOW,
    });

    const events = await sessions.listEventsSince(session.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('artifact/created');
    expect(events[0].payload).toEqual({
      runId: RUN_ID,
      nodeId: NODE_ID,
      artifactId: 'artifact_1',
      type: 'code-changes',
      version: 1,
      sha256: 'abc123',
      sizeBytes: 2048,
      summary: 'code changes',
    });
    expect(JSON.stringify(events[0].payload)).not.toContain('/tmp/tekon');
  });

  it('maps createHumanDecision (pending) to approval/requested', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    await dualRepositories.createHumanDecision({
      id: 'decision_1',
      runId: RUN_ID,
      nodeId: NODE_ID,
      gateResultId: null,
      status: 'pending',
      note: 'please approve',
      createdAt: NOW,
    });

    const events = await sessions.listEventsSince(session.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('approval/requested');
    expect(events[0].payload).toEqual({
      runId: RUN_ID,
      nodeId: NODE_ID,
      decisionId: 'decision_1',
      request: null,
    });
  });

  it('does not map createHumanDecision when status is not pending', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    // 直接以 approved 状态落库(非请求新审批)——不产生 approval/requested
    await dualRepositories.createHumanDecision({
      id: 'decision_2',
      runId: RUN_ID,
      nodeId: NODE_ID,
      gateResultId: null,
      status: 'approved',
      actor: 'user-1',
      note: null,
      createdAt: NOW,
      decidedAt: NOW,
    });

    const events = await sessions.listEventsSince(session.id, 0);
    expect(events).toHaveLength(0);
  });

  it('maps updateHumanDecision to approval/decided', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    await repositories.createHumanDecision({
      id: 'decision_3',
      runId: RUN_ID,
      nodeId: NODE_ID,
      gateResultId: null,
      status: 'pending',
      note: null,
      createdAt: NOW,
    });
    await dualRepositories.updateHumanDecision('decision_3', {
      status: 'approved',
      actor: 'user-1',
      note: 'ok',
      decidedAt: NOW,
    });

    const events = await sessions.listEventsSince(session.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('approval/decided');
    expect(events[0].payload).toEqual({
      runId: RUN_ID,
      nodeId: NODE_ID,
      decisionId: 'decision_3',
      decision: 'approved',
      actor: 'user-1',
    });
  });

  it('updateHumanDecision on unknown decision produces no event', async () => {
    const { repositories, dualRepositories, sessions } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);

    const result = await dualRepositories.updateHumanDecision('nope', {
      status: 'rejected',
      actor: 'user-1',
      note: null,
      decidedAt: NOW,
    });
    expect(result).toBeNull();
    expect(await sessions.listEventsSince(session.id, 0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S9 显式不映射清单(精确断言,无漏网)
// ---------------------------------------------------------------------------

const UNMAPPED_AUDIT_TYPES = [
  // gate 类
  'gate.passed',
  'gate.passed-after-repair',
  'gate.passed-after-rework',
  'gate.previously-passed',
  'gate.repair.created',
  'gate.repair.failed',
  'gate.rework.attempt',
  'gate.rework.completed',
  'gate.rework.failed',
  'gate.rework.lease.finalize.failed',
  'gate.rework.review.re-execute.failed',
  'human.gate.pending',
  'human.gate.approved',
  'human.gate.rejected',
  'qa.validation.ref',
  // worktree 类
  'worktree.lease.promoted',
  'worktree.lease.released',
  // run 级
  'run.demand-shaped',
  // delivery/eval 模块
  'delivery.ci.checked',
  'delivery.ci.watch-completed',
  'delivery.pr-prepared',
  'ac-evidence',
  'build',
  'ci-status',
  'delivery-package',
  'e2e-pass',
  'independent-review',
  'lint',
  'process-completeness',
  'qa-signoff',
  'role-scope',
  'schema',
  'security-scan',
  'test',
  // node
  'node.transition.checked',
];

describe('S9 显式不映射清单', () => {
  it.each(UNMAPPED_AUDIT_TYPES)(
    'does not produce a session event for audit %s',
    async (auditType) => {
      const { repositories, dualAudit, sessions } = setup();
      await seedRun(repositories);
      const session = await seedSession(sessions);

      await dualAudit.append({
        runId: RUN_ID,
        type: auditType,
        payload: { nodeId: NODE_ID, foo: 'bar' },
      });

      expect(await sessions.listEventsSince(session.id, 0)).toHaveLength(0);
    },
  );

  it('mapping table covers exactly the §1.2 audit types (no more, no less)', () => {
    const expected = AUDIT_MAPPING_CASES.map((c) => c.auditType).sort();
    expect([...MAPPED_AUDIT_EVENT_TYPES].sort()).toEqual(expected);
  });

  it('mapAuditEventToSessionEvent returns non-null for every mapped type', () => {
    for (const auditType of MAPPED_AUDIT_EVENT_TYPES) {
      const mapped = mapAuditEventToSessionEvent({
        runId: RUN_ID,
        auditType,
        auditPayload: {},
      });
      expect(mapped, auditType).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// best-effort / 降级 / C1 治理零回归
// ---------------------------------------------------------------------------

describe('dual-write best-effort 与降级', () => {
  it('无 session 时静默跳过,不抛错(M1: prepareRun 内 run.started 场景)', async () => {
    const { repositories, dualAudit, sessions } = setup();
    await seedRun(repositories);
    // 故意不 seedSession —— 模拟 prepareRun 内 session 尚未创建

    await expect(
      dualAudit.append({
        runId: RUN_ID,
        type: 'run.started',
        payload: { templateId: 'tpl_1', mode: 'tests' },
      }),
    ).resolves.toBeTruthy();

    // 没有任何 session,自然也没有事件
    const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/tekon');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: null,
      profile: 'human-web',
      runId: RUN_ID,
    });
    expect(await sessions.listEventsSince(session.id, 0)).toHaveLength(0);
  });

  it('M1: router 显式补发 workflow/started 与 audit run.started 不产生重复事件', async () => {
    const { repositories, dualAudit, sessions } = setup();
    await seedRun(repositories);

    // 1. prepareRun 内 audit run.started(session 不存在 → 静默跳过)
    await dualAudit.append({
      runId: RUN_ID,
      type: 'run.started',
      payload: { templateId: 'tpl_1', mode: 'tests' },
    });

    // 2. router createSession 后显式补发(M1)
    const session = await seedSession(sessions);
    await sessions.appendEvent({
      sessionId: session.id,
      type: 'workflow/started',
      payload: {
        runId: RUN_ID,
        templateId: 'tpl_1',
        mode: 'tests',
        kind: 'workflow',
      },
    });

    const events = await sessions.listEventsSince(session.id, 0);
    const started = events.filter((e) => e.type === 'workflow/started');
    expect(started).toHaveLength(1);
  });

  it('bridge 失败时 audit.append 仍成功(C1 治理零回归)', async () => {
    const { repositories, audit } = setup();
    await seedRun(repositories);
    const failingBridge = createSessionDualWriteBridge({
      sessions: {
        findSessionByRunId: async () => {
          throw new Error('session db down');
        },
      } as unknown as SessionEventStore,
      bus: createSessionEventBus(),
    });
    const dualAudit = createDualWriteAuditLogger(audit, failingBridge);

    const result = await dualAudit.append({
      runId: RUN_ID,
      type: 'node.started',
      payload: { nodeId: NODE_ID, role: 'rd' },
    });
    expect(result.id).toBeTruthy();
    // 哈希链仍 valid
    expect(await audit.verify(RUN_ID)).toMatchObject({ valid: true });
  });

  it('audit 哈希链在 dual-write 后仍 valid', async () => {
    const { repositories, dualAudit, audit, sessions } = setup();
    await seedRun(repositories);
    await seedSession(sessions);

    await dualAudit.append({
      runId: RUN_ID,
      type: 'node.started',
      payload: { nodeId: NODE_ID, role: 'rd' },
    });
    await dualAudit.append({
      runId: RUN_ID,
      type: 'run.passed',
      payload: {},
    });

    expect(await audit.verify(RUN_ID)).toMatchObject({ valid: true });
  });

  it('appended events 在 bus 上发布(live 订阅者可见)', async () => {
    const { repositories, dualAudit, sessions, bus } = setup();
    await seedRun(repositories);
    const session = await seedSession(sessions);
    const received: SessionEvent[] = [];
    bus.subscribe(session.id, (event) => received.push(event));

    await dualAudit.append({
      runId: RUN_ID,
      type: 'run.passed',
      payload: {},
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('agent/status');
    expect(received[0].seq).toBe(1);
  });
});
