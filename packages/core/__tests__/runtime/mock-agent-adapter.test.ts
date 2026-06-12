import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createMockAgentAdapter,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('mock agent adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes deterministic artifacts for all built-in artifact types', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-mock-agent-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
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
        branchName: 'tekon/run_1/node_1-rd',
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'agent'),
      commandPolicy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
      runContext: {
        runId: 'run_1',
        nodeId: 'node_1',
        projectId: 'project_1',
        repoPath,
        dataDir: '.tekon',
      },
      artifactStore,
    });

    expect(result).toMatchObject({ provider: 'mock', exitCode: 0 });
    expect(result.outputFiles).toHaveLength(20);
    expect(
      (await repositories.listArtifacts('run_1', 'node_1'))
        .map((item) => item.type)
        .sort(),
    ).toEqual([
      'ac-evidence',
      'code-changes',
      'code-review',
      'delivery-package',
      'demand-card',
      'demand-review',
      'implementation-plan',
      'prd',
      'process-checkpoint',
      'qa-release-signoff',
      'qa-release-signoff-review',
      'requirement-interface-review',
      'review-report',
      'rollback-plan',
      'security-report',
      'tech-design',
      'technical-review',
      'test-plan',
      'test-plan-review',
      'test-report',
    ]);
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Mock agent run',
    body: 'Run the mock agent.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
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
