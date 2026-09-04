import { describe, expect, it, vi } from 'vitest';

import {
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
  type JobExecutor,
  type SessionService,
  type TekonRepositories,
  type WorkflowEngine,
  type WorkflowInstance,
  type WorkflowTemplate,
} from '../../src/index.js';

// 4a (design §2.1): SessionService is the extracted orchestration of the web
// project router's run/resume/cancel/pause flows. These tests pin the
// orchestration contract: session creation + runId binding, the three opening
// events, job enqueue kinds, the onPrepared hook position (after prepareRun,
// before createSession), and the cancel CAS guard (writeWorkflowTerminal first,
// terminal conflicts emit nothing).

const PROJECT_ROOT = '/tmp/tekon-session-service-test';

interface TestEnv {
  repositories: TekonRepositories;
  sessions: ReturnType<typeof createSessionEventStore>;
  jobs: ReturnType<typeof createJobRepository>;
  bus: ReturnType<typeof createSessionEventBus>;
  jobRunner: ReturnType<typeof createJobRunner>;
  audit: ReturnType<typeof createAuditLogger>;
}

function setup(): TestEnv {
  const db = openTekonDatabase({ filename: ':memory:' });
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
  return { repositories, sessions, jobs, bus, jobRunner, audit };
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
    repoPath: '/tmp/repo',
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
    prepareRun: vi.fn(async () => ({ runId: workflow.id, workflow })),
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
    projectRoot: PROJECT_ROOT,
    createEngine: () => engine,
  });
}

async function seedSession(
  env: TestEnv,
  runId: string,
): Promise<string> {
  const workspace = await env.sessions.getOrCreateDefaultWorkspace(PROJECT_ROOT);
  const session = await env.sessions.createSession({
    workspaceId: workspace.id,
    title: null,
    profile: 'human-web',
    runId,
  });
  return session.id;
}

