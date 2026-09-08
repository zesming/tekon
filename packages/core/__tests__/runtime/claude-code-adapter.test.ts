import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeCodeCommand,
  createArtifactStore,
  createClaudeCodeAdapter,
  createCommandGateway,
  createRepositories,
  defaultCommandPolicy,
  defaultProviderConfig,
  migrateDatabase,
  openTekonDatabase,
  type CommandGatewayRunInput,
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
      message: 'permission mode is controlled by Tekon',
    },
    {
      args: ['--permission-mode', 'bypassPermissions'],
      message: 'permission mode is controlled by Tekon',
    },
    {
      args: ['--permission-mode=bypassPermissions'],
      message: 'permission mode is controlled by Tekon',
    },
    { args: ['--permissionMode'], message: undefined },
    { args: ['--permissionMode=acceptEdits'], message: undefined },
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
    { args: ['--allowedTools'], message: undefined },
    { args: ['--allowedTools=Bash(npm test)'], message: undefined },
    { args: ['--allowed-tools'], message: undefined },
    { args: ['--allowed-tools=Bash(npm test)'], message: undefined },
    { args: ['--disallowedTools'], message: undefined },
    { args: ['--disallowedTools=Bash(git push)'], message: undefined },
    { args: ['--disallowed-tools'], message: undefined },
    { args: ['--disallowed-tools=Bash(git push)'], message: undefined },
    { args: ['--settings'], message: undefined },
    { args: ['--settings={"permissions":{"allow":[]}}'], message: undefined },
    { args: ['--setting-sources'], message: undefined },
    { args: ['--setting-sources=user'], message: undefined },
    { args: ['--settingSources'], message: undefined },
    { args: ['--settingSources=user'], message: undefined },
    { args: ['--permission-prompt'], message: undefined },
    { args: ['--permissionPrompt'], message: undefined },
    { args: ['--permissionPrompt=none'], message: undefined },
    { args: ['--permission-prompt-tool'], message: undefined },
    { args: ['--permission-prompt-tool=none'], message: undefined },
    { args: ['--permissionPromptTool'], message: undefined },
    { args: ['--permissionPromptTool=none'], message: undefined },
    { args: ['--tools'], message: undefined },
    { args: ['--tools=Bash'], message: undefined },
    { args: ['--add-dir'], message: undefined },
    { args: ['--add-dir=/tmp/other'], message: undefined },
    { args: ['--addDir'], message: undefined },
    { args: ['--addDir=/tmp/other'], message: undefined },
    { args: ['--agents'], message: undefined },
    { args: ['--agents={}'], message: undefined },
    { args: ['--dangerously-skip-permissions=true'], message: undefined },
    { args: ['--dangerouslySkipPermissions'], message: undefined },
    { args: ['--allowDangerouslySkipPermissions'], message: undefined },
    { args: ['--allowDangerouslySkipPermissions=true'], message: undefined },
    { args: ['--allow-dangerously-skip-permissions'], message: undefined },
    { args: ['--allow-dangerously-skip-permissions=true'], message: undefined },
    { args: ['--'], message: undefined },
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

    if (message) {
      expect(() =>
        buildClaudeCodeCommand(safeConfig, { prompt: 'hello' }),
      ).toThrow(message);
    } else {
      expect(() =>
        buildClaudeCodeCommand(safeConfig, { prompt: 'hello' }),
      ).toThrow();
    }
  });

  it('keeps ordinary model and output arguments compatible', () => {
    const config = {
      provider: 'claude-code' as const,
      command: 'claude',
      args: ['--model', 'sonnet', '--verbose'],
      promptMode: 'stdin' as const,
      outputFormat: 'json' as const,
      timeoutMs: 1000,
      permissionProfile: safePermissionProfile('/tmp/repo'),
    };

    expect(() =>
      buildClaudeCodeCommand(config, { prompt: 'hello' }),
    ).not.toThrow();
    expect(buildClaudeCodeCommand(config, { prompt: 'hello' }).args).toEqual(
      expect.arrayContaining(['--model', 'sonnet', '--verbose']),
    );
  });

  it('emits generated Claude permissions while keeping an arg prompt last', () => {
    const repoPath = '/tmp/repo';
    const config = {
      ...defaultProviderConfig('claude-code', repoPath, {
        approvalDefault: 'on-request',
      }),
      promptMode: 'arg-append' as const,
    };
    const prompt = '--dangerously-skip-permissions';
    const command = buildClaudeCodeCommand(
      config,
      { prompt },
      defaultCommandPolicy(repoPath),
    );

    expect(command.args).toContain('--permission-mode');
    expect(command.args).toContain('default');
    expect(
      command.args.some(
        (arg) => arg === '--allowedTools' || arg === '--allowed-tools',
      ),
    ).toBe(true);
    expect(command.args.join('\u0000')).toContain('Bash(npm test)');
    const separatorIndex = command.args.lastIndexOf('--');
    expect(separatorIndex).toBe(command.args.length - 2);
    expect(command.args.slice(separatorIndex + 1)).toEqual([prompt]);
  });

  it('serializes human approval separately as Claude permissions.ask', () => {
    const repoPath = '/tmp/repo';
    const config = {
      ...defaultProviderConfig('claude-code', repoPath, {
        approvalDefault: 'on-request',
      }),
      promptMode: 'stdin' as const,
    };
    const command = buildClaudeCodeCommand(
      config,
      { prompt: 'approval prompt' },
      {
        ...defaultCommandPolicy(repoPath),
        requiresHumanApproval: [
          { tool: 'git', args: ['status'], match: 'exact' },
        ],
      },
    );

    const settingsIndex = command.args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(command.args[settingsIndex + 1] ?? '{}') as {
      permissions?: { ask?: string[] };
    };
    expect(settings.permissions?.ask).toContain('Bash(git status)');
    expect(command.args.slice(0, settingsIndex).join(' ')).not.toContain(
      'Bash(git status)',
    );
  });

  it('does not synthesize Bash grants when no command policy is provided', () => {
    const config = defaultProviderConfig('claude-code', '/tmp/repo');
    const command = buildClaudeCodeCommand(config, { prompt: 'hello' });

    expect(command.args).not.toContain('--allowedTools');
    expect(command.args).not.toContain('--allowed-tools');
    expect(command.args.join(' ')).not.toContain('Bash(npm');
  });

  it('passes the command policy to Claude permission compilation before spawn', async () => {
    const repoPath = '/tmp/repo';
    const policy = defaultCommandPolicy(repoPath);
    let capturedInput: CommandGatewayRunInput | undefined;
    const adapter = createClaudeCodeAdapter(
      {
        ...defaultProviderConfig('claude-code', repoPath, {
          approvalDefault: 'on-request',
        }),
        promptMode: 'arg-append',
      },
      {
        async run(input: CommandGatewayRunInput) {
          capturedInput = input;
          return {
            status: 'executed',
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdoutPath: join(repoPath, 'stdout.log'),
            stderrPath: join(repoPath, 'stderr.log'),
            durationMs: 1,
          };
        },
      },
    );

    await adapter.runAgent({
      ...baseRunInput(repoPath),
      commandPolicy: policy,
      prompt: '--dangerously-skip-permissions',
    });

    expect(capturedInput?.policy).toBe(policy);
    expect(
      capturedInput?.command.args.some(
        (arg) => arg === '--allowedTools' || arg === '--allowed-tools',
      ),
    ).toBe(true);
    expect(capturedInput?.command.args).toContain('Bash(npm test)');
    const separatorIndex = capturedInput?.command.args.lastIndexOf('--') ?? -1;
    expect(separatorIndex).toBe((capturedInput?.command.args.length ?? 0) - 2);
    expect(capturedInput?.command.args.at(-1)).toBe(
      '--dangerously-skip-permissions',
    );
    const addDirIndex = capturedInput?.command.args.indexOf('--add-dir') ?? -1;
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(addDirIndex).toBeLessThan(
      capturedInput?.command.args.indexOf('--') ?? -1,
    );
  });

  it('streams large stdout/stderr without deadlock and reports timeout', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-agent-'));
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
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-stdin-'));
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

  it('does not spawn a Claude command when its abort signal is already set', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-claude-abort-before-spawn-'),
    );
    tempDirs.push(repoPath);
    const markerPath = join(repoPath, 'spawned');
    const scriptPath = join(repoPath, 'marker.mjs');
    writeFileSync(
      scriptPath,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'spawned');\n",
      'utf8',
    );
    const controller = new AbortController();
    controller.abort();
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [scriptPath, markerPath],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: safePermissionProfile(repoPath),
      },
      createCommandGateway(),
    );

    await adapter.runAgent({
      ...baseRunInput(repoPath),
      signal: controller.signal,
    });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('terminates a running Claude subprocess when its abort signal fires', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-abort-running-'));
    tempDirs.push(repoPath);
    const startedPath = join(repoPath, 'started');
    const heartbeatPath = join(repoPath, 'heartbeat');
    const scriptPath = join(repoPath, 'long-running.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "writeFileSync(process.argv[3], 'started');",
        'writeFileSync(process.argv[2], String(process.pid));',
        "setInterval(() => appendFileSync(process.argv[3], 'x'), 10);",
      ].join('\n'),
      'utf8',
    );
    const controller = new AbortController();
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [scriptPath, startedPath, heartbeatPath],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: safePermissionProfile(repoPath),
      },
      createCommandGateway(),
    );

    const resultPromise = adapter.runAgent({
      ...baseRunInput(repoPath),
      signal: controller.signal,
    });
    await waitForFile(startedPath);
    controller.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({
      provider: 'claude-code',
      exitCode: null,
      timedOut: false,
    });
    const heartbeatAfterClose = readFileSync(heartbeatPath, 'utf8').length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(heartbeatPath, 'utf8').length).toBe(
      heartbeatAfterClose,
    );
  });

  it('passes progress and no-progress timeouts to the command gateway', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-progress-'));
    tempDirs.push(repoPath);
    let capturedInput: CommandGatewayRunInput | undefined;
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: ['fixture.mjs'],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 3_600_000,
        progressHeartbeatMs: 60_000,
        noProgressTimeoutMs: 900_000,
        permissionProfile: safePermissionProfile(repoPath),
      },
      {
        async run(input: CommandGatewayRunInput) {
          capturedInput = input;
          return {
            status: 'executed',
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdoutPath: join(repoPath, 'stdout.log'),
            stderrPath: join(repoPath, 'stderr.log'),
            durationMs: 1,
          };
        },
      },
    );

    await adapter.runAgent(baseRunInput(repoPath));

    expect(capturedInput).toMatchObject({
      timeoutMs: 3_600_000,
      progressIntervalMs: 60_000,
      noProgressTimeoutMs: 900_000,
    });
  });

  it.each(['', '\uFEFF', '\u00A0'])(
    'ingests provider artifact manifests with accepted JSON padding %j',
    async (padding) => {
      const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-artifacts-'));
      tempDirs.push(repoPath);
      const artifactScript = join(repoPath, 'artifact-writer.mjs');
      writeFileSync(
        artifactScript,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'const outputDir = process.env.TEKON_OUTPUT_DIR;',
          'const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;',
          `writeFileSync(join(outputDir, 'code-changes.json'), ${JSON.stringify(padding)} + JSON.stringify({ title: 'Code changes', body: 'Implemented fixture change.' }) + ${JSON.stringify(padding)});`,
          "writeFileSync(manifestPath, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Implemented fixture change.' }] }));",
        ].join('\n'),
        'utf8',
      );
      const db = openTekonDatabase({ filename: ':memory:' });
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
    },
  );

  it('fails real provider runs when required artifact manifests are missing or invalid', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-artifact-fail-'));
    tempDirs.push(repoPath);
    const missingScript = join(repoPath, 'missing-manifest.mjs');
    const invalidScript = join(repoPath, 'invalid-artifact.mjs');
    writeFileSync(missingScript, 'process.exit(0)\n', 'utf8');
    writeFileSync(
      invalidScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        "writeFileSync(join(outputDir, 'code-changes.json'), JSON.stringify({ title: '', body: '' }));",
        "writeFileSync(process.env.TEKON_ARTIFACT_MANIFEST, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json' }] }));",
      ].join('\n'),
      'utf8',
    );
    const db = openTekonDatabase({ filename: ':memory:' });
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
          '.tekon',
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
      expect(result.diagnostic).toMatchObject({
        code:
          script === missingScript
            ? 'artifact-manifest-missing'
            : 'artifact-file-schema-invalid',
      });
    }
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'code-changes'),
    ).toHaveLength(0);
    db.close();
  });

  it('surfaces invalid artifact JSON from a real subprocess without model content', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-artifact-json-'));
    tempDirs.push(repoPath);
    const artifactScript = join(repoPath, 'invalid-artifact-json.mjs');
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    writeFileSync(
      artifactScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const outputDir = process.env.TEKON_OUTPUT_DIR;',
        `const invalidArtifact = ${JSON.stringify(
          `{"title":"broken "quote" and ${secret} body"}`,
        )};`,
        "writeFileSync(join(outputDir, 'code-changes.json'), invalidArtifact);",
        "writeFileSync(process.env.TEKON_ARTIFACT_MANIFEST, JSON.stringify({ artifacts: [{ type: 'code-changes', path: 'code-changes.json', summary: 'Broken JSON.' }] }));",
      ].join('\n'),
      'utf8',
    );
    const db = openTekonDatabase({ filename: ':memory:' });
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
      exitCode: 1,
      diagnostic: {
        code: 'artifact-file-invalid-json',
        artifactType: 'code-changes',
        path: 'code-changes.json',
      },
    });
    expect(result.diagnostic?.message).toContain('file=code-changes.json');
    expect(result.diagnostic?.message).not.toContain(secret);
    expect(result.diagnostic?.message.length).toBeLessThanOrEqual(500);
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
      createdAt: '2026-06-05T00:00:00.000Z',
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
    title: 'Artifact manifest',
    body: 'Write code changes artifact.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
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
