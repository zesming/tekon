import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('artifact store', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes versioned artifacts under .donkey and records metadata in sqlite', async () => {
    const { repoPath, repositories } = await createRunFixture(tempDirs);
    const store = createArtifactStore({ repoPath, repositories });

    const v1 = await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      content: '# PRD\n\nFirst version',
    });
    const v2 = await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      content: '# PRD\n\nSecond version',
      summary: 'explicit summary',
    });

    expect(v1.path).toBe('.donkey/runs/run_1/artifacts/node_1/prd.v1.md');
    expect(v2.path).toBe('.donkey/runs/run_1/artifacts/node_1/prd.v2.md');
    expect(existsSync(join(repoPath, v2.path))).toBe(true);
    expect(v1.summary).toBe('# PRD');
    expect(v2.summary).toBe('explicit summary');

    const stored = await repositories.listArtifacts('run_1', 'node_1', 'prd');
    expect(stored.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(readFileSync(join(repoPath, v1.path), 'utf8')).toContain('First version');
  });

  it('truncates oversized artifact content for prompt use and fails on missing files', async () => {
    const { repoPath, repositories } = await createRunFixture(tempDirs);
    const store = createArtifactStore({ repoPath, repositories, maxPromptChars: 12 });

    const artifact = await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'tech-design',
      content: '0123456789abcdefghijklmnopqrstuvwxyz',
    });

    expect(await store.readArtifactForPrompt(artifact)).toContain('[truncated artifact');

    unlinkSync(join(repoPath, artifact.path));
    await expect(store.readArtifact(artifact)).rejects.toThrow(/missing artifact file/u);
  });

  it('rejects unsafe run and node identifiers before writing files', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-artifact-path-'));
    tempDirs.push(repoPath);
    const fakeRepositories = {
      async listArtifacts() {
        return [];
      },
      async recordArtifact(artifact: unknown) {
        return artifact;
      },
    } as never;
    const store = createArtifactStore({ repoPath, repositories: fakeRepositories });

    await expect(
      store.writeArtifact({
        runId: '../escape',
        nodeId: 'node_1',
        type: 'prd',
        content: '# PRD\n\nbody',
      }),
    ).rejects.toThrow(/unsafe path segment/u);

    await expect(
      store.writeArtifact({
        runId: 'run_1',
        nodeId: '../escape',
        type: 'prd',
        content: '# PRD\n\nbody',
      }),
    ).rejects.toThrow(/unsafe path segment/u);

    expect(existsSync(join(repoPath, '..', 'escape'))).toBe(false);
  });
});

async function createRunFixture(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'donkey-artifacts-'));
  tempDirs.push(repoPath);
  const db = openDonkeyDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const repositories = createRepositories(db);

  await repositories.createDemand({
    id: 'demand_1',
    title: 'Artifact run',
    body: 'Create artifacts.',
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

  return { repoPath, repositories };
}
