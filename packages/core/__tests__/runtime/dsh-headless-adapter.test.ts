import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TESTED_DSH_VERSION,
  buildDshHeadlessCommand,
  createDshHeadlessAdapter,
  dshHeadlessProviderConfig,
  type CommandGateway,
  createArtifactStore,
  createCodexAdapter,
  createCommandGateway,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * A permission profile that honestly declares dsh's unrestricted network with
 * the explicit informed-consent acknowledgment. This is the ONLY shape that
 * lets the capability guard construct a dsh-headless adapter (see the guard
 * carve-out test below).
 */
function ackConfig(repoPath: string) {
  return dshHeadlessProviderConfig(repoPath);
}

/**
 * Write an executable POSIX shell fake `dsh` at repoPath and return its path.
 * Because the adapter ALWAYS builds `--profile headless ... <prompt>`, the fake
 * is used as `config.command` (not as a node script arg): the injected flags
 * become the fake's ignored positional argv, so we exercise the real command
 * framing without a live dsh. The body runs whatever `script` says.
 */
function writeFakeDsh(repoPath: string, script: string): string {
  const path = join(repoPath, 'fake-dsh.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/** A run input whose command policy allow-lists the given fake dsh binary. */
function runInputAllowing(repoPath: string, fakeDsh: string) {
  return {
    ...baseRunInput(repoPath),
    commandPolicy: {
      allow: [{ tool: fakeDsh, args: [] }],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: [repoPath],
      network: 'enabled' as const,
    },
  };
}

function baseRunInput(repoPath: string) {
  return {
    roleConfig: { role: 'goal' as const },
    prompt: 'summarize the repository layout',
    worktreeLease: {
      id: 'lease_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'goal' as const,
      repoPath,
      worktreePath: repoPath,
      branchName: 'tekon/run_1/node_1-goal',
      createdAt: '2026-08-25T00:00:00.000Z',
    },
    outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'agent'),
    commandPolicy: {
      allow: [{ tool: process.execPath, args: [] }],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: [repoPath],
      network: 'enabled' as const,
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
    title: 'dsh goal',
    body: 'Summarize.',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'goal',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  });
}

describe('dsh-headless adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // ── command construction ──────────────────────────────────────────────

  it('pins --profile headless and passes the task as a single positional arg', () => {
    const command = buildDshHeadlessCommand(ackConfig('/tmp/repo'), {
      prompt: 'do the thing with spaces',
    });
    expect(command.tool).toBe('dsh');
    expect(command.args).toEqual([
      '--profile',
      'headless',
      'do the thing with spaces',
    ]);
    // headless does not consume stdin (README: one submitted task only).
    expect(command.stdin).toBeUndefined();
  });

  it('honors a command override (enterprise dsh path) while keeping the contract', () => {
    const command = buildDshHeadlessCommand(
      { ...ackConfig('/tmp/repo'), command: '/opt/dsh/bin/dsh' },
      { prompt: 'task' },
    );
    expect(command.tool).toBe('/opt/dsh/bin/dsh');
    expect(command.args).toEqual(['--profile', 'headless', 'task']);
  });

  it.each([
    ['--profile'],
    ['--profile=web'],
    ['--patch'],
    ['--patch=/tmp/evil.yml'],
    ['--dump-config'],
    ['--dump-default-config'],
    ['--version'],
    ['web'],
    ['plugin'],
    ['-h'],
    ['--help'],
  ])('rejects launcher control arg %j (mirrors codex arg guard)', (arg) => {
    expect(() =>
      buildDshHeadlessCommand(
        { ...ackConfig('/tmp/repo'), args: [arg] },
        {
          prompt: 'task',
        },
      ),
    ).toThrow(/dsh .*controlled by Tekon|launcher/i);
  });

  // ── capability guard carve-out ─────────────────────────────────────────

  it('constructs only with an explicit unrestricted-network acknowledgment', () => {
    // The default helper carries the ack → constructs fine.
    expect(() =>
      createDshHeadlessAdapter(ackConfig('/tmp/repo'), createCommandGateway()),
    ).not.toThrow();
  });

  it('refuses to construct when network is enabled without the ack (fail-closed)', () => {
    const noAck = {
      ...ackConfig('/tmp/repo'),
      acknowledgeUnrestrictedNetwork: false,
    };
    expect(() =>
      createDshHeadlessAdapter(noAck, createCommandGateway()),
    ).toThrow(/network|prove safe/i);
  });

  it('refuses danger-full-access even with the network ack', () => {
    const dangerous = {
      ...ackConfig('/tmp/repo'),
      permissionProfile: {
        ...ackConfig('/tmp/repo').permissionProfile,
        sandbox: 'danger-full-access' as const,
        approval: 'never' as const,
      },
    };
    expect(() =>
      createDshHeadlessAdapter(dangerous, createCommandGateway()),
    ).toThrow(/prove safe/i);
  });

  // ── result mapping ─────────────────────────────────────────────────────

  it('maps a clean exit 0 with stdout to a passed AgentRunResult', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-ok-'));
    tempDirs.push(repoPath);
    // Fake "dsh": echo the final assistant text to stdout and exit 0. Used as
    // config.command, so the adapter's `--profile headless <prompt>` framing
    // lands as the fake's ignored positional argv.
    const fakeDsh = writeFakeDsh(
      repoPath,
      "echo 'final assistant answer'; exit 0",
    );
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [] },
      createCommandGateway(),
    );
    const result = await adapter.runAgent(runInputAllowing(repoPath, fakeDsh));
    expect(result).toMatchObject({
      provider: 'dsh-headless',
      exitCode: 0,
      assistantText: 'final assistant answer',
      timedOut: false,
    });
    // stdout captured to an output file.
    const captured = result.outputFiles
      .map((p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return '';
        }
      })
      .join('');
    expect(captured).toContain('final assistant answer');
  });

  it('reports timeouts (SIGKILL by gateway) as timedOut', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-timeout-'));
    tempDirs.push(repoPath);
    const fakeDsh = writeFakeDsh(repoPath, 'sleep 5');
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [], timeoutMs: 20 },
      createCommandGateway(),
    );
    const result = await adapter.runAgent(runInputAllowing(repoPath, fakeDsh));
    expect(result).toMatchObject({
      provider: 'dsh-headless',
      exitCode: null,
      timedOut: true,
    });
  });

  it('maps a real dsh failure (exit 1) to a failed result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-exit1-'));
    tempDirs.push(repoPath);
    const fakeDsh = writeFakeDsh(
      repoPath,
      "echo 'dsh: AUTH: authentication fails' 1>&2; exit 1",
    );
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [] },
      createCommandGateway(),
    );
    const result = await adapter.runAgent(runInputAllowing(repoPath, fakeDsh));
    expect(result).toMatchObject({
      provider: 'dsh-headless',
      exitCode: 1,
      timedOut: false,
    });
  });

  it('marks cancellation when the abort signal fires before spawn', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-cancel-'));
    tempDirs.push(repoPath);
    const fakeDsh = writeFakeDsh(repoPath, 'echo never');
    const controller = new AbortController();
    controller.abort();
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [] },
      createCommandGateway(),
    );
    const result = await adapter.runAgent({
      ...runInputAllowing(repoPath, fakeDsh),
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      provider: 'dsh-headless',
      cancelled: true,
    });
  });

  it('pins governance env with exact mode, DSH_HOME outside the worktree', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-env-'));
    tempDirs.push(repoPath);
    // Distinct main-repo vs worktree paths, mirroring a real workflow lease:
    // runContext.repoPath === worktreePath (a worktree under the main repo),
    // while lease.repoPath is the main repo. DSH_HOME must key off the main
    // repo so it lands OUTSIDE the agent's sandbox root (= worktree).
    const worktreePath = join(repoPath, '.tekon', 'worktrees', 'run_1', 'goal');
    let capturedEnvMode: unknown = 'unset';
    let capturedEnv: Record<string, string | undefined> = {};
    const gateway: CommandGateway = {
      async run(input) {
        capturedEnvMode = input.envMode;
        capturedEnv = input.env ?? {};
        return { status: 'rejected', reason: 'stop after capture' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: process.execPath, args: [] },
      gateway,
    );
    const base = baseRunInput(repoPath);
    await adapter.runAgent({
      ...base,
      worktreeLease: {
        ...base.worktreeLease,
        repoPath, // main repo
        worktreePath, // isolated worktree (sandbox root)
      },
      runContext: { ...base.runContext, repoPath: worktreePath },
    });
    // 'exact' means the child gets ONLY this env, not the parent's — stricter
    // than gateway 'safe-default'.
    expect(capturedEnvMode).toBe('exact');
    expect(capturedEnv.DSH_PERMISSION_MODE).toBe('workspace-write');
    // DSH_HOME is under the MAIN repo data dir, and genuinely OUTSIDE the
    // worktree sandbox root (review S2 — not a vacuous assertion).
    expect(capturedEnv.DSH_HOME).toBe(
      join(repoPath, '.tekon', 'runs', 'run_1', 'node_1-dsh-home'),
    );
    expect(capturedEnv.DSH_HOME!.startsWith(worktreePath)).toBe(false);
    // TEKON_* passthrough for the artifact protocol.
    expect(capturedEnv.TEKON_RUN_ID).toBe('run_1');
  });

  it('passes DEEPSEEK_API_KEY through only when present, never persists it', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-key-'));
    tempDirs.push(repoPath);
    let capturedEnv: Record<string, string | undefined> = {};
    const gateway: CommandGateway = {
      async run(input) {
        capturedEnv = input.env ?? {};
        return { status: 'rejected', reason: 'stop after capture' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: process.execPath, args: [] },
      gateway,
    );
    const prior = process.env.DEEPSEEK_API_KEY;
    try {
      process.env.DEEPSEEK_API_KEY = 'sk-test-should-passthrough';
      await adapter.runAgent(baseRunInput(repoPath));
      expect(capturedEnv.DEEPSEEK_API_KEY).toBe('sk-test-should-passthrough');
    } finally {
      if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prior;
    }
  });

  it('fails a node that requires artifacts dsh cannot write (honest goal-only boundary)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-artifact-'));
    tempDirs.push(repoPath);
    // Fake dsh exits 0 but writes NO manifest (it cannot: outputDir is outside
    // its workspace sandbox). Required artifact types must therefore fail.
    const fakeDsh = writeFakeDsh(repoPath, "echo 'done'; exit 0");
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const artifactStore = createArtifactStore({ repoPath, repositories });
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [] },
      createCommandGateway(),
    );
    const result = await adapter.runAgent({
      ...runInputAllowing(repoPath, fakeDsh),
      artifactStore,
      requiredArtifactTypes: ['code-changes'],
    });
    expect(result).toMatchObject({ provider: 'dsh-headless', exitCode: 1 });
    expect(
      await repositories.listArtifacts('run_1', 'node_1', 'code-changes'),
    ).toHaveLength(0);
    db.close();
  });

  // ── version gate wiring (design §10.1, review S6) ───────────────────────

  it('version-gates a real dsh: a drifted version rejects before any spawn', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-vgate-'));
    tempDirs.push(repoPath);
    let spawned = false;
    const gateway: CommandGateway = {
      async run() {
        spawned = true;
        return { status: 'rejected', reason: 'should not reach' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      { probeVersion: async () => '0.9.9-wrong\n' },
    );
    await expect(adapter.runAgent(baseRunInput(repoPath))).rejects.toThrow(
      /version mismatch/i,
    );
    // Gate fails BEFORE the command is dispatched.
    expect(spawned).toBe(false);
  });

  it('allowVersion escape hatch admits a drifted version with a warning', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-vallow-'));
    tempDirs.push(repoPath);
    const warnings: string[] = [];
    let spawned = false;
    const gateway: CommandGateway = {
      async run() {
        spawned = true;
        return { status: 'rejected', reason: 'stop after gate' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      {
        probeVersion: async () => '0.9.9-wrong\n',
        probeHelp: async () => 'usage: print the final assistant message\n',
        probeConfig: async () =>
          'headless-runner\nsandbox-policy\nuser-approval\nsession-persistence-jsonl\nagent-default-model\n',
        allowVersion: '0.9.9-wrong',
        onWarn: (w) => warnings.push(w),
      },
    );
    await adapter.runAgent(baseRunInput(repoPath));
    expect(spawned).toBe(true); // gate passed → reached gateway
    expect(warnings.join('\n')).toMatch(/0\.9\.9-wrong/);
  });

  it('probes the dsh version only once across multiple runs (cached)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-vcache-'));
    tempDirs.push(repoPath);
    let probeCount = 0;
    const gateway: CommandGateway = {
      async run() {
        return { status: 'rejected', reason: 'stop after gate' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      {
        probeVersion: async () => {
          probeCount += 1;
          return TESTED_DSH_VERSION + '\n';
        },
        probeHelp: async () => 'usage: print the final assistant message\n',
        probeConfig: async () =>
          'headless-runner\nsandbox-policy\nuser-approval\nsession-persistence-jsonl\nagent-default-model\n',
      },
    );
    await adapter.runAgent(baseRunInput(repoPath));
    await adapter.runAgent(baseRunInput(repoPath));
    expect(probeCount).toBe(1);
  });

  it('never probes a version for a non-dsh command (fake binary)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-vfake-'));
    tempDirs.push(repoPath);
    let probeCount = 0;
    const fakeDsh = writeFakeDsh(repoPath, "echo 'ok'; exit 0");
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: fakeDsh, args: [] },
      createCommandGateway(),
      {
        probeVersion: async () => {
          probeCount += 1;
          return TESTED_DSH_VERSION + '\n';
        },
      },
    );
    await adapter.runAgent(runInputAllowing(repoPath, fakeDsh));
    expect(probeCount).toBe(0);
  });

  // ── zero-spawn regression lock (design §14.2 #2) ────────────────────────

  it('a codex run never spawns dsh (gateway spy: dsh code path is inert when unselected)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-inert-'));
    tempDirs.push(repoPath);
    const invocations: string[] = [];
    const spyGateway: CommandGateway = {
      async run(input) {
        invocations.push(input.command.tool);
        return { status: 'rejected', reason: 'spy: stop after capture' };
      },
    };
    // A codex adapter drives one run through the spy gateway.
    const codex = createCodexAdapter(
      {
        provider: 'codex',
        command: 'codex',
        args: [],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 500,
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: [repoPath],
          network: 'restricted',
          tools: { allow: ['git'], deny: ['rm'] },
        },
      },
      spyGateway,
    );
    await codex.runAgent({
      ...baseRunInput(repoPath),
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'node_1'),
    });
    // The dsh binary was never invoked (argv[0] !== 'dsh' / no dsh path).
    expect(invocations.length).toBeGreaterThan(0);
    for (const tool of invocations) {
      expect(basename(tool)).not.toBe('dsh');
    }
  });

  // ── capability preflight gate (P1-DSH-01) ──────────────────────────────

  it('fails closed and rejects runAgent when dsh --profile headless --help misses contract anchor', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-help-gate-'));
    tempDirs.push(repoPath);
    let spawned = false;
    const gateway: CommandGateway = {
      async run() {
        spawned = true;
        return { status: 'rejected', reason: 'should not reach' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      {
        probeVersion: async () => TESTED_DSH_VERSION + '\n',
        probeHelp: async () => 'dsh options: --help\n', // missing HEADLESS_HELP_ANCHOR
        probeConfig: async () =>
          'headless-runner\nsandbox-policy\nuser-approval\nsession-persistence-jsonl\nagent-default-model\n',
      },
    );
    await expect(adapter.runAgent(baseRunInput(repoPath))).rejects.toThrow(
      /stdout contract anchor/i,
    );
    expect(spawned).toBe(false);
  });

  it('fails closed and rejects runAgent when dsh --dump-default-config misses required plugin id', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-cfg-gate-'));
    tempDirs.push(repoPath);
    let spawned = false;
    const gateway: CommandGateway = {
      async run() {
        spawned = true;
        return { status: 'rejected', reason: 'should not reach' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      {
        probeVersion: async () => TESTED_DSH_VERSION + '\n',
        probeHelp: async () => 'print the final assistant message\n',
        probeConfig: async () =>
          'headless-runner\nuser-approval\nsession-persistence-jsonl\nagent-default-model\n', // missing sandbox-policy
      },
    );
    await expect(adapter.runAgent(baseRunInput(repoPath))).rejects.toThrow(
      /missing the required plugin id 'sandbox-policy'/i,
    );
    expect(spawned).toBe(false);
  });

  it('passes capability preflight when help and config contracts match and runs gate only once (cached)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-cap-ok-'));
    tempDirs.push(repoPath);
    let versionCount = 0;
    let helpCount = 0;
    let configCount = 0;
    let runCount = 0;
    const gateway: CommandGateway = {
      async run() {
        runCount += 1;
        return { status: 'rejected', reason: 'stop after gate' };
      },
    };
    const adapter = createDshHeadlessAdapter(
      { ...ackConfig(repoPath), command: 'dsh', args: [] },
      gateway,
      {
        probeVersion: async () => {
          versionCount += 1;
          return TESTED_DSH_VERSION + '\n';
        },
        probeHelp: async () => {
          helpCount += 1;
          return 'usage: print the final assistant message\n';
        },
        probeConfig: async () => {
          configCount += 1;
          return 'headless-runner\nsandbox-policy\nuser-approval\nsession-persistence-jsonl\nagent-default-model\n';
        },
      },
    );
    await adapter.runAgent(baseRunInput(repoPath));
    await adapter.runAgent(baseRunInput(repoPath));
    expect(runCount).toBe(2);
    expect(versionCount).toBe(1);
    expect(helpCount).toBe(1);
    expect(configCount).toBe(1);
  });
});
