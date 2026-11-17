import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
  WorkflowTerminalError,
  type AgentAdapter,
  type AgentRunInput,
  type GateEngine,
} from '../../src/index.js';

// PD-17 步 3：failed 运行的显式 retry。onExhausted=fail 的门禁把运行置为
// 终态 failed；retryRun 把失败节点重新跑一遍（已通过节点复用），裸 resume
// 仍按终态拒绝。
describe('PD-17 step 3 failed run retry e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-failed-retry-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    return repoPath;
  }

  function spec() {
    return {
      id: 'failed-retry',
      name: 'Failed Retry',
      version: 1,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'fail' as const,
      },
      phases: [
        {
          id: 'implementation',
          name: 'Implementation',
          dependsOn: [],
          nodes: [
            {
              id: 'flaky-node',
              role: 'rd',
              inputs: [],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [
                {
                  type: 'build',
                  requiresHumanApproval: false,
                  autoFix: false,
                  onExhausted: 'fail' as const,
                },
              ],
              dependsOn: [],
            },
          ],
        },
      ],
    };
  }

  /** 第一次门禁 failed（exit-code，非 fail-fast 白名单），之后放行。 */
  function failOnceGateEngine(
    repositories: ReturnType<typeof createRepositories>,
  ): GateEngine {
    const callsByNode = new Map<string, number>();
    return {
      async runGate(input) {
        const count = (callsByNode.get(input.nodeId) ?? 0) + 1;
        callsByNode.set(input.nodeId, count);
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${count}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: count === 1 ? 'failed' : 'passed',
          failureClassification: count === 1 ? 'exit-code' : null,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
    };
  }

  function countingAdapter(): {
    adapter: AgentAdapter;
    calls: Map<string, number>;
  } {
    const mock = createMockAgentAdapter();
    const calls = new Map<string, number>();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        const nodeId = input.runContext.nodeId;
        calls.set(nodeId, (calls.get(nodeId) ?? 0) + 1);
        if (nodeId.endsWith('flaky-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };
    return { adapter, calls };
  }

  async function buildEngine(
    repoPath: string,
    repositories: ReturnType<typeof createRepositories>,
    audit: ReturnType<typeof createAuditLogger>,
    gateway: ReturnType<typeof createCommandGateway>,
    adapter: AgentAdapter,
  ) {
    return createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: failOnceGateEngine(repositories),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
  }

  it('retries a failed node to passed while a plain resume stays terminal-rejected', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const { adapter, calls } = countingAdapter();
    const engine = await buildEngine(
      repoPath,
      repositories,
      audit,
      gateway,
      adapter,
    );

    // 1) 首跑门禁失败 → run 与节点都进入终态 failed。
    const first = await engine.startRun({
      demandText: 'failed 重试链路',
      mode: 'template',
      workflowSpec: spec(),
    });
    expect(first.workflow.status).toBe('failed');
    const failedNode = (await repositories.listNodes(first.runId)).find((n) =>
      n.id.endsWith('flaky-node'),
    )!;
    expect(failedNode.status).toBe('failed');

    // 2) 裸 resume 仍按终态拒绝（retry 是独立显式入口）。
    await expect(engine.resumeRun(first.runId)).rejects.toBeInstanceOf(
      WorkflowTerminalError,
    );

    // 3) retry：失败节点重跑，agent 被第二次调用，门禁放行到 passed。
    const retried = await engine.retryRun(first.runId);
    expect(retried.workflow.status).toBe('passed');
    expect(calls.get(failedNode.id)).toBe(2);
    const retriedNode = await repositories.getNode(failedNode.id);
    expect(retriedNode?.status).toBe('passed');

    // 租约语义：failed 节点首跑留下未释放的活动租约，retry 复用同一租约
    // （同一行、同一工作树保留现场），而不是新建第二条；成功后才释放。
    const leasesAfter = await repositories.listWorktreeLeases(first.runId);
    expect(leasesAfter).toHaveLength(1);
    expect(leasesAfter[0]!.releasedAt).not.toBeNull();
    // 每次 agent 执行各建一条 role_run：首跑与 retry 共两条。
    const roleRunCount = (
      db
        .prepare(
          'select count(*) as n from role_runs where run_id=? and node_id=?',
        )
        .get(first.runId, failedNode.id) as { n: number }
    ).n;
    expect(roleRunCount).toBe(2);

    // 4) 审计留下显式 retry 轨迹。
    const events = await repositories.listAuditEvents(first.runId);
    const retryEvent = events.find((e) => e.type === 'run.retried');
    expect(retryEvent?.payload.fromStatus).toBe('failed');
    expect(retryEvent?.payload.toStatus).toBe('running');

    db.close();
  }, 120_000);

  it('refuses retry on a run that is not failed', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const { adapter } = countingAdapter();
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: {
        async runGate(input) {
          return repositories.recordGateResult({
            id: `gate_${input.gate.type}_${input.nodeId}_ok`,
            runId: input.runId,
            nodeId: input.nodeId,
            gateType: input.gate.type,
            gateKey: input.gate.gateKey,
            status: 'passed',
            durationMs: 0,
            retries: 0,
            createdAt: new Date().toISOString(),
          });
        },
      },
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const first = await engine.startRun({
      demandText: '非 failed 拒绝 retry',
      mode: 'template',
      workflowSpec: spec(),
    });
    expect(first.workflow.status).toBe('passed');
    await expect(engine.retryRun(first.runId)).rejects.toThrow(
      /RETRY_NOT_FAILED/u,
    );

    db.close();
  }, 120_000);

  it('re-runs only the failed node and reuses upstream passed nodes', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const { adapter, calls } = countingAdapter();

    // 两节点：upstream 恒放行，downstream 首次 gate fail、次跑放行。
    const gateCalls = new Map<string, number>();
    const gateEngine: GateEngine = {
      async runGate(input) {
        const isDownstream = input.nodeId.endsWith('downstream-node');
        const gateCount = (gateCalls.get(input.nodeId) ?? 0) + 1;
        gateCalls.set(input.nodeId, gateCount);
        const shouldFail = isDownstream && gateCount === 1;
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${Date.now()}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: shouldFail ? 'failed' : 'passed',
          failureClassification: shouldFail ? 'exit-code' : null,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
    };
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine,
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
    const twoNodeSpec = {
      id: 'failed-retry-two-node',
      name: 'Failed Retry Two Node',
      version: 1,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'fail' as const,
      },
      phases: [
        {
          id: 'implementation',
          name: 'Implementation',
          dependsOn: [],
          nodes: [
            {
              id: 'upstream-node',
              role: 'rd',
              inputs: [],
              outputs: [{ id: 'plan', type: 'prd' }],
              gates: [],
              dependsOn: [],
            },
            {
              id: 'downstream-node',
              role: 'rd',
              inputs: [
                { id: 'plan', type: 'prd', fromNodeId: 'upstream-node' },
              ],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [
                {
                  type: 'build',
                  requiresHumanApproval: false,
                  autoFix: false,
                  onExhausted: 'fail' as const,
                },
              ],
              dependsOn: ['upstream-node'],
            },
          ],
        },
      ],
    };

    const first = await engine.startRun({
      demandText: 'retry 只重跑失败节点',
      mode: 'template',
      workflowSpec: twoNodeSpec,
    });
    expect(first.workflow.status).toBe('failed');
    const upstreamId = (await repositories.listNodes(first.runId)).find((n) =>
      n.id.endsWith('upstream-node'),
    )!.id;
    const downstreamId = (await repositories.listNodes(first.runId)).find((n) =>
      n.id.endsWith('downstream-node'),
    )!.id;
    // 首跑各调用一次。
    expect(calls.get(upstreamId)).toBe(1);
    expect(calls.get(downstreamId)).toBe(1);

    const retried = await engine.retryRun(first.runId);
    expect(retried.workflow.status).toBe('passed');
    // upstream 已 passed，retry 复用、agent 不重复调用；downstream 重跑一次。
    expect(calls.get(upstreamId)).toBe(1);
    expect(calls.get(downstreamId)).toBe(2);
    expect((await repositories.getNode(upstreamId))?.status).toBe('passed');
    expect((await repositories.getNode(downstreamId))?.status).toBe('passed');

    db.close();
  }, 120_000);
});
