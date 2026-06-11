import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCodexCommand,
  type CommandGateway,
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
    const artifactOutputDir = '/tmp/repo/.tekon/runs/run_1/node_1';
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
      {
        artifactOutputDir,
        prompt: 'implement fixture',
        runContext: { runId: 'run_1', nodeId: 'node_1' },
      },
    );

    expect(command.tool).toBe('codex');
    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--add-dir',
      artifactOutputDir,
      'exec',
    ]);
    expect(command.stdin).toBe('implement fixture');
  });

  it('keeps codex exec first when safe user args are configured', () => {
    const artifactOutputDir = '/tmp/repo/.tekon/runs/run_1/node_1';
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
      {
        artifactOutputDir,
        prompt: 'implement fixture',
        runContext: { runId: 'run_1', nodeId: 'node_1' },
      },
    );

    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--add-dir',
      artifactOutputDir,
      'exec',
      '--model',
      'gpt-5',
    ]);
  });

  it('defaults real Codex commands to the internal profile when a replayed config omits profile', () => {
    const artifactOutputDir = '/tmp/repo/.tekon/runs/run_1/node_1';
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
      {
        artifactOutputDir,
        prompt: 'implement fixture',
        runContext: { runId: 'run_1', nodeId: 'node_1' },
      },
    );

    expect(command.args).toEqual([
      '--profile',
      'internal',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--add-dir',
      artifactOutputDir,
      'exec',
    ]);
  });

  it('requires a Tekon artifact output directory for real Codex commands', () => {
    expect(() =>
      buildCodexCommand(
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
      ),
    ).toThrow(/codex artifact output directory is required/u);
  });

  it('rejects real Codex artifact output directories outside Tekon run storage', () => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        { artifactOutputDir: '/tmp/repo/outside', prompt: 'implement fixture' },
      ),
    ).toThrow(
      /codex artifact output directory must be under Tekon run storage/u,
    );
  });

  it('rejects nested Tekon run-like artifact output directories outside the repo data root', () => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        {
          artifactOutputDir: '/tmp/repo/packages/app/.tekon/runs/run_1/node_1',
          prompt: 'implement fixture',
        },
      ),
    ).toThrow(
      /codex artifact output directory must be under Tekon run storage/u,
    );
  });

  it('rejects artifact output directories for a different run or node', () => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        {
          artifactOutputDir: '/tmp/repo/.tekon/runs/run_2/node_1',
          prompt: 'implement fixture',
          runContext: { runId: 'run_1', nodeId: 'node_1' },
        },
      ),
    ).toThrow(
      /codex artifact output directory must match the current run and node/u,
    );

    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        {
          artifactOutputDir: '/tmp/repo/.tekon/runs/run_1/node_1/../node_2',
          prompt: 'implement fixture',
          runContext: { runId: 'run_1', nodeId: 'node_1' },
        },
      ),
    ).toThrow(
      /codex artifact output directory must match the current run and node/u,
    );
  });

  it('requires run context for legal Codex artifact output directories', () => {
    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile('/tmp/repo'),
        },
        {
          artifactOutputDir: '/tmp/repo/.tekon/runs/run_1/node_1',
          prompt: 'implement fixture',
        },
      ),
    ).toThrow(/codex run context is required/u);
  });

  it('rejects symlinked Codex artifact output directories', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-repo-'));
    const outsidePath = mkdtempSync(join(tmpdir(), 'tekon-codex-outside-'));
    tempDirs.push(repoPath, outsidePath);
    mkdirSync(join(repoPath, '.tekon', 'runs', 'run_1'), {
      recursive: true,
    });
    symlinkSync(
      outsidePath,
      join(repoPath, '.tekon', 'runs', 'run_1', 'node_1'),
    );

    expect(() =>
      buildCodexCommand(
        {
          provider: 'codex',
          command: 'codex',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 1000,
          permissionProfile: safePermissionProfile(repoPath),
        },
        {
          artifactOutputDir: join(
            repoPath,
            '.tekon',
            'runs',
            'run_1',
            'node_1',
          ),
          prompt: 'implement fixture',
          runContext: { runId: 'run_1', nodeId: 'node_1' },
        },
      ),
    ).toThrow(/codex artifact output directory cannot include symlinks/u);
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

  it('recovers literal TEKON_ARTIFACT_MANIFEST files written by Codex', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-literal-manifest-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'literal-manifest-writer.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        "writeFileSync(join(outputDir, 'demand-card.json'), JSON.stringify({ title: 'Demand card', body: 'Scoped Codex smoke documentation update.', acceptance_criteria: [{ id: 'AC-1', criterion: 'Document output directory diagnostics.' }] }));",
        "writeFileSync(join(outputDir, 'TEKON_ARTIFACT_MANIFEST'), JSON.stringify({ artifacts: [{ type: 'demand-card', path: 'demand-card.json', summary: 'Scoped Codex smoke documentation update.' }] }));",
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({
      provider: 'codex',
      exitCode: 0,
      artifacts: [expect.objectContaining({ type: 'demand-card' })],
    });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(1);
    db.close();
  });

  it('accepts valid required artifacts when Codex exits non-zero after writing the manifest', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-nonzero-artifacts-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'artifact-then-exit-one.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'demand-card.json'), JSON.stringify({ title: 'Demand card', body: 'Scoped Codex smoke documentation update.', acceptanceCriteria: [{ id: 'AC-1', description: 'Document output directory diagnostics.' }] }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'demand-card', path: 'demand-card.json', summary: 'Scoped Codex smoke documentation update.' }] }));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({
      provider: 'codex',
      exitCode: 0,
      timedOut: false,
      artifacts: [expect.objectContaining({ type: 'demand-card' })],
    });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(1);
    db.close();
  });

  it('does not recover signaled Codex runs without a timeout', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-codex-signaled-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const gateway: CommandGateway = {
      async run(input) {
        const outputDir = input.outputDir ?? repoPath;
        mkdirSync(outputDir, { recursive: true });
        const stdoutPath = join(outputDir, 'stdout.log');
        const stderrPath = join(outputDir, 'stderr.log');
        writeFileSync(stdoutPath, '', 'utf8');
        writeFileSync(stderrPath, '', 'utf8');
        writeFileSync(
          join(outputDir, 'demand-card.json'),
          JSON.stringify({
            title: 'Demand card',
            body: 'Scoped Codex smoke documentation update.',
            acceptanceCriteria: [
              {
                id: 'AC-1',
                description: 'Document output directory diagnostics.',
              },
            ],
          }),
          'utf8',
        );
        writeFileSync(
          input.env?.TEKON_ARTIFACT_MANIFEST ??
            join(outputDir, 'manifest.json'),
          JSON.stringify({
            artifacts: [
              {
                type: 'demand-card',
                path: 'demand-card.json',
                summary: 'Scoped Codex smoke documentation update.',
              },
            ],
          }),
          'utf8',
        );
        return {
          status: 'executed',
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          stdoutPath,
          stderrPath,
          durationMs: 1,
        };
      },
    };
    const adapter = createCodexAdapter(
      {
        provider: 'codex',
        command: process.execPath,
        args: [],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: safePermissionProfile(repoPath),
      },
      gateway,
    );

    const result = await adapter.runAgent({
      ...baseRunInput(repoPath),
      artifactStore,
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({
      provider: 'codex',
      exitCode: null,
      timedOut: false,
      artifacts: [],
    });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects non-zero Codex exits when required artifact manifests are missing', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-nonzero-missing-'),
    );
    tempDirs.push(repoPath);
    const missingScript = join(repoPath, 'missing-manifest-exit-one.mjs');
    writeFileSync(missingScript, 'process.exit(1)\n', 'utf8');
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects non-zero Codex exits when required artifacts are incomplete', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-nonzero-incomplete-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'incomplete-artifacts-exit-one.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: 'Code changes', body: 'Changed docs.' }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Changed docs.' }] }));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects non-zero Codex exits when artifact schemas are invalid', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-nonzero-invalid-artifact-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'invalid-artifact-exit-one.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'demand-card.json'), JSON.stringify({ title: 'Demand card', body: 'Missing acceptance criteria.' }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'demand-card', path: 'demand-card.json', summary: 'Invalid demand card.' }] }));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects literal TEKON_ARTIFACT_MANIFEST symlinks', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-literal-manifest-symlink-'),
    );
    const outsidePath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-literal-manifest-outside-'),
    );
    tempDirs.push(repoPath, outsidePath);
    const outsideManifest = join(outsidePath, 'manifest.json');
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        artifacts: [
          {
            type: 'demand-card',
            path: 'demand-card.json',
            summary: 'Escaped manifest.',
          },
        ],
      }),
      'utf8',
    );
    const artifactScript = join(repoPath, 'literal-manifest-symlink.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { symlinkSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        `const outsideManifest = ${JSON.stringify(outsideManifest)};`,
        "writeFileSync(join(outputDir, 'demand-card.json'), JSON.stringify({ title: 'Demand card', body: 'Scoped Codex smoke documentation update.', acceptanceCriteria: [{ id: 'AC-1', description: 'Document output directory diagnostics.' }] }));",
        "symlinkSync(outsideManifest, join(outputDir, 'TEKON_ARTIFACT_MANIFEST'));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects artifact symlinks declared by provider manifests', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-artifact-symlink-'),
    );
    const outsidePath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-artifact-outside-'),
    );
    tempDirs.push(repoPath, outsidePath);
    const outsideArtifact = join(outsidePath, 'demand-card.json');
    writeFileSync(
      outsideArtifact,
      JSON.stringify({
        title: 'Demand card',
        body: 'Escaped artifact.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'Document output directory diagnostics.' },
        ],
      }),
      'utf8',
    );
    const artifactScript = join(repoPath, 'artifact-symlink.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { symlinkSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        `const outsideArtifact = ${JSON.stringify(outsideArtifact)};`,
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'demand-card', path: 'demand-card.json', summary: 'Escaped artifact.' }] }));",
        "symlinkSync(outsideArtifact, join(outputDir, 'demand-card.json'));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('rejects manifest artifact paths that escape TEKON_OUTPUT_DIR', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-artifact-escape-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'artifact-escape.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'demand-card', path: '../demand-card.json', summary: 'Escaped artifact path.' }] }));",
        'process.exit(1);',
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
      requiredArtifactTypes: ['demand-card'],
    });

    expect(result).toMatchObject({ provider: 'codex', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'demand-card'),
    ).toHaveLength(0);
    db.close();
  });

  it('accepts valid required artifacts when Codex times out after writing the manifest', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-codex-timeout-artifacts-'),
    );
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'artifact-then-hang.mjs');
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: 'Code changes', body: 'Implemented Codex fixture change before timeout.' }));",
        "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Implemented Codex fixture change before timeout.' }] }));",
        'setTimeout(() => {}, 5000);',
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
        timeoutMs: 100,
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
      timedOut: false,
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