describe('SessionService.startRun', () => {
  it('creates a run-bound session, appends the three opening events, and enqueues a workflow-run job', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_start',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);
    const publishSpy = vi.spyOn(env.bus, 'publish');

    const result = await service.startRun({
      demandText: 'Do the thing.',
      templateName: 'standard-delivery',
      engine: null,
    });

    expect(result.runId).toBe('run_start');
    expect(result.workflow).toBe(workflow);
    expect(result.sessionId).toBeTruthy();
    expect(result.jobId).toBeTruthy();

    // Session is bound to the run.
    const session = await env.sessions.getSession(result.sessionId);
    expect(session).not.toBeNull();
    const bound = await env.sessions.findSessionByRunId('run_start');
    expect(bound?.id).toBe(result.sessionId);

    // The three opening events, in order, with exact payloads.
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events.map((e) => e.type)).toEqual([
      'session/created',
      'workflow/started',
      'user/message',
    ]);
    expect(events[0].payload).toEqual({
      runId: 'run_start',
      profile: 'human-web',
    });
    expect(events[1].payload).toEqual({
      runId: 'run_start',
      templateId: 'standard-delivery',
      mode: 'template',
      kind: 'workflow',
    });
    expect(events[2].payload).toEqual({ text: 'Do the thing.' });
    expect(events[2].modelVisible).toBe(true);

    // Every appended event is also published to the bus.
    expect(publishSpy).toHaveBeenCalledTimes(3);
    expect(publishSpy).toHaveBeenNthCalledWith(1, events[0]);
    expect(publishSpy).toHaveBeenNthCalledWith(2, events[1]);
    expect(publishSpy).toHaveBeenNthCalledWith(3, events[2]);

    // The job is enqueued with the right kind + session binding.
    const job = await env.jobs.get(result.jobId);
    expect(job).toMatchObject({
      kind: 'workflow-run',
      sessionId: result.sessionId,
      status: 'queued',
    });

    // prepareRun received the templateName (no workflowSpec) + kind:'workflow'.
    expect(engine.prepareRun).toHaveBeenCalledWith({
      demandText: 'Do the thing.',
      mode: 'template',
      kind: 'workflow',
      templateName: 'standard-delivery',
    });
  });

  it('passes workflowSpec to prepareRun and uses its id as the event templateId', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_spec',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);
    const workflowSpec = { id: 'project-feature' } as WorkflowTemplate;

    const result = await service.startRun({
      demandText: 'Spec run.',
      workflowSpec,
      engine: null,
    });

    expect(engine.prepareRun).toHaveBeenCalledWith({
      demandText: 'Spec run.',
      mode: 'template',
      kind: 'workflow',
      workflowSpec,
    });
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events[1].payload).toMatchObject({
      templateId: 'project-feature',
      runId: 'run_spec',
    });
  });

  // 4b: goal mode ignores template/workflowSpec, uses the built-in goal
  // template, enqueues a goal-run job, and tags events kind:'goal'.
  it('runs goal mode via the goal template, ignoring any template/workflowSpec', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_goal',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      kind: 'goal',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    const result = await service.startRun({
      demandText: 'Lightweight goal.',
      mode: 'goal',
      // Both provided but must be ignored in goal mode.
      templateName: 'standard-delivery',
      workflowSpec: { id: 'ignored' } as WorkflowTemplate,
      engine: null,
    });

    expect(engine.prepareRun).toHaveBeenCalledWith({
      demandText: 'Lightweight goal.',
      mode: 'template',
      templateName: 'goal',
      kind: 'goal',
    });
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events[1].type).toBe('workflow/started');
    expect(events[1].payload).toMatchObject({ kind: 'goal', templateId: 'goal' });
    const job = await env.jobs.get(result.jobId);
    expect(job?.kind).toBe('goal-run');
  });

  it('forwards planDigest to prepareRun for workflow runs when provided', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_digest',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    await service.startRun({
      demandText: 'Run with digest.',
      templateName: 'standard-delivery',
      planDigest:
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      engine: null,
    });

    expect(engine.prepareRun).toHaveBeenCalledWith({
      demandText: 'Run with digest.',
      mode: 'template',
      kind: 'workflow',
      templateName: 'standard-delivery',
      planDigest:
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    });
  });

  it('forwards planDigest to prepareRun for goal runs when provided', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_goal_digest',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      kind: 'goal',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    await service.startRun({
      demandText: 'Goal with digest.',
      mode: 'goal',
      planDigest:
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      engine: null,
    });

    expect(engine.prepareRun).toHaveBeenCalledWith({
      demandText: 'Goal with digest.',
      mode: 'template',
      templateName: 'goal',
      kind: 'goal',
      planDigest:
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('does not add planDigest property to prepareRun when not provided', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_no_digest',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    await service.startRun({
      demandText: 'Run without digest.',
      engine: null,
    });

    const callArgs = vi.mocked(engine.prepareRun).mock.calls[0][0];
    expect('planDigest' in callArgs).toBe(false);
  });

  it('does not add planDigest property to prepareRun when it is empty', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_empty_digest',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    await service.startRun({
      demandText: 'Run with an empty digest.',
      planDigest: '',
      engine: null,
    });

    const callArgs = vi.mocked(engine.prepareRun).mock.calls[0][0];
    expect('planDigest' in callArgs).toBe(false);
  });

  it('calls onPrepared after prepareRun but before createSession', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_hook',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const service = makeService(env, engine);

    const onPrepared = vi.fn(async (runId: string) => {
      expect(runId).toBe('run_hook');
      // The session must not exist yet — the hook lands between prepareRun
      // and createSession (design §2.1 M3: demand-shaped audit needs runId
      // but must precede session creation).
      const session = await env.sessions.findSessionByRunId(runId);
      expect(session).toBeNull();
    });

    await service.startRun({
      demandText: 'Hooked run.',
      templateName: 'standard-delivery',
      engine: null,
      onPrepared,
    });

    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(onPrepared).toHaveBeenCalledWith('run_hook');
    // After the hook, the session exists.
    const session = await env.sessions.findSessionByRunId('run_hook');
    expect(session).not.toBeNull();
  });

  it('propagates onPrepared rejections (the audit hook must not be swallowed)', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_hook_fail',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = makeService(env, fakeEngine(workflow));

    await expect(
      service.startRun({
        demandText: 'Hooked run.',
        templateName: 'standard-delivery',
        engine: null,
        onPrepared: async () => {
          throw new Error('audit chain broken');
        },
      }),
    ).rejects.toThrow('audit chain broken');

    // No session/job leaked past the failed hook.
    expect(await env.sessions.findSessionByRunId('run_hook_fail')).toBeNull();
  });

  it('works without onPrepared', async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: 'run_nohook',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const service = makeService(env, fakeEngine(workflow));

    const result = await service.startRun({
      demandText: 'Plain run.',
      templateName: 'standard-delivery',
      engine: null,
    });

    expect(result.sessionId).toBeTruthy();
    const events = await env.sessions.listEventsSince(result.sessionId, 0);
    expect(events).toHaveLength(3);
  });

  it("executes deps.preflight hook before prepareRun and creates no side effects if preflight fails", async () => {
    const env = setup();
    const workflow: WorkflowInstance = {
      id: "run_preflight_fail",
      projectId: "proj_1",
      demandId: "demand_1",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const engine = fakeEngine(workflow);
    const callOrder: string[] = [];

    const preflightError = new Error("DSH capability preflight failed");
    const service = createSessionService({
      sessions: env.sessions,
      jobs: env.jobs,
      jobRunner: env.jobRunner,
      bus: env.bus,
      repositories: env.repositories,
      audit: env.audit,
      projectRoot: PROJECT_ROOT,
      createEngine: () => {
        callOrder.push("createEngine");
        return engine;
      },
      preflight: async () => {
        callOrder.push("preflight");
        throw preflightError;
      },
    });

    await expect(
      service.startRun({
        demandText: "Should fail fast on preflight",
        templateName: "standard-delivery",
        engine: null,
      }),
    ).rejects.toThrow("DSH capability preflight failed");

    expect(callOrder).toEqual(["createEngine", "preflight"]);
    expect(engine.prepareRun).not.toHaveBeenCalled();

    // No session created
    const session = await env.sessions.findSessionByRunId("run_preflight_fail");
    expect(session).toBeNull();
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
    const workspace = await env.sessions.getOrCreateDefaultWorkspace(PROJECT_ROOT);
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
