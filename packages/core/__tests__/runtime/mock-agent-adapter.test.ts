import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createMockAgentAdapter,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('mock agent adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes deterministic artifacts for all built-in artifact types', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-mock-agent-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const adapter = createMockAgentAdapter();

    const result = await adapter.runAgent({
      roleConfig: { role: 'rd' },
      prompt: 'Implement feature',
      worktreeLease: {
        id: 'lease_1',
        runId: 'run_1',
        nodeId: 'node_1',
        role: 'rd',
        repoPath,
        worktreePath: repoPath,
        branchName: 'donkey/run_1/node_1-rd',
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'agent'),
      commandPolicy: { allow: [], deny: [], requiresHumanApproval: [], cwdScope: [repoPath], network: 'disabled' },
      runContext: {
        runId: 'run_1',
        nodeId: 'node_1',
        projectId: 'project_1',
        repoPath,
        dataDir: '.donkey',
      },
      artifactStore,
    });

    expect(result).toMatchObject({ provider: 'mock', exitCode: 0 });
    expect(result.outputFiles).toHaveLength(9);
    expect((await repositories.listArtifacts('run_1', 'node_1')).map((item) => item.type).sort()).toEqual([
      'code-changes',
      'delivery-package',
      'demand-card',
      'prd',
      'review-report',
      'rollback-plan',
      'security-report',
      'tech-design',
      'test-report',
    ]);
    db.close();
  });
});

async function createRunFixture(repositories: ReturnType<typeof createRepositories>, repoPath: string) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Mock agent run',
    body: 'Run the mock agent.',
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
