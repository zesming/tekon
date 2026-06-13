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

  it('returns null when no running node exists in a running or paused workflow', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_2',
      title: 'No running node',
      body: 'Workflow is running, but node is passed.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_2',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_2',
      projectId: 'project_2',
      demandId: 'demand_2',
      status: 'running',
      currentNodeId: 'node_a',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_a',
      runId: 'run_2',
      role: 'rd',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    const recovery = await repositories.findRecoverableRun('run_2');

    expect(recovery).toBeNull();

    db.close();
  });

  it('returns recovery info with null interruptedRoleRunId when node is running but no role run exists', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_3',
      title: 'Running node, no role run',
      body: 'Node is running but no RoleRun was ever started.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_3',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_3',
      projectId: 'project_3',
      demandId: 'demand_3',
      status: 'running',
      currentNodeId: 'node_b',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_b',
      runId: 'run_3',
      role: 'rd',
      status: 'running',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    const recovery = await repositories.findRecoverableRun('run_3');

    expect(recovery).toMatchObject({
      runId: 'run_3',
      nodeId: 'node_b',
      role: 'rd',
      interruptedRoleRunId: null,
    });

    db.close();
  });

  it('finds a recoverable run when the workflow is paused', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_4',
      title: 'Paused workflow',
      body: 'Workflow paused mid-execution.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_4',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_4',
      projectId: 'project_4',
      demandId: 'demand_4',
      status: 'paused',
      currentNodeId: 'node_c',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_c',
      runId: 'run_4',
      role: 'pm',
      status: 'running',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createRoleRun({
      id: 'role_run_pm',
      runId: 'run_4',
      nodeId: 'node_c',
      role: 'pm',
      status: 'running',
      startedAt: '2026-06-05T00:00:01.000Z',
    });

    const recovery = await repositories.findRecoverableRun('run_4');

    expect(recovery).toMatchObject({
      runId: 'run_4',
      nodeId: 'node_c',
      role: 'pm',
      interruptedRoleRunId: 'role_run_pm',
    });
    expect(await repositories.getRoleRun('role_run_pm')).toMatchObject({
      status: 'interrupted',
    });

    db.close();
  });

  it('returns null when runId is not passed and no running workflow exists', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    await repositories.createDemand({
      id: 'demand_5',
      title: 'Completed run',
      body: 'This run completed successfully.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_5',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_5',
      projectId: 'project_5',
      demandId: 'demand_5',
      status: 'passed',
      currentNodeId: null,
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_d',
      runId: 'run_5',
      role: 'rd',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    const recovery = await repositories.findRecoverableRun();

    expect(recovery).toBeNull();

    db.close();
  });
});
