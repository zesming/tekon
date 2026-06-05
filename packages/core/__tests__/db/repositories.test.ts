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

    expect(await repositories.getNode('node_1')).toMatchObject({ status: 'running' });
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
});
