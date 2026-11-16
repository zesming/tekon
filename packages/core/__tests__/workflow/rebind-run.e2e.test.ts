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
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
  validateAndBuildExecutionPlan,
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
  }, 120_000);
});
