import { afterEach, describe, expect, it } from 'vitest';

import {
  createAutomationJobExecutor,
  createAuditLogger,
  createJobRepository,
  createJobRunner,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type DurableJobRunner,
  type Session,
  type SessionEventStore,
  type TekonRepositories,
} from '../../src/index.js';

// 4d/4e: the automation executor drives non-workflow, side-effect-light job
// kinds (delivery-auto-prepare, readiness-evaluate). Its contract (design M1):
// it NEVER touches workflow/session terminal state — a failure must not flip
// an already-passed run's session to failed. These tests pin that isolation.

const runners: DurableJobRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    try {
      await runner.stop();
    } catch {
      // best-effort cleanup
    }
  }
});

function setup() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
  const registry = createSubprocessRegistry();
  const executor = createAutomationJobExecutor({
    repositories,
    audit,
    sessions,
    bus,
    projectRoot: '/tmp/tekon-automation-test',
  });
  const runner = createJobRunner({
    jobs,
    sessions,
    bus,
    registry,
    executor,
    pollIntervalMs: 5,
    heartbeatMs: 30,
    leaseTtlMs: 30_000,
    workerId: 'worker_automation_test',
  });
  runners.push(runner);
  return { db, repositories, audit, sessions, jobs, bus, runner };
}

async function seedRun(
  repositories: TekonRepositories,
  runId: string,
  status: 'running' | 'passed' = 'passed',
  kind: 'workflow' | 'goal' = 'workflow',
): Promise<void> {
  const now = new Date().toISOString();
  await repositories.createDemand({
    id: `demand_${runId}`,
    title: 'auto',
    body: 'auto',
    source: 'template',
    createdAt: now,
  });
  await repositories.createProject({
    id: `project_${runId}`,
    name: 'tekon',
    repoPath: '/tmp/tekon-automation-test',
    createdAt: now,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: `project_${runId}`,
    demandId: `demand_${runId}`,
    status,
    kind,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSession(
  sessions: SessionEventStore,
  runId: string,
): Promise<Session> {
  const workspace = await sessions.getOrCreateDefaultWorkspace(
    '/tmp/tekon-automation-test',
  );
  return sessions.createSession({
    workspaceId: workspace.id,
    title: 'test',
    profile: 'autonomous-delivery',
    runId,
  });
}

function eventTypes(
  sessions: SessionEventStore,
  sessionId: string,
): Promise<string[]> {
  return sessions
    .listEventsSince(sessionId, 0)
    .then((events) => events.map((e) => e.type));
}

async function waitForJob(
  jobs: ReturnType<typeof createJobRepository>,
  jobId: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobs.get(jobId);
    if (
      job &&
      (job.status === 'done' ||
        job.status === 'failed' ||
        job.status === 'cancelled')
    ) {
      return job.status;
    }
    if (Date.now() >= deadline) {
      throw new Error(`job ${jobId} did not settle in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('automation job executor (4d/4e)', () => {
  it('M1 isolation: a failed delivery-auto-prepare leaves the run passed and session done', async () => {
    const { repositories, sessions, jobs, runner } = setup();
    // A passed run whose session is done — the state after a workflow run
    // finishes. This run is NOT delivery-ready (no gates/artifacts/evidence),
    // so createPullRequestPreparation → assertPrePullRequestReady will throw.
    await seedRun(repositories, 'run_unready', 'passed');
    const session = await seedSession(sessions, 'run_unready');
    await sessions.updateSessionStatus(session.id, 'done');

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
    });
    runner.start();
    const jobStatus = await waitForJob(jobs, job.id);

    // The automation job itself settles failed (prepare threw)...
    expect(jobStatus).toBe('failed');
    // ...but the run stays passed and the session stays done (M1: automation
    // failure must NOT flip workflow/session terminal state).
    expect((await repositories.getWorkflowInstance('run_unready'))?.status).toBe(
      'passed',
    );
    const updated = await sessions.findSessionByRunId('run_unready');
    expect(updated?.status).toBe('done');
    // A best-effort agent/error is emitted; no turn/end or run-terminal event.
    const types = await eventTypes(sessions, session.id);
    expect(types).toContain('agent/error');
    expect(types).not.toContain('turn/start');
  });

  it('skips delivery-auto-prepare for a goal run (goal never gets delivery)', async () => {
    const { repositories, sessions, jobs, runner } = setup();
    await seedRun(repositories, 'run_goal', 'passed', 'goal');
    const session = await seedSession(sessions, 'run_goal');
    await sessions.updateSessionStatus(session.id, 'done');

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
    });
    runner.start();
    const jobStatus = await waitForJob(jobs, job.id);

    // goal short-circuits to done without touching delivery or emitting events.
    expect(jobStatus).toBe('done');
    expect(await repositories.getDeliveryPullRequest('run_goal')).toBeNull();
    const types = await eventTypes(sessions, session.id);
    expect(types).not.toContain('delivery/prepared');
  });

  it('readiness-evaluate emits readiness/evaluated with checks', async () => {
    const { repositories, sessions, jobs, runner } = setup();
    await seedRun(repositories, 'run_ready', 'passed');
    const session = await seedSession(sessions, 'run_ready');

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'readiness-evaluate',
    });
    runner.start();
    const jobStatus = await waitForJob(jobs, job.id);

    expect(jobStatus).toBe('done');
    const events = await sessions.listEventsSince(session.id, 0);
    const readiness = events.find((e) => e.type === 'readiness/evaluated');
    expect(readiness).toBeTruthy();
    const payload = readiness!.payload as {
      runId: string;
      ready: boolean;
      checks: unknown[];
    };
    expect(payload.runId).toBe('run_ready');
    expect(typeof payload.ready).toBe('boolean');
    expect(Array.isArray(payload.checks)).toBe(true);
  });
});
