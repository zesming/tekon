import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentAdapterConfigSchema,
  buildCodexCommand,
  buildCodexProviderEnv,
  createAgentAdapterFromSnapshot,
  createAgentRuntime,
  createCommandGateway,
  type CommandGateway,
  type SpawnImpl,
} from '../../src/index.js';
import { buildClaudeProviderEnv } from '../../src/runtime/claude-code-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gateway: CommandGateway = {
  async run() {
    return { status: 'rejected', reason: 'not used' };
  },
};

function repo(configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-passthrough-'));
  dirs.push(dir);
  if (configYaml) {
    mkdirSync(join(dir, '.tekon'));
    writeFileSync(join(dir, '.tekon', 'config.yaml'), configYaml);
  }
  return dir;
}

describe('provider environment passthrough', () => {
  it('adds passthrough names to the Claude environment and skips empty values', () => {
    expect(
      buildClaudeProviderEnv(
        { PATH: '/usr/bin', AWS_PROFILE: 'dev', AWS_REGION: '', GITHUB_TOKEN: 'x' },
        ['AWS_PROFILE', 'AWS_REGION'],
      ),
    ).toEqual({ PATH: '/usr/bin', AWS_PROFILE: 'dev' });
  });

  it('builds the Codex environment from its own allow list plus passthrough', () => {
    expect(
      buildCodexProviderEnv(
        {
          PATH: '/usr/bin',
          USER: 'alice',
          LOGNAME: 'alice',
          OPENAI_API_KEY: 'k',
          OPENAI_BASE_URL: 'https://gateway.example',
          CODEX_HOME: '',
          https_proxy: 'http://proxy.example:8080',
          NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
          AZURE_OPENAI_API_KEY: 'azure',
          ANTHROPIC_API_KEY: 'other',
          NODE_OPTIONS: '--require /tmp/x.js',
        },
        ['AZURE_OPENAI_API_KEY'],
      ),
    ).toEqual({
      PATH: '/usr/bin',
      USER: 'alice',
      LOGNAME: 'alice',
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'https://gateway.example',
      https_proxy: 'http://proxy.example:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      AZURE_OPENAI_API_KEY: 'azure',
    });
  });

  it('rejects reserved names in a persisted adapter config', () => {
    const base = agentAdapterConfigSchema.parse({
      provider: 'claude-code',
      promptMode: 'stdin',
      outputFormat: 'json',
      permissionProfile: {
        sandbox: 'workspace-write',
        approval: 'on-request',
        filesystemScope: ['/tmp/repo'],
        network: 'restricted',
        tools: { allow: [], deny: [] },
      },
    });
    expect(() =>
      agentAdapterConfigSchema.parse({ ...base, passthroughEnv: ['TEKON_RUN_ID'] }),
    ).toThrow(/TEKON_RUN_ID/);
  });

  it('records repo passthrough names and the codex profile in the snapshot (version 2)', () => {
    const repoPath = repo(
      [
        'providers:',
        '  claude-code:',
        '    passthroughEnv: [AWS_PROFILE]',
        '  codex:',
        '    profile: team',
        '    passthroughEnv: [AZURE_OPENAI_API_KEY]',
        '',
      ].join('\n'),
    );
    const claude = createAgentRuntime({ agent: 'claude-code', repoPath, gateway });
    expect(claude.configSummary).toMatchObject({
      passthroughEnv: ['AWS_PROFILE'],
      schemaVersion: 2,
    });
    const codex = createAgentRuntime({ agent: 'codex', repoPath, gateway });
    expect(codex.configSummary).toMatchObject({
      profile: 'team',
      passthroughEnv: ['AZURE_OPENAI_API_KEY'],
      schemaVersion: 2,
    });
  });

  it('fails to start when the repo config has an invalid passthrough name', () => {
    const repoPath = repo('providers:\n  claude-code:\n    passthroughEnv: [NODE_OPTIONS]\n');
    expect(() => createAgentRuntime({ agent: 'claude-code', repoPath, gateway })).toThrow(
      /NODE_OPTIONS/,
    );
  });

  it('starts Codex without a profile unless one is configured', () => {
    const codex = createAgentRuntime({ agent: 'codex', repoPath: repo(), gateway });
    expect(codex.configSummary.profile).toBeUndefined();
  });

  it('keeps passthrough names from the snapshot on resume, not from the current config', () => {
    const repoPath = repo('providers:\n  claude-code:\n    passthroughEnv: [AWS_PROFILE]\n');
    const started = createAgentRuntime({ agent: 'claude-code', repoPath, gateway });
    writeFileSync(
      join(repoPath, '.tekon', 'config.yaml'),
      'providers:\n  claude-code:\n    passthroughEnv: [AWS_REGION]\n',
    );
    const restored = createAgentAdapterFromSnapshot({
      snapshot: {
        runId: 'run_1',
        provider: 'claude-code',
        configSummary: started.configSummary,
        createdAt: '2026-11-11T00:00:00.000Z',
      },
      gateway,
    });
    expect(restored.configSummary.passthroughEnv).toEqual(['AWS_PROFILE']);
  });

  it('keeps the internal profile for a version 1 codex snapshot without one', () => {
    const repoPath = repo();
    const fresh = createAgentRuntime({ agent: 'codex', repoPath, gateway });
    const { profile: _profile, schemaVersion: _version, ...v1Summary } = fresh.configSummary;
    const restored = createAgentAdapterFromSnapshot({
      snapshot: {
        runId: 'run_1',
        provider: 'codex',
        configSummary: v1Summary,
        createdAt: '2026-11-11T00:00:00.000Z',
      },
      gateway,
    });
    expect(restored.configSummary.profile).toBe('internal');
    const parsed = agentAdapterConfigSchema.parse(restored.configSummary);
    const command = buildCodexCommand(parsed, {
      artifactOutputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'node_1'),
      prompt: 'p',
      runContext: { runId: 'run_1', nodeId: 'node_1' },
    });
    expect(command.args.slice(0, 2)).toEqual(['--profile', 'internal']);
  });

  it('does not hand passthrough variables to gate commands', async () => {
    const cwd = repo();
    const previous = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = 'dev';
    let received: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      received = options.env;
      throw new Error('stop before spawn');
    };
    try {
      await createCommandGateway({ spawnImpl }).run({
        command: { tool: 'node', args: ['-v'] },
        cwd,
        policy: {
          allow: [{ tool: 'node', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      });
    } finally {
      if (previous === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = previous;
    }
    expect(received).toBeDefined();
    expect(received).not.toHaveProperty('AWS_PROFILE');
  });
});
