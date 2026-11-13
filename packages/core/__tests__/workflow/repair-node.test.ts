import { describe, expect, it } from 'vitest';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';
import { createAutoFixRepairNode } from '../../src/workflow/repair-node.js';

describe('createAutoFixRepairNode', () => {
  it('creates a pending repair node linked to the failed gate result', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Repair',
      body: 'Repair a failed gate.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_1',
      name: 'tekon',
      repoPath: '/repo',
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
      status: 'running',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });

    const repair = await createAutoFixRepairNode(repositories, {
      failedGateResult: {
        id: 'gate_failed',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'test',
        status: 'failed',
        durationMs: 1,
        retries: 1,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      fixerRole: 'rd',
    });

    // The execution plan's completeness check derives this id from the gate result.
    const expected = {
      id: 'repair_gate_failed',
      runId: 'run_1',
      role: 'rd',
      status: 'pending',
      order: 0,
      inputs: [],
      outputs: [],
      gates: [],
      dependencies: ['node_1'],
    };
    expect(repair).toMatchObject(expected);
    expect(await repositories.getNode('repair_gate_failed')).toMatchObject(expected);
    db.close();
  });
});
