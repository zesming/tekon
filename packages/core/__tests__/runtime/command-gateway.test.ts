import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('command gateway', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects dangerous commands and shell metacharacters before spawn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-command-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    const policy = {
      allow: [{ tool: 'git', args: [] }],
      deny: [{ tool: 'git', args: ['push', '--force'] }],
      cwdScope: [cwd],
      network: 'disabled' as const,
    };

    await expect(
      gateway.run({ command: { tool: 'rm', args: ['-rf', cwd] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({ command: { tool: 'git', args: ['push', '--force'] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({ command: { tool: 'git', args: ['status', ';', 'rm'] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({ command: { tool: '/bin/git', args: ['status'] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({ command: { tool: 'rm', args: ['-r', '-f', cwd] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: { tool: 'git', args: ['push', 'origin', 'main', '--force-with-lease'] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });

    expect(spawnCalls).toBe(0);
  });

  it('does not treat an empty allow list as allow all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-command-empty-allow-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd,
        policy: { allow: [], deny: [], cwdScope: [cwd], network: 'disabled' },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('blocks cwd outside policy scope before spawn', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'donkey-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'donkey-outside-'));
    tempDirs.push(allowed, outside);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd: outside,
        policy: { allow: [{ tool: 'git', args: [] }], deny: [], cwdScope: [allowed], network: 'disabled' },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('creates a pending human decision and does not spawn when approval is required', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-approval-'));
    tempDirs.push(cwd);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, cwd);
    let spawnCalls = 0;

    const gateway = createCommandGateway({
      repositories,
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    const result = await gateway.run({
      command: { tool: 'git', args: ['push'] },
      cwd,
      runId: 'run_1',
      nodeId: 'node_1',
      policy: {
        allow: [{ tool: 'git', args: [] }],
        deny: [],
        requiresHumanApproval: [{ tool: 'git', args: ['push'] }],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ status: 'blocked-for-approval' });
    expect(await repositories.listHumanDecisions('run_1')).toMatchObject([
      { nodeId: 'node_1', status: 'pending' },
    ]);
    expect(spawnCalls).toBe(0);
    db.close();
  });

  it('executes allowed argv commands and streams stdout and stderr to log files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-exec-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: ['-e', "process.stdout.write('hello\\n')\nprocess.stderr.write('warn\\n')"],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ status: 'executed', exitCode: 0, timedOut: false });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    expect(readFileSync(result.stdoutPath, 'utf8')).toContain('hello');
    expect(readFileSync(result.stderrPath, 'utf8')).toContain('warn');
  });
});

async function createRunFixture(repositories: ReturnType<typeof createRepositories>, repoPath: string) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Command run',
    body: 'Run a command.',
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
