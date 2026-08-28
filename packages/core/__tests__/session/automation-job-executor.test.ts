import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAutomationJobExecutor,
  createAuditLogger,
  createJobRepository,
  createJobRunner,
  createRepositories,
  createRoutingJobExecutor,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWorkflowJobExecutor,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type AuditLogger,
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
const tempDirs: string[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    try {
      await runner.stop();
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function setup(projectRoot = '/tmp/tekon-automation-test') {
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
    projectRoot,
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

// Seeds a run that passes assertPrePullRequestReady (mirrors the pr-package
// fixture): passed run + delivery node + prd/test-report/qa-signoff artifacts +
// the full governance + qa gate set. createPullRequestPreparation does no git
// I/O, so no real remote is needed — only the repoPath for the package artifact.
async function seedDeliveryReadyRun(
  repositories: TekonRepositories,
  audit: AuditLogger,
  repoPath: string,
  runId: string,
): Promise<void> {
  const now = '2026-06-05T00:00:00.000Z';
  await repositories.createDemand({
    id: `demand_${runId}`,
    title: 'Add retry action',
    body: 'Add a safe retry action for failed tasks.',
    createdAt: now,
  });
  await repositories.createProject({
    id: `project_${runId}`,
    name: 'fixture',
    repoPath,
    createdAt: now,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: `project_${runId}`,
    demandId: `demand_${runId}`,
    status: 'passed',
    kind: 'workflow',
    createdAt: now,
    updatedAt: now,
  });
  await repositories.createNode({
    id: 'node_delivery',
    runId,
    role: 'pmo',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: now,
    updatedAt: now,
  });
  const store = createArtifactStore({ repoPath, repositories });
  await audit.append({
    runId,
    type: 'run.started',
    payload: { templateId: 'standard-delivery', mode: 'template' },
    createdAt: '2026-06-05T00:00:00.100Z',
  });
  await store.writeArtifact({
    runId,
    nodeId: 'node_delivery',
    type: 'prd',
    content: JSON.stringify({
      title: 'PRD',
      body: 'Retry requirements.',
      acceptanceCriteria: [{ id: 'AC-1', description: 'Retry can be validated.' }],
    }),
  });
  await store.writeArtifact({
    runId,
    nodeId: 'node_delivery',
    type: 'test-report',
    content: JSON.stringify({
      title: 'Test report',
      body: 'passed',
      criteriaEvidence: [
        {
          criterionId: 'AC-1',
          status: 'passed',
          evidence: 'Unit validation passed.',
          gateResultIds: ['gate_1'],
        },
      ],
    }),
  });
  await store.writeArtifact({
    runId,
    nodeId: 'node_delivery',
    type: 'qa-release-signoff',
    content: JSON.stringify({
      title: 'QA signoff',
      body: 'QA validated the delivered branch.',
      targetRef: `branch:tekon-delivery/${runId}`,
      validatedRef: `branch:tekon-delivery/${runId}`,
      overallStatus: 'passed',
      criteriaEvidence: [
        {
          criterionId: 'AC-1',
          status: 'passed',
          evidence: `QA validation passed for branch:tekon-delivery/${runId}.`,
          gateResultIds: ['gate_1'],
        },
      ],
    }),
  });
  await audit.append({
    runId,
    type: 'qa.validation.ref',
    payload: { nodeId: 'node_delivery', ref: `branch:tekon-delivery/${runId}` },
    createdAt: '2026-06-05T00:00:01.250Z',
  });
  const gates: Array<[string, string, string?]> = [
    ['gate_1', 'test'],
    ['gate_e2e', 'e2e-pass', 'skipped'],
    ['gate_security', 'security-scan'],
    ['gate_independent-review', 'independent-review'],
    ['gate_role-scope', 'role-scope'],
    ['gate_ac-evidence', 'ac-evidence'],
    ['gate_process-completeness', 'process-completeness'],
    ['gate_qa_signoff', 'qa-signoff'],
  ];
  for (const [index, [id, gateType, status]] of gates.entries()) {
    await repositories.recordGateResult({
      id,
      runId,
      nodeId: 'node_delivery',
      gateType,
      status: status ?? 'passed',
      durationMs: 1,
      retries: 0,
      ...(status === 'skipped'
        ? { failureClassification: 'not-applicable' }
        : {}),
      createdAt: `2026-06-05T00:00:01.${100 + index}Z`,
    });
  }
  await audit.append({
    runId,
    type: 'run.passed',
    payload: {},
    createdAt: '2026-06-05T00:00:02.000Z',
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
  // Review M1 regression: a runner wired with the routing executor (as the CLI
  // now is) must send an automation-kind job to the automation executor, NOT
  // the workflow executor. The workflow executor sets session 'active' before
  // its kind switch and would throw on the unknown kind → flip the session to
  // 'failed', polluting an already-passed run's session cross-process. This
  // reproduces "web enqueues delivery-auto-prepare, leaves it queued, CLI runner
  // claims it".
  it('M1 cross-process: routing executor keeps a stray automation job off the workflow path', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-routing-m1-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    const routing = createRoutingJobExecutor({
      workflow: createWorkflowJobExecutor({
        repositories,
        audit,
        projectContext: { projectRoot: repoPath },
        sessions,
        bus,
        registry,
      }),
      automation: createAutomationJobExecutor({
        repositories,
        audit,
        sessions,
        bus,
        projectRoot: repoPath,
      }),
    });
    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: routing,
      pollIntervalMs: 5,
      heartbeatMs: 30,
      leaseTtlMs: 30_000,
      workerId: 'worker_routing_m1',
    });
    runners.push(runner);

    // A run that passed and whose session is done — the state a web run leaves
    // behind. The delivery-auto-prepare job is NOT delivery-ready, so it fails
    // inside the automation executor (self-caught).
    await seedRun(repositories, 'run_m1', 'passed');
    const session = await seedSession(sessions, 'run_m1');
    await sessions.updateSessionStatus(session.id, 'done');

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
    });
    runner.start();
    expect(await waitForJob(jobs, job.id)).toBe('failed');

    // Session stays done, run stays passed — the workflow executor's
    // active→failed pollution path was never taken (no turn/start emitted).
    expect((await sessions.findSessionByRunId('run_m1'))?.status).toBe('done');
    expect((await repositories.getWorkflowInstance('run_m1'))?.status).toBe(
      'passed',
    );
    const types = await eventTypes(sessions, session.id);
    expect(types).not.toContain('turn/start');
    expect(types).toContain('agent/error');
  }, 15_000);

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

  it('auto-prepares a delivery-ready run: writes prepared + emits delivery/prepared, never created', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-auto-prepare-'));
    tempDirs.push(repoPath);
    const { repositories, audit, sessions, jobs, runner } = setup(repoPath);
    await seedDeliveryReadyRun(repositories, audit, repoPath, 'run_ready_prep');
    const session = await seedSession(sessions, 'run_ready_prep');
    await sessions.updateSessionStatus(session.id, 'done');

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
    });
    runner.start();
    expect(await waitForJob(jobs, job.id)).toBe('done');

    // The delivery row is `prepared` — never `created` (governance red line:
    // auto-prepare must NEVER create a PR).
    const delivery = await repositories.getDeliveryPullRequest('run_ready_prep');
    expect(delivery?.status).toBe('prepared');
    expect(delivery?.prUrl).toBeNull();
    const types = await eventTypes(sessions, session.id);
    expect(types).toContain('delivery/prepared');
    expect(types).not.toContain('delivery/pr-created');
    // Run stays passed, session stays done.
    expect(
      (await repositories.getWorkflowInstance('run_ready_prep'))?.status,
    ).toBe('passed');
    expect((await sessions.findSessionByRunId('run_ready_prep'))?.status).toBe(
      'done',
    );
  }, 15_000);

  it('S2: re-preparing a failed delivery row preserves a prior human approval', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-auto-prepare-s2-'));
    tempDirs.push(repoPath);
    const { repositories, audit, sessions, jobs, runner } = setup(repoPath);
    await seedDeliveryReadyRun(repositories, audit, repoPath, 'run_s2');
    const session = await seedSession(sessions, 'run_s2');
    await sessions.updateSessionStatus(session.id, 'done');

    // A prior delivery attempt was human-approved, then failed at push/create.
    // (approve → push failed leaves status=failed with the approval recorded.)
    const seededAt = '2026-06-05T00:00:03.000Z';
    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_run_s2',
      runId: 'run_s2',
      branch: 'tekon-delivery/run_s2',
      baseBranch: 'main',
      title: 'prior attempt',
      bodyPath: null,
      remoteName: null,
      remoteUrl: null,
      status: 'failed',
      prUrl: null,
      approvedBy: 'release-manager',
      approvedAt: seededAt,
      branchPushedAt: null,
      prCreatedAt: null,
      failureStage: 'push',
      lastError: 'push rejected',
      attemptCount: 1,
      createdAt: seededAt,
      updatedAt: seededAt,
    });

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
    });
    runner.start();
    expect(await waitForJob(jobs, job.id)).toBe('done');

    // Auto-prepare re-prepared (failed → prepared) but did NOT revoke the human
    // approval — nulling it would silently force re-approval (S2).
    const delivery = await repositories.getDeliveryPullRequest('run_s2');
    expect(delivery?.status).toBe('prepared');
    expect(delivery?.approvedBy).toBe('release-manager');
    expect(delivery?.approvedAt).toBe(seededAt);
  }, 15_000);

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

  // F-04 (§0.3 fake-pass guard): if the engine ever returns a non-terminal
  // workflow status (running/pending — a contract breach), the executor MUST
  // fail loudly (job failed + agent/error preserving the status), never map it
  // to done/idle. Locks the default branch of settleByWorkflowStatus so a
  // future refactor cannot silently reintroduce a false pass.
  it('F-04: a non-terminal engine result fails the job and emits agent/error (no fake pass)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-fakepass-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();

    await seedRun(repositories, 'run_fakepass', 'running');
    const session = await seedSession(sessions, 'run_fakepass');

    const executor = createWorkflowJobExecutor({
      repositories,
      audit,
      projectContext: { projectRoot: repoPath },
      sessions,
      bus,
      registry,
      // Contract-breaching engine: returns a still-`running` workflow.
      engineFactory: async () => ({
        async executePreparedRun() {
          return (await repositories.getWorkflowInstance('run_fakepass'))!;
        },
        async resumeRun() {
          return {
            workflow: (await repositories.getWorkflowInstance('run_fakepass'))!,
          };
        },
      }),
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
      workerId: 'worker_fakepass',
    });
    runners.push(runner);

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });
    runner.start();

    // The non-terminal status must settle the job as failed, NOT done.
    expect(await waitForJob(jobs, job.id)).toBe('failed');
    const types = await eventTypes(sessions, session.id);
    expect(types).toContain('agent/error');
    expect((await sessions.findSessionByRunId('run_fakepass'))?.status).toBe(
      'failed',
    );
    // The unexpected status is preserved in the durable event trail.
    const events = await sessions.listEventsSince(session.id, 0);
    const errorEvent = events.find((e) => e.type === 'agent/error');
    expect(JSON.stringify(errorEvent?.payload)).toContain('running');
  }, 15_000);
});
