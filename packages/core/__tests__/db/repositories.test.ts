import { describe, expect, it } from 'vitest';

import {
  createRepositories,
  createWriteQueue,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('sqlite repositories', () => {
  it('persists projects, workflow instances, node transitions, gates, and audit events', async () => {
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_1',
      title: 'Status command',
      body: 'Show the current run status.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_1',
      name: 'donkey',
      repoPath: '/tmp/donkey',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'project_1',
      demandId: 'demand_1',
      status: 'running',
      currentNodeId: 'node_1',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_1',
      runId: 'run_1',
      role: 'rd',
      status: 'pending',
      gates: [{ type: 'test' }],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    await repositories.transitionNode('node_1', 'running');
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      status: 'passed',
      durationMs: 10,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.appendAuditEvent({
      id: 'event_1',
      runId: 'run_1',
      type: 'node.started',
      payload: { nodeId: 'node_1' },
      prevHash: null,
      hash: 'hash_1',
      createdAt: '2026-06-05T00:00:01.000Z',
    });

    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'running',
    });
    expect(await repositories.listGateResults('run_1')).toHaveLength(1);
    expect(await repositories.listAuditEvents('run_1')).toHaveLength(1);

    db.close();
  });

  it('serializes process-local writes through the write queue', async () => {
    const queue = createWriteQueue();
    const observed: number[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observed.push(1);
      }),
      queue.enqueue(async () => {
        observed.push(2);
      }),
    ]);

    expect(observed).toEqual([1, 2]);
  });

  it('persists delivery pull request status and recovery transitions', async () => {
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);

    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: 'donkey/run_1',
      baseBranch: 'main',
      title: 'Donkey delivery',
      bodyPath: '.donkey/runs/run_1/delivery/pr-body.md',
      remoteName: 'origin',
      remoteUrl: 'https://github.example/donkey.git',
      status: 'branch-pushed',
      approvedBy: 'cli',
      approvedAt: '2026-06-05T00:00:02.000Z',
      branchPushedAt: '2026-06-05T00:00:03.000Z',
      attemptCount: 1,
      createdAt: '2026-06-05T00:00:01.000Z',
      updatedAt: '2026-06-05T00:00:03.000Z',
    });

    await repositories.markDeliveryPullRequestFailed({
      runId: 'run_1',
      failureStage: 'create-pr',
      lastError: 'gh failed',
      failedAt: '2026-06-05T00:00:04.000Z',
    });

    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'create-pr',
      lastError: 'gh failed',
    });

    await repositories.markDeliveryPullRequestCreated({
      runId: 'run_1',
      prUrl: 'https://github.example/donkey/pull/1',
      createdAt: '2026-06-05T00:00:05.000Z',
    });

    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'created',
      prUrl: 'https://github.example/donkey/pull/1',
      prCreatedAt: '2026-06-05T00:00:05.000Z',
      failureStage: null,
      lastError: null,
    });

    db.close();
  });

  it('persists run provider snapshots and completed role runs for safe resume', async () => {
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    await repositories.createNode({
      id: 'node_1',
      runId: 'run_1',
      role: 'rd',
      status: 'running',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    await repositories.recordRunProviderConfig({
      runId: 'run_1',
      provider: 'claude-code',
      configSummary: { command: 'claude', timeoutMs: 300_000 },
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.createRoleRun({
      id: 'role_run_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      status: 'running',
      startedAt: '2026-06-05T00:00:02.000Z',
    });
    await repositories.markRoleRunCompleted({
      roleRunId: 'role_run_1',
      completedAt: '2026-06-05T00:00:03.000Z',
    });

    expect(await repositories.getRunProviderConfig('run_1')).toMatchObject({
      provider: 'claude-code',
      configSummary: { command: 'claude', timeoutMs: 300_000 },
    });
    expect(
      await repositories.getLatestRoleRunForNode('run_1', 'node_1'),
    ).toMatchObject({
      status: 'passed',
      completedAt: '2026-06-05T00:00:03.000Z',
    });
    db.close();
  });
});

async function seedRun(repositories: ReturnType<typeof createRepositories>) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Status command',
    body: 'Show the current run status.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'donkey',
    repoPath: '/tmp/donkey',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
