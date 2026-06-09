import { describe, expect, it } from 'vitest';

import {
  createHumanGate,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('human gate', () => {
  it('pauses a workflow for human approval and resumes the blocked node', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    const humanGate = createHumanGate({ repositories });

    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      note: 'Needs review',
    });

    expect(decision).toMatchObject({ status: 'pending', nodeId: 'node_1' });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'paused',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'paused',
    });

    await humanGate.approveHumanGate(decision.id, 'zhaoensheng', 'approved');

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'approved',
      actor: 'zhaoensheng',
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'running',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'running',
    });
    db.close();
  });

  it('rejects a pending human decision and blocks the workflow', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      durationMs: 0,
      retries: 0,
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });

    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: 'gate_1',
      note: 'Needs review',
    });
    await humanGate.rejectHumanGate(decision.id, 'reviewer', 'rejected');

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'rejected',
      actor: 'reviewer',
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.listGateResults('run_1')).toContainEqual(
      expect.objectContaining({
        id: 'gate_1',
        status: 'failed',
        failureClassification: 'human-rejected',
      }),
    );
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Human gate',
    body: 'Pause for approval.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
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
    role: 'reviewer',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
