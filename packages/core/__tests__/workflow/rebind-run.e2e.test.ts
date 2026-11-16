import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureRunPlan,
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
  createJobRepository,
  createJobRunner,
  createMockAgentAdapter,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWorkflowEngine,
  createWorktreeManager,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
  validateAndBuildExecutionPlan,
  type AgentAdapter,
  type AgentRunInput,
  type RunProviderConfig,
} from '../../src/index.js';
import { rebindRunBinding } from '../../src/workflow/rebind-run.js';

// PD-05：--rebind 显式采用当前配置。冻结面（plan_snapshot/plan_digest 与
// run_provider_configs）在一次事务内替换为自洽的新绑定，非终态节点的物化
// 门禁同步重写，已通过节点的历史证据（gate_results/审计链）保持不变。
describe('PD-05 rebindRunBinding e2e', () => {
  const tempDirs: string[] = [];
  const openDbs: ReturnType<typeof openTekonDatabase>[] = [];

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function fixture(initialProfile: unknown) {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rebind-run-'));
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
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    const profilePath = join(repoPath, '.tekon', 'repo-profile.yaml');
    writeFileSync(
      profilePath,
      JSON.stringify({ version: 1, commands: { build: initialProfile } }),
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    openDbs.push(db);
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const template = parseWorkflowTemplate({
      id: 'rebind-run',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'developer',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build', maxRetries: 0 }],
            },
          ],
        },
      ],
    });
    const writeProfile = (entry: unknown) =>
      writeFileSync(
        profilePath,
        JSON.stringify({ version: 1, commands: { build: entry } }),
      );
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      agentProvider: 'mock',
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
    return {
      repoPath,
      db,
      repositories,
      audit,
      template,
      writeProfile,
      engine,
    };
  }

  function provider(
    repositories: ReturnType<typeof createRepositories>,
    runId: string,
  ): Promise<RunProviderConfig | null> {
    return repositories.getRunProviderConfig(runId);
  }

  it('adopts the repaired profile command so a blocked run resumes to passed, with integrity intact', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    const first = await f.engine.startRun({
      demandText: 'rebind 修复门禁命令',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('blocked');
    const before = await f.repositories.getWorkflowInstance(first.runId);
    const frozenPlan = captureRunPlan(f.repoPath, f.template, {
      agent: 'mock',
      mode: 'workflow',
    });
    //  sanity：冻结快照里还是退出 7 的旧命令。
    expect(JSON.stringify(frozenPlan.repoCommands)).toContain('exit(7)');

    f.writeProfile({ tool: process.execPath, args: ['-e', 'process.exit(0)'] });
    const snapshot = (await provider(f.repositories, first.runId))!;
    const result = await rebindRunBinding({
      repoPath: f.repoPath,
      runId: first.runId,
      repositories: f.repositories,
      audit: f.audit,
      currentProvider: snapshot,
    });

    // 新计划自洽且 digest 已更换。
    expect(result.plan.digest).not.toBe(before!.planDigest);
    expect(result.previousDigest).toBe(before!.planDigest);
    const after = await f.repositories.getWorkflowInstance(first.runId);
    expect(after!.planDigest).toBe(result.plan.digest);
    expect(after!.planSnapshot).toContain('exit(0)');
    expect(after!.planSnapshot).not.toContain('exit(7)');

    // 节点行的物化门禁已重写为新命令。
    const node = (await f.repositories.listNodes(first.runId))[0]!;
    expect(node.gates[0]).toMatchObject({
      command: { tool: process.execPath, args: ['-e', 'process.exit(0)'] },
    });
    expect(node.gates[0]).not.toHaveProperty('commandRef');

    // 完整性校验在新快照下通过，审计留下 rebind 轨迹。
    await expect(
      validateAndBuildExecutionPlan(first.runId, f.repositories, f.audit),
    ).resolves.toBeTruthy();
    const events = await f.repositories.listAuditEvents(first.runId);
    const rebound = events.find((event) => event.type === 'run.rebound');
    expect(rebound?.payload.previousDigest).toBe(before!.planDigest);
    expect(rebound?.payload.nextDigest).toBe(result.plan.digest);

    // resume 实际执行新命令并通过（旧命令必然继续退出 7）。
    const resumed = await f.engine.resumeRun(first.runId);
    expect(resumed.workflow.status).toBe('passed');
  }, 120_000);

  it('replaces the provider snapshot and plan agent on an explicit agent switch', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    const first = await f.engine.startRun({
      demandText: 'rebind 切换 agent',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('blocked');
    const frozenProvider = (await provider(f.repositories, first.runId))!;
    const switched: RunProviderConfig = {
      ...frozenProvider,
      provider: 'codex',
      configSummary: { provider: 'codex' },
    };
    const result = await rebindRunBinding({
      repoPath: f.repoPath,
      runId: first.runId,
      repositories: f.repositories,
      audit: f.audit,
      agent: 'codex',
      currentProvider: switched,
    });
    expect(result.plan.agent).toBe('codex');
    expect(result.diff.agent).toEqual({ from: 'mock', to: 'codex' });
    const stored = await provider(f.repositories, first.runId);
    expect(stored?.provider).toBe('codex');
    expect(
      (await f.repositories.getWorkflowInstance(first.runId))!.planDigest,
    ).toBe(result.plan.digest);
  }, 120_000);

  it('refuses to rebind a terminal run', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    const first = await f.engine.startRun({
      demandText: '终态拒绝 rebind',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('passed');
    const snapshot = (await provider(f.repositories, first.runId))!;
    await expect(
      rebindRunBinding({
        repoPath: f.repoPath,
        runId: first.runId,
        repositories: f.repositories,
        audit: f.audit,
        currentProvider: snapshot,
      }),
    ).rejects.toThrow(/REBIND_TERMINAL/u);
  }, 120_000);

  it('refuses inside the transaction when an active job owns the run (TOCTOU guard)', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    const first = await f.engine.startRun({
      demandText: 'rebind 事务内活跃作业兜底',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('blocked');
    const before = await f.repositories.getWorkflowInstance(first.runId);

    // 直接在库里造一个绑定该 run 的活跃 resume 作业（queued 即活跃），
    // 模拟 service 前置检查与事务之间作业被认领的 TOCTOU 窗口。
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(f.db, writeQueue);
    const jobs = createJobRepository(f.db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    const jobRunner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: { execute: async () => ({ status: 'done' }) },
    });
    const workspace = await sessions.getOrCreateDefaultWorkspace(f.repoPath);
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: null,
      profile: 'cli',
      runId: first.runId,
    });
    await jobRunner.enqueue({
      sessionId: session.id,
      kind: 'workflow-resume',
    });

    const snapshot = (await provider(f.repositories, first.runId))!;
    await expect(
      rebindRunBinding({
        repoPath: f.repoPath,
        runId: first.runId,
        repositories: f.repositories,
        audit: f.audit,
        currentProvider: snapshot,
      }),
    ).rejects.toThrow(/REBIND_ACTIVE_JOB/u);

    // 事务回滚：冻结 digest 不变，无 rebind 审计。
    const after = await f.repositories.getWorkflowInstance(first.runId);
    expect(after!.planDigest).toBe(before!.planDigest);
    const events = await f.repositories.listAuditEvents(first.runId);
    expect(events.some((e) => e.type === 'run.rebound')).toBe(false);
  }, 120_000);

  it('is idempotent when nothing changed: digest stays equal and integrity holds', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    const first = await f.engine.startRun({
      demandText: 'rebind 无差异幂等',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('blocked');
    const before = await f.repositories.getWorkflowInstance(first.runId);
    const snapshot = (await provider(f.repositories, first.runId))!;
    const result = await rebindRunBinding({
      repoPath: f.repoPath,
      runId: first.runId,
      repositories: f.repositories,
      audit: f.audit,
      currentProvider: snapshot,
    });
    expect(result.plan.digest).toBe(before!.planDigest);
    expect(result.diff.hasDifferences).toBe(false);
    await expect(
      validateAndBuildExecutionPlan(first.runId, f.repositories, f.audit),
    ).resolves.toBeTruthy();
    // 零差异短路：不写审计事件，避免噪声。
    const events = await f.repositories.listAuditEvents(first.runId);
    expect(events.some((e) => e.type === 'run.rebound')).toBe(false);
  }, 120_000);

  it('redacts secret material in the run.rebound audit payload', async () => {
    const f = fixture({
      tool: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    const first = await f.engine.startRun({
      demandText: 'rebind 审计脱敏',
      mode: 'template',
      workflowSpec: f.template,
    });
    expect(first.workflow.status).toBe('blocked');

    // 新命令参数里嵌入 OpenAI 形态密钥。
    const secret = 'sk-123456789012345678901234';
    f.writeProfile({
      tool: process.execPath,
      args: ['-e', `process.env.OPENAI_KEY="${secret}"`, 'process.exit(0)'],
    });
    const snapshot = (await provider(f.repositories, first.runId))!;
    await rebindRunBinding({
      repoPath: f.repoPath,
      runId: first.runId,
      repositories: f.repositories,
      audit: f.audit,
      currentProvider: snapshot,
    });

    const events = await f.repositories.listAuditEvents(first.runId);
    const rebound = events.find((e) => e.type === 'run.rebound');
    expect(rebound).toBeDefined();
    const serialized = JSON.stringify(rebound!.payload);
    expect(serialized).not.toContain(secret);
    expect(serialized.toUpperCase()).toContain('[REDACTED');
  }, 120_000);

  // Nit2（沉淀评审探针场景）：运行已含人工返工节点时 rebind，原节点与返工
  // 节点的物化门禁都要按新绑定重写，且计划完整性校验仍然通过。
  it('rewrites gates on both original and rework nodes after a human rework', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rebind-rework-'));
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
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    const profilePath = join(repoPath, '.tekon', 'repo-profile.yaml');
    writeFileSync(
      profilePath,
      JSON.stringify({
        version: 1,
        commands: {
          build: { tool: process.execPath, args: ['-e', 'process.exit(0)'] },
        },
      }),
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    openDbs.push(db);
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        if (input.runContext.nodeId.endsWith('rd-node')) {
          writeFileSync(
            join(input.runContext.repoPath, 'feature.txt'),
            'implemented\n',
            'utf8',
          );
        }
        return mock.runAgent(input);
      },
    };
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter,
      agentProvider: 'mock',
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
    const reworkSpec = parseWorkflowTemplate({
      id: 'rebind-rework',
      governance: 'none',
      phases: [
        {
          id: 'implementation',
          name: 'Implementation',
          dependsOn: [],
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [{ type: 'build', commandRef: 'build' }],
              dependsOn: [],
            },
          ],
        },
        {
          id: 'review',
          name: 'Review',
          dependsOn: ['implementation'],
          nodes: [
            {
              id: 'reviewer-node',
              role: 'reviewer',
              inputs: [{ id: 'code', type: 'code-changes', from: 'rd-node' }],
              outputs: [{ id: 'review', type: 'review-report' }],
              gates: [
                {
                  type: 'human',
                  requiresHumanApproval: true,
                  reworkTargetNodeId: 'rd-node',
                },
              ],
              dependsOn: ['rd-node'],
            },
          ],
        },
      ],
    });

    const first = await engine.startRun({
      demandText: 'rebind 覆盖返工节点',
      mode: 'template',
      workflowSpec: reworkSpec,
    });
    const decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).rejectHumanGate(
      decision.id,
      'contract-reviewer',
      '需要返工',
    );
    await engine.resumeRun(first.runId);

    // 返工节点已落库。
    const nodesBefore = await repositories.listNodes(first.runId);
    const reworkNode = nodesBefore.find((n) => n.id.includes('_rework_'));
    expect(reworkNode).toBeDefined();

    // 修改 build 命令后 rebind。
    writeFileSync(
      profilePath,
      JSON.stringify({
        version: 1,
        commands: {
          build: {
            tool: process.execPath,
            args: ['-e', 'console.log("rebound")'],
          },
        },
      }),
    );
    const snapshot = (await repositories.getRunProviderConfig(first.runId))!;
    await rebindRunBinding({
      repoPath,
      runId: first.runId,
      repositories,
      audit,
      currentProvider: snapshot,
    });

    // 原节点与返工节点的 build 门禁都被重写为新命令。
    const nodesAfter = await repositories.listNodes(first.runId);
    for (const node of nodesAfter.filter((n) => n.id.includes('rd-node'))) {
      const buildGate = node.gates.find((g) => g.type === 'build');
      expect(buildGate?.command).toMatchObject({
        tool: process.execPath,
        args: ['-e', 'console.log("rebound")'],
      });
    }
    // 完整性校验在含返工节点的新快照下仍通过。
    await expect(
      validateAndBuildExecutionPlan(first.runId, repositories, audit),
    ).resolves.toBeTruthy();
  }, 120_000);
});
