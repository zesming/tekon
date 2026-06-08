import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeCodeCommand,
  createArtifactStore,
  createClaudeCodeAdapter,
  createCommandGateway,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('claude code adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('builds permission-aware commands without bypassPermissions by default', () => {
    const command = buildClaudeCodeCommand(
      {
        provider: 'claude-code',
        command: 'claude',
        args: [],
        promptMode: 'arg-append',
        outputFormat: 'json',
        timeoutMs: 1000,
        permissionProfile: safePermissionProfile('/tmp/repo'),
      },
      { prompt: 'hello' },
    );

    expect(command.args).toContain('--output-format');
    expect(command.args).toContain('json');
    expect(command.args.join(' ')).not.toContain('bypassPermissions');
    expect(command.args.at(-1)).toBe('hello');
  });

  it.each([
    {
      args: ['--permission-mode'],
      message: 'permission mode is controlled by Donkey',
    },
    {
      args: ['--permission-mode', 'bypassPermissions'],
      message: 'permission mode is controlled by Donkey',
    },
    {
      args: ['--permission-mode=bypassPermissions'],
      message: 'permission mode is controlled by Donkey',
    },
    {
      args: ['--dangerously-skip-permissions'],
      message: 'bypass permissions mode is not allowed',
    },
    {
      args: ['bypassPermissions'],
      message: 'bypass permissions mode is not allowed',
    },
    {
      args: ['--mode=bypassPermissions'],
      message: 'bypass permissions mode is not allowed',
    },
  ])('rejects unsafe user Claude args %j', ({ args, message }) => {
    const safeConfig = {
      provider: 'claude-code' as const,
      command: 'claude',
      args,
      promptMode: 'stdin' as const,
      outputFormat: 'json' as const,
      timeoutMs: 1000,
      permissionProfile: safePermissionProfile('/tmp/repo'),
    };

    expect(() =>
      buildClaudeCodeCommand(safeConfig, { prompt: 'hello' }),
    ).toThrow(message);
  });

  it('streams large stdout/stderr without deadlock and reports timeout', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-claude-agent-'));
    tempDirs.push(repoPath);
    const loudScript = join(repoPath, 'loud.mjs');
    const sleepScript = join(repoPath, 'sleep.mjs');
    writeFileSync(
      loudScript,
      "process.stdout.write('x'.repeat(128 * 1024))\nprocess.stderr.write('y'.repeat(128 * 1024))\n",
      'utf8',
    );
    writeFileSync(sleepScript, 'setTimeout(() => {}, 10_000)\n', 'utf8');
    const gateway = createCommandGateway();

    const loudAdapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [loudScript],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 2_000,
        permissionProfile: safePermissionProfile(repoPath),
      },
      gateway,
    );
    const loudResult = await loudAdapter.runAgent(baseRunInput(repoPath));
    expect(loudResult).toMatchObject({
      provider: 'claude-code',
      exitCode: 0,
      timedOut: false,
    });

    const sleepAdapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [sleepScript],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 50,
        permissionProfile: safePermissionProfile(repoPath),
      },
      gateway,
    );
    const sleepResult = await sleepAdapter.runAgent(baseRunInput(repoPath));
    expect(sleepResult).toMatchObject({
      provider: 'claude-code',
      timedOut: true,
    });
  });

  it('passes prompts through stdin when promptMode is stdin', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-claude-stdin-'));
    tempDirs.push(repoPath);
    const stdinScript = join(repoPath, 'stdin.mjs');
    writeFileSync(
      stdinScript,
      "let input = ''\nprocess.stdin.on('data', chunk => { input += chunk })\nprocess.stdin.on('end', () => { process.stdout.write(input) })\n",
      'utf8',
    );
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [stdinScript],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: safePermissionProfile(repoPath),
      },
      createCommandGateway(),
    );

    const result = await adapter.runAgent({
      ...baseRunInput(repoPath),
      prompt: 'stdin prompt',
    });

    expect(result).toMatchObject({
      provider: 'claude-code',
      exitCode: 0,
      timedOut: false,
    });
    expect(readFileSync(result.outputFiles[0]!, 'utf8')).toBe('stdin prompt');
  });

  it('ingests provider artifact manifests into the artifact store', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-claude-artifacts-'));
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'artifact-writer.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.DONKEY_OUTPUT_DIR;',
        'const manifestPath = process.env.DONKEY_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: 'Code changes', body: 'Implemented fixture change.' }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Implemented fixture change.' }] }));",
      ].join('\n'),
      'utf8',
    );
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [artifactScript],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: safePermissionProfile(repoPath),
      },
      createCommandGateway(),
    );

    const result = await adapter.runAgent({
      ...baseRunInput(repoPath),
      artifactStore,
      requiredArtifactTypes: ['code-changes'],
    });

    expect(result).toMatchObject({
      provider: 'claude-code',
      exitCode: 0,
      artifacts: [expect.objectContaining({ type: 'code-changes' })],
    });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'code-changes'),
    ).toHaveLength(1);
    db.close();
  });

  it('fails real provider runs when required artifact manifests are missing or invalid', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'donkey-claude-artifact-fail-'),
    );
    tempDirs.push(repoPath);
    const missingScript = join(repoPath, 'missing-manifest.mjs');
    const invalidScript = join(repoPath, 'invalid-artifact.mjs');
    writeFileSync(missingScript, 'process.exit(0)\n', 'utf8');
    writeFileSync(
      invalidScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.DONKEY_OUTPUT_DIR;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: '', body: '' }));",
        "writeFileSync(process.env.DONKEY_ARTIFACT_MANIFEST, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json' }] }));",
      ].join('\n'),
      'utf8',
    );
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });

    for (const script of [missingScript, invalidScript]) {
      const adapter = createClaudeCodeAdapter(
        {
          provider: 'claude-code',
          command: process.execPath,
          args: [script],
          promptMode: 'arg-append',
          outputFormat: 'text',
          timeoutMs: 500,
          permissionProfile: safePermissionProfile(repoPath),
        },
        createCommandGateway(),
      );
      const result = await adapter.runAgent({
        ...baseRunInput(repoPath),
        outputDir: join(
          repoPath,
          '.donkey',
          'runs',
          'run_1',
          `agent-${script === missingScript ? 'missing' : 'invalid'}`,
        ),
        artifactStore,
        requiredArtifactTypes: ['code-changes'],
      });
      expect(result).toMatchObject({
        provider: 'claude-code',
        exitCode: 1,
      });
    }
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'code-changes'),
    ).toHaveLength(0);
    db.close();
  });
});

function safePermissionProfile(repoPath: string) {
  return {
    sandbox: 'workspace-write' as const,
    approval: 'on-request' as const,
    filesystemScope: [repoPath],
    network: 'disabled' as const,
    tools: { allow: ['Read', 'Edit', 'Bash(git *)'], deny: ['Bash(rm *)'] },
  };
}

function baseRunInput(repoPath: string) {
  return {
    roleConfig: { role: 'rd' as const },
    prompt: 'fixture prompt',
    worktreeLease: {
      id: 'lease_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd' as const,
      repoPath,
      worktreePath: repoPath,
      branchName: 'donkey/run_1/node_1-rd',
      createdAt: '2026-06-05T00:00:00.000Z',
    },
    outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'agent'),
    commandPolicy: {
      allow: [{ tool: process.execPath, args: [] }],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: [repoPath],
      network: 'disabled' as const,
    },
    runContext: {
      runId: 'run_1',
      nodeId: 'node_1',
      projectId: 'project_1',
      repoPath,
      dataDir: '.donkey',
    },
  };
}

async function seedRun(repositories: ReturnType<typeof createRepositories>) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Artifact manifest',
    body: 'Write code changes artifact.',
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
