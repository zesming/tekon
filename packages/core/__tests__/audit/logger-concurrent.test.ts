import { describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createRepositories,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type TekonRepositories,
} from '../../src/index.js';

async function seedRun(repositories: TekonRepositories): Promise<void> {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Audit run',
    body: 'Concurrent append chain.',
    createdAt: '2026-08-21T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
    createdAt: '2026-08-21T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  });
}

describe('audit logger with shared write queue (S6/MF4)', () => {
  it('keeps the hash chain valid under 100 concurrent appends on the same run', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    await seedRun(repositories);
    const logger = createAuditLogger({ repositories, db, writeQueue });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        logger.append({
          runId: 'run_1',
          type: 'node.started',
          payload: { index },
        }),
      ),
    );
    expect(results).toHaveLength(100);

    expect(await logger.verify('run_1')).toMatchObject({ valid: true });

    const events = await repositories.listAuditEvents('run_1');
    expect(events).toHaveLength(100);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prevHash).toBe(events[i - 1].hash);
    }

    db.close();
  });

  it('keeps the legacy two-phase path when db and writeQueue are not injected', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const logger = createAuditLogger({ repositories });

    const first = await logger.append({
      runId: 'run_1',
      type: 'run.started',
      payload: { mode: 'cli' },
      createdAt: '2026-08-21T00:00:01.000Z',
    });
    const second = await logger.append({
      runId: 'run_1',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-08-21T00:00:02.000Z',
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(await logger.verify('run_1')).toMatchObject({ valid: true });

    db.close();
  });
});
