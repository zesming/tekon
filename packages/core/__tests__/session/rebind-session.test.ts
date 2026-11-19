import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  captureRunPlan,
  createAuditLogger,
  createJobRepository,
  createJobRunner,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSessionService,
  createSubprocessRegistry,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
  type RunProviderConfig,
  type SessionService,
  type WorkflowEngine,
  type WorkflowInstance,
} from '../../src/index.js';
import { writePermissiveRepoProfile } from '../helpers/repo-profile.js';

// PD-05：SessionService.rebindRun 是 --rebind 的编排入口——非终态、无活跃
// 作业时用当前配置构建引擎快照，替换冻结绑定并回传分项差异；终态/活跃作业
// 走与 resumeRun 一致的判别结果，不产生写入。
describe('SessionService.rebindRun', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const release of cleanup.splice(0).reverse()) release();
  });

  function setup() {
    const projectRoot = mkdtempSync(join(tmpdir(), 'tekon-rebind-session-'));
    cleanup.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    writePermissiveRepoProfile(projectRoot);
    const db = openTekonDatabase({ filename: ':memory:' });
    cleanup.push(() => db.close());
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    const jobRunner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: { execute: async () => ({ status: 'done' }) },
    });
    const template = parseWorkflowTemplate({
      id: 'rebind-session',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'developer',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build' }],
            },
          ],
        },
      ],
    });
    const service = (engine: WorkflowEngine): SessionService<unknown> =>
      createSessionService({
        sessions,
        jobs,
        jobRunner,
        bus,
        repositories,
        audit,
        projectRoot,
        createEngine: () => engine,
      });
    return {
      projectRoot,
      repositories,
      jobs,
      sessions,
      jobRunner,
      template,
      service,
    };
  }

  function engineWithSnapshot(snapshot: RunProviderConfig): WorkflowEngine {
    return {
      providerSnapshot: {
        provider: snapshot.provider,
        configSummary: snapshot.configSummary,
      },
      buildPreparedRun: vi.fn(),
      prepareRun: vi.fn(),
      executePreparedRun: vi.fn(),
      startRun: vi.fn(),
      resumeRun: vi.fn(),
    } as unknown as WorkflowEngine;
  }

  async function seedFrozenRun(
    env: ReturnType<typeof setup>,
    runId: string,
    status: WorkflowInstance['status'],
  ) {
    const now = new Date().toISOString();
    await env.repositories.createProject({
      id: 'proj_1',
      name: 'Test',
      repoPath: env.projectRoot,
      createdAt: now,
    });
    await env.repositories.createDemand({
      id: 'demand_1',
      title: 'Test',
      body: 'Body',
      createdAt: now,
    });
    const plan = captureRunPlan(env.projectRoot, env.template, {
      agent: 'mock',
      mode: 'workflow',
    });
    await env.repositories.createWorkflowInstance({
      id: runId,
      projectId: 'proj_1',
      demandId: 'demand_1',
      status,
      planSnapshot: canonicalJson(plan),
      planDigest: plan.digest,
      createdAt: now,
      updatedAt: now,
    });
    const provider: RunProviderConfig = {
      runId,
      provider: 'mock',
      configSummary: { provider: 'mock' },
      createdAt: now,
    };
    await env.repositories.recordRunProviderConfig(provider);
    return { plan, provider };
  }

  it('rebinds a blocked run to the current profile and returns the binding diff', async () => {
    const env = setup();
    const runId = 'run_rebind';
    const frozen = await seedFrozenRun(env, runId, 'blocked');

    // 修改当前 profile 的 build 命令参数。
    writeFileSync(
      join(env.projectRoot, '.tekon', 'repo-profile.yaml'),
      JSON.stringify({
        version: 1,
        commands: {
          build: { tool: 'git', args: ['status'] },
        },
      }),
    );

    const result = await env
      .service(engineWithSnapshot(frozen.provider))
      .rebindRun({ runId, engine: {} });

    expect(result.outcome).toBe('rebound');
    if (result.outcome !== 'rebound') throw new Error('unreachable');
    expect(result.runId).toBe(runId);
    expect(result.diff.hasDifferences).toBe(true);
    expect(result.diff.repoCommands).toHaveLength(1);
    expect(result.diff.repoCommands[0]?.commandRef).toBe('build');

    const workflow = await env.repositories.getWorkflowInstance(runId);
    expect(workflow!.planDigest).not.toBe(frozen.plan.digest);
    expect(workflow!.planSnapshot).toContain('status');
    const events = await env.repositories.listAuditEvents(runId);
    expect(events.some((event) => event.type === 'run.rebound')).toBe(true);
  });

  it('refuses a terminal run without writing anything', async () => {
    const env = setup();
    const runId = 'run_terminal';
    const frozen = await seedFrozenRun(env, runId, 'passed');
    const result = await env
      .service(engineWithSnapshot(frozen.provider))
      .rebindRun({ runId, engine: {} });
    expect(result).toEqual({
      outcome: 'terminal',
      runId,
      status: 'passed',
    });
    const workflow = await env.repositories.getWorkflowInstance(runId);
    expect(workflow!.planDigest).toBe(frozen.plan.digest);
  });

  it('refuses while an active job owns the run', async () => {
    const env = setup();
    const runId = 'run_active';
    const frozen = await seedFrozenRun(env, runId, 'paused');
    const session = await env.sessions.createSession({
      workspaceId: (
        await env.sessions.getOrCreateDefaultWorkspace(env.projectRoot)
      ).id,
      title: null,
      profile: 'human-web',
      runId,
    });
    await env.jobRunner.enqueue({
      sessionId: session.id,
      kind: 'workflow-resume',
    });

    const result = await env
      .service(engineWithSnapshot(frozen.provider))
      .rebindRun({ runId, engine: {} });
    expect(result).toEqual({ outcome: 'active-job', runId });
    const workflow = await env.repositories.getWorkflowInstance(runId);
    expect(workflow!.planDigest).toBe(frozen.plan.digest);
  });

  it('throws when the run does not exist', async () => {
    const env = setup();
    await expect(
      env
        .service(
          engineWithSnapshot({
            runId: 'missing',
            provider: 'mock',
            configSummary: {},
            createdAt: new Date().toISOString(),
          }),
        )
        .rebindRun({ runId: 'run_missing', engine: {} }),
    ).rejects.toThrow(/run not found/);
  });
});
