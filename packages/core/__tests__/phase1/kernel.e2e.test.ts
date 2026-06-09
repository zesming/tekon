import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertAgentProviderCapabilities,
  createArtifactStore,
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
  createMockAgentAdapter,
  createRepositories,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('phase 1 kernel e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs the safe recoverable kernel workflow through phase 1 exit gates', async () => {
    const repoPath = createTempGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);

    const gateway = createCommandGateway();
    const worktrees = createWorktreeManager({ repositories, gateway });
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const gateEngine = createGateEngine({ repositories, gateway });
    const audit = createAuditLogger({ repositories });
    const humanGate = createHumanGate({ repositories });

    await audit.append({
      runId: 'run_1',
      type: 'run.started',
      payload: { nodeId: 'node_1' },
      createdAt: '2026-06-05T00:00:00.000Z',
    });

    const lease = await worktrees.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      baseRef: 'HEAD',
    });
    expect(existsSync(lease.worktreePath)).toBe(true);

    const agent = createMockAgentAdapter();
    const agentResult = await agent.runAgent({
      roleConfig: { role: 'rd' },
      prompt: 'Implement a deterministic phase 1 fixture.',
      worktreeLease: lease,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'agent'),
      commandPolicy: {
        allow: [{ tool: 'git', args: [] }],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [lease.worktreePath],
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
    expect(agentResult).toMatchObject({ provider: 'mock', exitCode: 0 });
    expect(await repositories.listArtifacts('run_1', 'node_1')).toHaveLength(9);

    const schemaGate = await gateEngine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: { type: 'schema', artifactType: 'prd' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });
    expect(schemaGate).toMatchObject({ status: 'passed' });

    await audit.append({
      runId: 'run_1',
      type: 'gate.passed',
      payload: { gateType: 'schema', gateResultId: schemaGate.id },
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    expect(await audit.verify('run_1')).toMatchObject({ valid: true });

    let spawnCalls = 0;
    const rejectingGateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not happen');
      },
    });
    await expect(
      rejectingGateway.run({
        command: { tool: 'rm', args: ['-rf', repoPath] },
        cwd: repoPath,
        policy: {
          allow: [{ tool: 'rm', args: [] }],
          deny: [],
          requiresHumanApproval: [],
          cwdScope: [repoPath],
          network: 'disabled',
        },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);

    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      note: 'phase 1 checkpoint',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'paused',
    });
    await humanGate.approveHumanGate(decision.id, 'reviewer', 'approved');
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'running',
    });

    expect(() =>
      assertAgentProviderCapabilities({
        provider: 'claude-code',
        command: 'claude',
        promptMode: 'stdin',
        outputFormat: 'json',
      } as never),
    ).toThrow(/permission profile/u);

    await worktrees.releaseLease(lease.id);
    await worktrees.pruneStaleLeases(repoPath);
    expect(existsSync(lease.worktreePath)).toBe(false);

    db.close();
  });
});

function createTempGitRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-phase1-e2e-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'phase 1 fixture repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Phase 1 e2e',
    body: 'Run the phase 1 kernel.',
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
