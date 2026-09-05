import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createWorkflowEngine,
  loadWorkflowTemplate,
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
  type JobExecutor,
  type SessionService,
  type TekonRepositories,
  type WorkflowEngine,
  type WorkflowInstance,
  type WorkflowTemplate,
} from '../../src/index.js';

// Start uses a real Engine and SQLite admission; lifecycle tests isolate only
// execution so they can verify pause/resume/cancel without invoking a Provider.
// Broader fault/concurrency tests live in admission-engine and admission-store.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); });

interface TestEnv {
  projectRoot: string;
  engine: WorkflowEngine;
  repositories: TekonRepositories;
  sessions: ReturnType<typeof createSessionEventStore>;
  jobs: ReturnType<typeof createJobRepository>;
  bus: ReturnType<typeof createSessionEventBus>;
  jobRunner: ReturnType<typeof createJobRunner>;
  audit: ReturnType<typeof createAuditLogger>;
}

function setup(): TestEnv {
  const projectRoot = mkdtempSync(join(tmpdir(), 'tekon-session-service-'));
  cleanup.push(() => rmSync(projectRoot, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => { db.close(); });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
  const registry = createSubprocessRegistry();
  const executor: JobExecutor = {
    execute: async () => ({ status: 'done' }),
  };
  const jobRunner = createJobRunner({ jobs, sessions, bus, registry, executor });
  const engine = createWorkflowEngine({ repoPath: projectRoot, dataDir: '.tekon', repositories, audit,
    adapter: createMockAgentAdapter(), agentProvider: 'mock' });
  return { projectRoot, engine, repositories, sessions, jobs, bus, jobRunner, audit };
}

async function seedRun(
  env: TestEnv,
  runId: string,
  status: WorkflowInstance['status'] = 'running',
): Promise<WorkflowInstance> {
  // Ensure the base project/demand rows exist (setup seeds them async).
  await env.repositories.createProject({
    id: 'proj_1',
    name: 'Test',
    repoPath: env.projectRoot,
    createdAt: new Date().toISOString(),
  }).catch(() => {});
  await env.repositories
    .createDemand({
      id: 'demand_1',
      title: 'Test',
      body: 'Body',
      createdAt: new Date().toISOString(),
    })
    .catch(() => {});
  const now = new Date().toISOString();
  const instance: WorkflowInstance = {
    id: runId,
    projectId: 'proj_1',
    demandId: 'demand_1',
    status,
    createdAt: now,
    updatedAt: now,
  };
  await env.repositories.createWorkflowInstance(instance);
  return instance;
}

function fakeEngine(workflow: WorkflowInstance): WorkflowEngine {
  return {
    buildPreparedRun: vi.fn(() => { throw new Error('Unexpected fresh preparation in lifecycle test'); }),
    prepareRun: vi.fn(async () => { throw new Error('Unexpected fresh admission in lifecycle test'); }),
    executePreparedRun: vi.fn(async () => workflow),
    startRun: vi.fn(async () => ({ runId: workflow.id, workflow })),
    resumeRun: vi.fn(async () => ({ runId: workflow.id, workflow })),
  };
}

function makeService(
  env: TestEnv,
  engine: WorkflowEngine,
): SessionService<unknown> {
  return createSessionService({
    sessions: env.sessions,
    jobs: env.jobs,
    jobRunner: env.jobRunner,
    bus: env.bus,
    repositories: env.repositories,
    audit: env.audit,
    projectRoot: env.projectRoot,
    createEngine: () => engine,
  });
}

async function seedSession(
  env: TestEnv,
  runId: string,
): Promise<string> {
  const workspace = await env.sessions.getOrCreateDefaultWorkspace(env.projectRoot);
  const session = await env.sessions.createSession({
    workspaceId: workspace.id,
    title: null,
    profile: 'human-web',
    runId,
  });
  return session.id;
}

describe('SessionService.startRun', () => {
  it('atomically binds a real run/session/job and publishes the persisted opening prefix', async () => {
    const env = setup();
    const prepare = vi.spyOn(env.engine, 'buildPreparedRun');
    const publish = vi.spyOn(env.bus, 'publish');
    const service = makeService(env, env.engine);
    const result = await service.startRun({ demandText: 'Do the thing.', templateName: 'standard-delivery', engine: null });
    expect(result.workflow.id).toBe(result.runId);
    expect((await env.sessions.findSessionByRunId(result.runId))?.id).toBe(result.sessionId);
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events.map((event) => event.type)).toEqual(['session/created', 'workflow/started', 'user/message']);
    expect(events[0].payload).toEqual({ runId: result.runId, profile: 'human-web' });
    expect(events[1].payload).toEqual({ runId: result.runId, templateId: 'standard-delivery', mode: 'template', kind: 'workflow' });
    expect(events[2].payload).toEqual({ text: 'Do the thing.' });
    expect(events[2].modelVisible).toBe(true);
    expect(publish.mock.calls.map(([event]) => event)).toEqual(events);
    expect(await env.jobs.get(result.jobId)).toMatchObject({ kind: 'workflow-run', sessionId: result.sessionId, status: 'queued' });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      demandText: 'Do the thing.', mode: 'template', kind: 'workflow', profile: 'human-web',
      templateName: 'standard-delivery', requestId: result.requestId,
    }));
  });

  it('uses the actual workflowSpec rather than independently persisting a named template', async () => {
    const env = setup();
    const workflowSpec = { ...loadWorkflowTemplate({ name: 'goal' }), id: 'project-feature' };
    const result = await makeService(env, env.engine).startRun({ demandText: 'Spec run.', workflowSpec, engine: null });
    expect(JSON.parse(result.workflow.planSnapshot!).template.id).toBe('project-feature');
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events[1].payload).toMatchObject({ templateId: 'project-feature', runId: result.runId });
  });

  it('goal mode fixes the built-in source and job kind even when a project spec is supplied', async () => {
    const env = setup();
    const prepare = vi.spyOn(env.engine, 'buildPreparedRun');
    const result = await makeService(env, env.engine).startRun({
      demandText: 'Lightweight goal.', mode: 'goal', templateName: 'bugfix',
      workflowSpec: loadWorkflowTemplate({ name: 'bugfix' }), engine: null,
    });
    expect(prepare.mock.calls[0][0]).toMatchObject({ templateName: 'goal', kind: 'goal' });
    expect(prepare.mock.calls[0][0]).not.toHaveProperty('workflowSpec');
    expect(JSON.parse(result.workflow.planSnapshot!).template.id).toBe('goal');
    expect((await env.jobs.get(result.jobId))?.kind).toBe('goal-run');
    expect((await env.sessions.listEventsSince(result.sessionId, 0))[1].payload).toMatchObject({ templateId: 'goal', kind: 'goal' });
  });

  for (const mode of ['workflow', 'goal'] as const) {
    it(`binds the top-level ${mode} digest and rejects a stale one before persistence`, async () => {
      const env = setup();
      const templateName = mode === 'goal' ? 'goal' : 'standard-delivery';
      const digest = env.engine.buildPreparedRun({ demandText: 'Confirmed', mode: 'template', kind: mode, templateName, profile: 'human-web' }).planDigest;
      const service = makeService(env, env.engine);
      await expect(service.startRun({ demandText: 'Rejected', mode, templateName, engine: null, planDigest: 'wrong' }))
        .rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
      expect(env.repositories.getDatabase().prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 0 });
      const result = await service.startRun({ demandText: 'Confirmed', mode, templateName, engine: null, planDigest: digest });
      expect(result.workflow.planDigest).toBe(digest);
    });
  }

  it('rejects an explicitly empty digest instead of silently dropping confirmation', async () => {
    const env = setup();
    await expect(makeService(env, env.engine).startRun({ demandText: 'No confirmation', mode: 'goal', engine: null, planDigest: '' }))
      .rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
    expect(env.repositories.getDatabase().prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 0 });
  });

  it('rejects legacy async admission hooks without invoking them or creating a run', async () => {
    const env = setup();
    const onPrepared = vi.fn(async () => {});
    const input = { demandText: 'Legacy JS caller', engine: null, onPrepared };
    await expect(makeService(env, env.engine).startRun(input)).rejects.toThrow(/ADMISSION_HOOK_UNSUPPORTED/);
    expect(onPrepared).not.toHaveBeenCalled();
    expect(env.repositories.getDatabase().prepare('select count(*) as count from workflow_instances').get()).toEqual({ count: 0 });
  });

  it('preflight rejection prevents pure preparation and all admission side effects', async () => {
    const env = setup();
    const prepare = vi.spyOn(env.engine, 'buildPreparedRun');
    const service = createSessionService({
      sessions: env.sessions, jobs: env.jobs, jobRunner: env.jobRunner, bus: env.bus,
      repositories: env.repositories, audit: env.audit, projectRoot: env.projectRoot,
      createEngine: () => env.engine, preflight: async () => { throw new Error('preflight rejected'); },
    });
    await expect(service.startRun({ demandText: 'Blocked', engine: null })).rejects.toThrow('preflight rejected');
    expect(prepare).not.toHaveBeenCalled();
    for (const table of ['workflow_instances', 'sessions', 'session_events', 'jobs', 'run_admissions']) {
      expect(env.repositories.getDatabase().prepare(`select count(*) as count from ${table}`).get()).toEqual({ count: 0 });
    }
  });
});

