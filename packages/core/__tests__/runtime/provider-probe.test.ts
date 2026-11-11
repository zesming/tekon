import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderPreflightError,
  claudeAuthKind,
  createProviderPreflight,
  probeProvider,
} from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function binDir(...commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-probe-bin-'));
  dirs.push(dir);
  for (const command of commands) {
    const path = join(dir, command);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  return dir;
}

describe('claudeAuthKind', () => {
  it.each([
    [{ loggedIn: true, authMethod: 'claude.ai' }, {}, 'subscription'],
    [{ loggedIn: false, authMethod: 'none' }, {}, 'none'],
    [{ loggedIn: true, authMethod: 'api_key' }, {}, 'api-key'],
    [{ loggedIn: true, authMethod: 'oauth_token' }, { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, 'oauth-token'],
    [{ loggedIn: true, authMethod: 'oauth_token' }, { ANTHROPIC_AUTH_TOKEN: 'x' }, 'auth-token'],
  ])('maps %j', (status, env, expected) => {
    expect(claudeAuthKind(JSON.stringify(status), env)).toBe(expected);
  });

  it('reports unknown for missing or unreadable output', () => {
    expect(claudeAuthKind(undefined, {})).toBe('unknown');
    expect(claudeAuthKind('not json', {})).toBe('unknown');
  });
});

describe('probeProvider', () => {
  it('reports a command missing from PATH without running anything', async () => {
    let ran = false;
    const probe = await probeProvider('claude-code', {
      env: { PATH: binDir() },
      runCommand: async () => {
        ran = true;
        return undefined;
      },
    });
    expect(probe).toMatchObject({ installed: false, command: 'claude' });
    expect(ran).toBe(false);
  });

  it('asks Claude for its auth status with the given environment', async () => {
    const env = { PATH: binDir('claude') };
    const calls: string[][] = [];
    const probe = await probeProvider('claude-code', {
      env,
      includeVersion: true,
      runCommand: async (_command, args, received) => {
        calls.push(args);
        expect(received).toBe(env);
        return args[0] === '--version'
          ? '2.1.0 (Claude Code)\n'
          : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'hidden' });
      },
    });
    expect(probe).toEqual({
      provider: 'claude-code',
      command: 'claude',
      installed: true,
      auth: 'subscription',
      version: '2.1.0 (Claude Code)',
    });
    expect(calls).toEqual([['--version'], ['auth', 'status', '--json']]);
  });

  it('times out a hanging auth status as unknown', async () => {
    const dir = binDir();
    const claude = join(dir, 'claude');
    writeFileSync(claude, '#!/bin/sh\nsleep 5\n');
    chmodSync(claude, 0o755);
    const probe = await probeProvider('claude-code', {
      env: { PATH: dir },
      timeoutMs: 100,
    });
    expect(probe.auth).toBe('unknown');
  });

  it('detects Codex credentials by presence only', async () => {
    const path = binDir('codex');
    const codexHome = mkdtempSync(join(tmpdir(), 'tekon-codex-home-'));
    dirs.push(codexHome);
    expect(
      (await probeProvider('codex', { env: { PATH: path, CODEX_HOME: codexHome } })).auth,
    ).toBe('none');
    expect(
      (await probeProvider('codex', { env: { PATH: path, OPENAI_API_KEY: 'k' } })).auth,
    ).toBe('api-key');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    expect(
      (await probeProvider('codex', { env: { PATH: path, CODEX_HOME: codexHome } })).auth,
    ).toBe('stored-login');
  });
});

describe('createProviderPreflight', () => {
  it('refuses a provider whose command is not installed', async () => {
    const preflight = createProviderPreflight({ env: { PATH: binDir() } });
    await expect(
      preflight({ provider: 'claude-code', phase: 'start' }),
    ).rejects.toBeInstanceOf(ProviderPreflightError);
  });

  it('warns without blocking when no login is found, and lists passthrough names', async () => {
    const preflight = createProviderPreflight({
      env: { PATH: binDir('codex'), CODEX_HOME: join(tmpdir(), 'tekon-no-codex-home') },
    });
    const result = await preflight({
      provider: 'codex',
      phase: 'resume',
      configSummary: { passthroughEnv: ['AZURE_OPENAI_API_KEY'] },
    });
    expect(result).toMatchObject({
      provider: 'codex',
      auth: 'none',
      passthroughEnv: ['AZURE_OPENAI_API_KEY'],
    });
    expect(result?.warnings[0]).toContain('codex login');
  });

  it('uses the configured command from the frozen snapshot', async () => {
    const dir = binDir('my-claude');
    const preflight = createProviderPreflight({
      env: { PATH: '/nonexistent' },
      probe: async (provider, options) => ({
        provider,
        command: options?.command ?? '',
        installed: options?.command === join(dir, 'my-claude'),
        auth: 'subscription',
      }),
    });
    await expect(
      preflight({
        provider: 'claude-code',
        phase: 'start',
        configSummary: { command: join(dir, 'my-claude') },
      }),
    ).resolves.toMatchObject({ auth: 'subscription', warnings: [] });
  });

  it('skips providers it cannot probe', async () => {
    const preflight = createProviderPreflight({ env: { PATH: '' } });
    await expect(preflight({ provider: 'mock', phase: 'start' })).resolves.toBeUndefined();
  });
});
