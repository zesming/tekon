import { describe, expect, it } from 'vitest';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('run recovery', () => {
  it('returns the running node as resume point and interrupts stale role runs', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_1',
      title: 'Recover run',
      body: 'Recover after process exit.',
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
      currentNodeId: 'node_rd',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_pm',
      runId: 'run_1',
      role: 'pm',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_rd',
      runId: 'run_1',
      role: 'rd',
      status: 'running',
      gates: [],
      dependencies: ['node_pm'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createRoleRun({
      id: 'role_run_rd',
      runId: 'run_1',
      nodeId: 'node_rd',
      role: 'rd',
      status: 'running',
      startedAt: '2026-06-05T00:00:01.000Z',
    });

    const recovery = await repositories.findRecoverableRun('run_1');

    expect(recovery).toMatchObject({
      runId: 'run_1',
      nodeId: 'node_rd',
      role: 'rd',
      interruptedRoleRunId: 'role_run_rd',
    });
    expect(await repositories.getRoleRun('role_run_rd')).toMatchObject({
      status: 'interrupted',
    });

    db.close();
  });
});