describe('SessionService.resumeRun', () => {
  it('rejects (pending-decisions) when the run has pending human decisions, without enqueuing', async () => {
    const env = setup();
    await seedRun(env, 'run_pending');
    const now = new Date().toISOString();
    await env.repositories.createNode({
      id: 'node_1',
      runId: 'run_pending',
      role: 'rd',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    await env.repositories.createHumanDecision({
      id: 'dec_1',
      runId: 'run_pending',
      nodeId: 'node_1',
      status: 'pending',
      createdAt: now,
    });
    const enqueueSpy = vi.spyOn(env.jobRunner, 'enqueue');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_pending')!));

    const result = await service.resumeRun({ runId: 'run_pending' });

    expect(result).toEqual({ outcome: 'pending-decisions', runId: 'run_pending' });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('rejects (terminal) when the run is already terminal', async () => {
    const env = setup();
    await seedRun(env, 'run_done', 'passed');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_done')!));

    const result = await service.resumeRun({ runId: 'run_done' });

    expect(result).toEqual({
      outcome: 'terminal',
      runId: 'run_done',
      status: 'passed',
    });
  });

  it('rejects (active-job) when the run already has an active job', async () => {
    const env = setup();
    await seedRun(env, 'run_active', 'paused');
    const sessionId = await seedSession(env, 'run_active');
    await env.jobRunner.enqueue({ sessionId, kind: 'workflow-resume' });
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_active')!));

    const result = await service.resumeRun({ runId: 'run_active' });

    expect(result).toEqual({ outcome: 'active-job', runId: 'run_active' });
  });

  it('enqueues a workflow-resume job, creating a session when none exists', async () => {
    const env = setup();
    await seedRun(env, 'run_resume', 'paused');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_resume')!));

    const result = await service.resumeRun({ runId: 'run_resume' });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') throw new Error('unreachable');
    expect(result.runId).toBe('run_resume');
    expect(result.sessionId).toBeTruthy();
    expect(result.jobId).toBeTruthy();

    const session = await env.sessions.getSession(result.sessionId);
    expect(session).toMatchObject({ profile: 'human-web', title: null });
    expect(await env.sessions.findSessionByRunId('run_resume')).toBeTruthy();

    const job = await env.jobs.get(result.jobId);
    expect(job).toMatchObject({
      kind: 'workflow-resume',
      sessionId: result.sessionId,
      status: 'queued',
    });
  });

  it('reuses the existing session when one is already bound to the run', async () => {
    const env = setup();
    await seedRun(env, 'run_resume2', 'paused');
    const existingSessionId = await seedSession(env, 'run_resume2');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_resume2')!));

    const result = await service.resumeRun({ runId: 'run_resume2' });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') throw new Error('unreachable');
    expect(result.sessionId).toBe(existingSessionId);
    const workspace = await env.sessions.getOrCreateDefaultWorkspace(env.projectRoot);
    const sessions = await env.sessions.listSessions(workspace.id);
    expect(sessions).toHaveLength(1);
  });
});

describe('SessionService.requestPause', () => {
  it('CAS-transitions a running run to paused', async () => {
    const env = setup();
    await seedRun(env, 'run_pause', 'running');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_pause')!));

    const result = await service.requestPause({ runId: 'run_pause' });

    expect(result).toMatchObject({ outcome: 'paused', runId: 'run_pause' });
    const instance = await env.repositories.getWorkflowInstance('run_pause');
    expect(instance?.status).toBe('paused');
  });

  it('pauses the active job and returns sessionId/jobId when present', async () => {
    const env = setup();
    await seedRun(env, 'run_pause2', 'running');
    const sessionId = await seedSession(env, 'run_pause2');
    const job = await env.jobRunner.enqueue({ sessionId, kind: 'workflow-run' });
    const pauseSpy = vi.spyOn(env.jobRunner, 'requestPause');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_pause2')!));

    const result = await service.requestPause({ runId: 'run_pause2' });

    expect(result.outcome).toBe('paused');
    if (result.outcome !== 'paused') throw new Error('unreachable');
    expect(result.sessionId).toBe(sessionId);
    expect(result.jobId).toBe(job.id);
    expect(pauseSpy).toHaveBeenCalledWith(job.id);
  });

  it('returns illegal-transition for a terminal run without side effects', async () => {
    const env = setup();
    await seedRun(env, 'run_passed', 'passed');
    const sessionId = await seedSession(env, 'run_passed');
    const job = await env.jobRunner.enqueue({ sessionId, kind: 'workflow-run' });
    const pauseSpy = vi.spyOn(env.jobRunner, 'requestPause');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_passed')!));

    const result = await service.requestPause({ runId: 'run_passed' });

    expect(result).toEqual({
      outcome: 'illegal-transition',
      runId: 'run_passed',
      workflowStatus: 'passed',
    });
    // No side effects: the run stays passed and the job is not paused.
    const instance = await env.repositories.getWorkflowInstance('run_passed');
    expect(instance?.status).toBe('passed');
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('is idempotent on an already-paused run (no illegal-transition)', async () => {
    const env = setup();
    await seedRun(env, 'run_already_paused', 'paused');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_already_paused')!));

    const result = await service.requestPause({ runId: 'run_already_paused' });

    expect(result.outcome).toBe('paused');
  });
});

describe('SessionService.requestCancel', () => {
  it('cancels a running run via writeWorkflowTerminal (first step)', async () => {
    const env = setup();
    await seedRun(env, 'run_cancel', 'running');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_cancel')!));

    const result = await service.requestCancel({ runId: 'run_cancel' });

    expect(result.terminalConflict).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.jobId).toBeUndefined();
    const instance = await env.repositories.getWorkflowInstance('run_cancel');
    expect(instance?.status).toBe('cancelled');
  });

  it('emits cancel events once, cancels the session, and requests job cancellation', async () => {
    const env = setup();
    await seedRun(env, 'run_cancel2', 'running');
    const sessionId = await seedSession(env, 'run_cancel2');
    const job = await env.jobRunner.enqueue({ sessionId, kind: 'workflow-run' });
    const cancelSpy = vi.spyOn(env.jobRunner, 'requestCancel');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_cancel2')!));

    const result = await service.requestCancel({ runId: 'run_cancel2' });

    expect(result.terminalConflict).toBe(false);
    expect(result.sessionId).toBe(sessionId);
    expect(result.jobId).toBe(job.id);
    expect(cancelSpy).toHaveBeenCalledWith(job.id, 'web cancel');

    const events = await env.sessions.listEventsSince(sessionId, 0);
    const cancelEvents = events.filter((e) =>
      ['agent/cancel-requested', 'agent/cancelled'].includes(e.type),
    );
    expect(cancelEvents.map((e) => e.type)).toEqual([
      'agent/cancel-requested',
      'agent/cancelled',
    ]);
    const session = await env.sessions.getSession(sessionId);
    expect(session?.status).toBe('cancelled');
  });

  it('is idempotent: a repeat cancel (written=false) emits nothing and leaves the session untouched', async () => {
    const env = setup();
    await seedRun(env, 'run_cancel3', 'cancelled');
    const sessionId = await seedSession(env, 'run_cancel3');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_cancel3')!));

    const result = await service.requestCancel({ runId: 'run_cancel3' });

    expect(result.terminalConflict).toBe(false);
    expect(result.sessionId).toBe(sessionId);
    const events = await env.sessions.listEventsSince(sessionId, 0);
    expect(events).toHaveLength(0);
    const session = await env.sessions.getSession(sessionId);
    expect(session?.status).toBe('active');
  });

  it('returns terminalConflict when the run is already in a different terminal status, emitting nothing', async () => {
    const env = setup();
    await seedRun(env, 'run_passed_cancel', 'passed');
    const sessionId = await seedSession(env, 'run_passed_cancel');
    const job = await env.jobRunner.enqueue({ sessionId, kind: 'workflow-run' });
    const cancelSpy = vi.spyOn(env.jobRunner, 'requestCancel');
    const service = makeService(env, fakeEngine(await env.repositories.getWorkflowInstance('run_passed_cancel')!));

    const result = await service.requestCancel({ runId: 'run_passed_cancel' });

    // The CAS guard (writeWorkflowTerminal first) throws WorkflowTerminalError:
    // no session lookup, no events, no job cancel — the run stays passed.
    expect(result.terminalConflict).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.jobId).toBeUndefined();
    expect(cancelSpy).not.toHaveBeenCalled();
    const events = await env.sessions.listEventsSince(sessionId, 0);
    expect(events).toHaveLength(0);
    const instance = await env.repositories.getWorkflowInstance('run_passed_cancel');
    expect(instance?.status).toBe('passed');
  });

  it('propagates non-terminal errors (e.g. missing run) instead of swallowing them', async () => {
    const env = setup();
    const service = makeService(
      env,
      fakeEngine({
        id: 'run_missing',
        projectId: 'proj_1',
        demandId: 'demand_1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    await expect(
      service.requestCancel({ runId: 'run_missing' }),
    ).rejects.toThrow(/workflow instance not found/);
  });
});
