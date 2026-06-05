import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createGateEngine,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('schema gate', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('passes only when the required artifact exists and records the gate result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-schema-gate-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const engine = createGateEngine({ repositories });

    const missing = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: { type: 'schema', artifactType: 'prd' },
      cwd: repoPath,
      outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'gates'),
      policy: { allow: [], deny: [], requiresHumanApproval: [], cwdScope: [repoPath], network: 'disabled' },
    });
    expect(missing).toMatchObject({ status: 'failed', failureClassification: 'missing-artifact' });

    await artifactStore.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      content: '# PRD\n\nValid artifact.',
    });
    const passed = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: { type: 'schema', artifactType: 'prd' },
      cwd: repoPath,
      outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'gates'),
      policy: { allow: [], deny: [], requiresHumanApproval: [], cwdScope: [repoPath], network: 'disabled' },
    });

    expect(passed).toMatchObject({ status: 'passed' });
    expect(await repositories.listGateResults('run_1')).toHaveLength(2);
    db.close();
  });

  it('fails when the artifact content does not satisfy the built-in schema', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-schema-invalid-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const engine = createGateEngine({ repositories });

    await artifactStore.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      content: '# PRD\n',
    });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: { type: 'schema', artifactType: 'prd' },
      cwd: repoPath,
      outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'gates'),
      policy: { allow: [], deny: [], requiresHumanApproval: [], cwdScope: [repoPath], network: 'disabled' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      failureClassification: 'invalid-artifact',
    });
    db.close();
  });
});

async function createRunFixture(repositories: ReturnType<typeof createRepositories>, repoPath: string) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Schema gate',
    body: 'Validate artifacts.',
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
