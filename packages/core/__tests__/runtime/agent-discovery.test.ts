import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readTekonConfig } from '../../src/config/tekon-config.js';
import {
  createAgentDiscoveryRegistry,
  resolveSupportedEfforts,
} from '../../src/runtime/agent-discovery.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('agent-discovery', () => {
  it('discovers built-in agents, caches within TTL, and refreshes on demand without leaking secrets', async () => {
    const fakeHome = makeTempDir('tekon-home-');
    const fakeBin = join(fakeHome, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-6-custom' }),
      'utf8',
    );
    // Create fake executables so findExecutable finds claude & codex
    writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    let probeCalls = 0;
    let currentTime = new Date('2026-11-20T12:00:00.000Z').getTime();

    const registry = createAgentDiscoveryRegistry({
      userHome: fakeHome,
      env: {
        PATH: fakeBin,
        HOME: fakeHome,
        OPENAI_API_KEY: 'sk-super-secret-value-never-leak',
      },
      ttlMs: 60_000,
      now: () => new Date(currentTime),
      probeDeps: {
        runCommand: async (_cmd, args) => {
          probeCalls += 1;
          if (args.includes('--version')) return '2.1.0';
          if (args.includes('auth')) {
            return JSON.stringify({ loggedIn: true, authMethod: 'subscription' });
          }
          return undefined;
        },
      },
    });

    const snap1 = await registry.getSnapshot();
    expect(snap1.probedAt).toBe('2026-11-20T12:00:00.000Z');
    const claude = snap1.agents.find((a) => a.id === 'claude-code')!;
    const codex = snap1.agents.find((a) => a.id === 'codex')!;
    expect(claude.status).toBe('ready');
    expect(claude.models[0]).toBe('claude-opus-4-6-custom');
    expect(claude.efforts).toEqual(['default']);
    expect(codex.status).toBe('ready');
    expect(resolveSupportedEfforts(codex, 'gpt-5.4')).toContain('xhigh');
    expect(resolveSupportedEfforts(codex, 'o3')).toEqual(['low', 'medium', 'high']);

    // Never leaks raw API key in snapshot JSON
    expect(JSON.stringify(snap1)).not.toContain('sk-super-secret-value-never-leak');

    const callsAfterFirst = probeCalls;
    currentTime += 10_000;
    const snap2 = await registry.getSnapshot();
    expect(snap2.probedAt).toBe(snap1.probedAt);
    expect(probeCalls).toBe(callsAfterFirst);

    // Explicit refresh bypasses TTL cache
    currentTime += 5_000;
    const snap3 = await registry.refresh();
    expect(snap3.probedAt).toBe('2026-11-20T12:00:15.000Z');
    expect(probeCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('gracefully marks absent or timed-out CLIs without throwing', async () => {
    const emptyHome = makeTempDir('tekon-empty-home-');
    const registry = createAgentDiscoveryRegistry({
      userHome: emptyHome,
      env: { PATH: emptyHome, HOME: emptyHome },
      probeDeps: {
        runCommand: async () => undefined,
      },
    });

    const snap = await registry.getSnapshot();
    expect(snap.agents.find((a) => a.id === 'claude-code')?.status).toBe('not_installed');
    expect(snap.agents.find((a) => a.id === 'codex')?.status).toBe('not_installed');
  });

  it('loads custom agents only from ~/.tekon/agents.yaml and rejects command injection in repo .tekon/config.yaml', async () => {
    const fakeHome = makeTempDir('tekon-user-home-');
    const fakeRepo = makeTempDir('tekon-untrusted-repo-');
    mkdirSync(join(fakeHome, '.tekon'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.tekon', 'agents.yaml'),
      `agents:\n  - id: antigravity\n    name: Antigravity\n    iconKey: antigravity\n    models:\n      - gemini-4-neon\n    efforts:\n      - low\n      - medium\n      - high\n`,
      'utf8',
    );

    const registry = createAgentDiscoveryRegistry({
      userHome: fakeHome,
      env: { PATH: fakeHome, HOME: fakeHome },
    });
    const snap = await registry.getSnapshot();
    const custom = snap.agents.find((a) => a.id === 'antigravity');
    expect(custom).toBeDefined();
    expect(custom?.models).toEqual(['gemini-4-neon']);
    expect(custom?.source).toBe('user-config');

    // Untrusted repo .tekon/config.yaml attempting to inject custom agents/commands must be rejected by strict schema
    mkdirSync(join(fakeRepo, '.tekon'), { recursive: true });
    writeFileSync(
      join(fakeRepo, '.tekon', 'config.yaml'),
      `agents:\n  - id: evil\n    command: /bin/sh\n`,
      'utf8',
    );
    expect(() => readTekonConfig(fakeRepo)).toThrow();
  });

  it('clamps probe timeoutMs to <= 5000ms even when caller supplies a larger timeout', async () => {
    const fakeBin = makeTempDir('tekon-timeout-bin-');
    const claudeBin = join(fakeBin, 'claude');
    writeFileSync(claudeBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const seenTimeouts: number[] = [];
    const registry = createAgentDiscoveryRegistry({
      userHome: fakeBin,
      env: { PATH: fakeBin, HOME: fakeBin },
      probeDeps: {
        timeoutMs: 30_000,
        runCommand: async (_cmd, _args, _env, timeoutMs) => {
          seenTimeouts.push(timeoutMs);
          return undefined;
        },
      },
    });
    await registry.getSnapshot();
    expect(seenTimeouts.length).toBeGreaterThan(0);
    for (const t of seenTimeouts) {
      expect(t).toBeLessThanOrEqual(5_000);
    }
  });
});
