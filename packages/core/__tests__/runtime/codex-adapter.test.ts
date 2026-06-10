import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCodexCommand,
  createArtifactStore,
  createCodexAdapter,
  createCommandGateway,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('codex adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('builds codex exec commands with Tekon-controlled sandbox and approval', () => {
    const command = buildCodexCommand(
      {
        provider: 'codex',
        command: 'codex',
        args: [],
        profile: 'internal',
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 1000,
        permissionProfile: safePermissionProfile('/tmp/repo'),
      },
      { prompt: 'implement fixture' },
    );

    expect(command.tool).toBe('codex');
    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'exec',
    ]);
    expect(command.stdin).toBe('implement fixture');
  });

  it('keeps codex exec first when safe user args are configured', () => {
    const command = buildCodexCommand(
      {
        provider: 'codex',
        command: 'codex',
        args: ['--model', 'gpt-5'],
        profile: 'internal',
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 1000,
        permissionProfile: safePermissionProfile('/tmp/repo'),
      },
      { prompt: 'implement fixture' },
    );

    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'exec',
      '--model',
      'gpt-5',
    ]);
  });

  it('defaults real Codex commands to the internal profile when a replayed config omits profile', () => {
    const command = buildCodexCommand(
      {
        provider: 'codex',
        command: 'codex',
        args: [],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 1000,
        permissionProfile: safePermissionProfile('/tmp/repo'),
      },
      { prompt: 'implement fixture' },
    );

    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'exec',
    ]);
  });

  it.each([
    ['--'],
    ['--sandbox'],
    ['-s'],
    ['-sread-only'],
    ['--sandbox=danger-full-access'],
    ['--ask-for-approval'],
    ['-a'],
    ['-anever'],
    ['--ask-for-approval=never'],
    ['--approval-policy'],
    ['--config'],
    ['-c'],
    ['-csandbox_workspace_write.network_access=true'],
    ['--config=sandbox_workspace_write.network_access=true'],
    ['--enable'],
    ['--disable'],
    ['--remote'],
    ['--remote-auth-token-env'],
    ['--cd'],
    ['-C'],
    ['-C/tmp'],
    ['--cd=/tmp'],
    ['--add-dir'],
    ['--add-dir=/tmp'],
    ['--profile'],
    ['-p'],
    ['-punsafe'],
    ['--profile=unsafe'],
    ['--image'],
    ['-i'],
    ['-i/tmp/outside.png'],
    ['--image=/tmp/outside.png'],
    ['--output-last-message'],
    ['-o'],
    ['-o/tmp/final.txt'],
    ['--output-last-message=/tmp/final.txt'],
    ['--output-schema'],
    ['--ignore-rules'],
    ['--ignore-user-config'],
    ['--skip-git-repo-check'],
    ['--ephemeral'],
    ['--search'],
    ['--oss'],
    ['--local-provider'],
    ['resume'],
    ['review'],
    ['help'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--dangerously-bypass-hook-trust'],
    ['--yolo'],
    ['danger-full-access'],
  ])('rejects unsafe user Codex args %j', (arg) => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [arg],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        { prompt: 'hello' },
      ),
    ).toThrow(/codex sandbox, approval, filesystem, and config boundaries/u);
  });

  it('rejects unsafe Tekon-controlled Codex profile names', () => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          profile: 'internal;rm',
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        { prompt: 'hello' },
      ),
    ).toThrow(/codex profile must be a safe profile name/u);
  });

  it('passes prompts through stdin when promptMode is stdin', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-stdin-'));
    tempDirs.push(repoPath);
    const stdinScript = join(repoPath, 'stdin.mjs');
    writeFileSync(
      stdinScript,
      "let input = ''\nprocess.stdin.on('data', chunk => { input += chunk })\nprocess.stdin.on('end', () => { process.stdout.write(input) })\n",
      'utf8',
    );
    const adapter = createCodexAdapter(
      {
        provider: 'codex',
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
      provider: 'codex',
      exitCode: 0,
      timedOut: false,
    });
    expect(readFileSync(result.outputFiles[0]!, 'utf8')).toBe('stdin prompt');
  });

  it('reports provider command timeouts', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-timeout-'));
    tempDirs.push(repoPath);
    const timeoutScript = join(repoPath, 'timeout.mjs');
    writeFileSync(timeoutScript, 'setTimeout(() => {}, 5000);\n', 'utf8');
    const adapter = createCodexAdapter(
      {
        provider: 'codex',
        command: process.execPath,
        args: [timeoutScript],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 20,
        permissionProfile: safePermissionProfile(repoPath),
      },
      createCommandGateway(),
    );

    const result = await adapter.runAgent(baseRunInput(repoPath));

    expect(result).toMatchObject({
      provider: 'codex',
      exitCode: null,
      timedOut: true,
    });
  });

  it('ingests provider artifact manifests into the artifact store', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-artifacts-'));
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'artifact-writer.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: 'Code changes', body: 'Implemented Codex fixture change.' }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Implemented Codex fixture change.' }] }));",
      ].join('\n'),
      'utf8',
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const adapter = createCodexAdapter(
      {
        provider: 'codex',
        command: process.execPath,
        args: [artifactScript],
        promptMode: 'stdin',
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
      provider: 'codex',
      exitCode: 0,
      artifacts: [expect.objectContaining({ type: 'code-changes' })],
    });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'code-changes'),
    ).toHaveLength(1);
    db.close();
  });

  it('fails real provider runs when required artifact manifests are missing', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-missing-'));
    tempDirs.push(repoPath);
    const missingScript = join(repoPath, 'missing-manifest.mjs');
    writeFileSync(missingScript, 'process.exit(0)\n', 'utf8');
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const adapter = createCodexAdapter(
      {
        provider: 'codex',
        command: process.execPath,
        args: [missingScript],
        promptMode: 'stdin',
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
      provider: 'codex',
      exitCode: 1,
    });
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
    network: 'restricted' as const,
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
      branchName: 'tekon/run_1/node_1-rd',
      createdAt: '2026-06-10T00:00:00.000Z',
    },
    outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'agent'),
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
      dataDir: '.tekon',
    },
  };
}

async function seedRun(repositories: ReturnType<typeof createRepositories>) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Codex artifact manifest',
    body: 'Write code changes artifact.',
    createdAt: '2026-06-10T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
    createdAt: '2026-06-10T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
  });
}
