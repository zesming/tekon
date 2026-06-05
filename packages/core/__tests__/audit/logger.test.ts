import { describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('audit logger', () => {
  it('appends audit events as a hash chain and detects tampering', async () => {
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    const logger = createAuditLogger({ repositories });

    const first = await logger.append({
      runId: 'run_1',
      type: 'node.started',
      payload: { nodeId: 'node_1' },
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    const second = await logger.append({
      runId: 'run_1',
      type: 'gate.passed',
      payload: { gateType: 'schema' },
      createdAt: '2026-06-05T00:00:01.000Z',
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(await logger.verify('run_1')).toMatchObject({ valid: true });

    db.prepare('update audit_events set payload = ? where id = ?').run(
      JSON.stringify({ gateType: 'schema', tampered: true }),
      second.id,
    );

    expect(await logger.verify('run_1')).toMatchObject({
      valid: false,
      brokenEventId: second.id,
    });
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Audit run',
    body: 'Create audit chain.',
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
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
