import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  createGateEngine,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('gate engine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs command gates through CommandGateway and persists GateResult', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-gate-engine-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({
      repositories,
      gateway: createCommandGateway(),
    });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'test',
        command: {
          tool: process.execPath,
          args: ['-e', "process.stdout.write('ok\\n')"],
        },
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ gateType: 'test', status: 'passed' });
    expect(await repositories.listGateResults('run_1')).toMatchObject([
      { gateType: 'test', status: 'passed' },
    ]);
    db.close();
  });

  it('creates an autoFix repair node linked to a failed gate result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-gate-repair-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({ repositories });

    const repair = await engine.createAutoFixRepairNode({
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

    expect(repair).toMatchObject({
      role: 'rd',
      status: 'pending',
      dependencies: ['node_1'],
    });
    expect(await repositories.getNode(repair.id)).toMatchObject({ role: 'rd' });
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Gate engine',
    body: 'Run gates.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'donkey',
    repoPath,
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
