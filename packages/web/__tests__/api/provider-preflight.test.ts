import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProviderPreflight,
  createRepositories,
  openTekonDatabase,
} from '@tekon/core';

import { createApiCaller } from '../../src/server/api/root.js';
import { createWebFixtureProject } from '../fixtures/project.js';
import { installFakeProviderCommands } from '../fixtures/fake-provider-bin.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) await cleanup();
});

function runCount(projectRoot: string): number {
  const db = openTekonDatabase({ filename: join(projectRoot, '.tekon', 'tekon.sqlite') });
  try {
    return (db.prepare('select count(*) as count from workflow_instances').get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-web-preflight-'));
  cleanupTasks.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('provider preflight from Web', () => {
  it('refuses to start a run whose provider is not installed, without admitting it', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerPreflight: createProviderPreflight({ env: { PATH: emptyDir() } }),
    });
    cleanupTasks.push(() => api.close());
    const before = runCount(fixture.projectRoot);

    await expect(
      api.project.run({
        demandText: 'needs codex',
        token: fixture.sessionToken,
        agent: 'codex',
        mode: 'goal',
      }),
    ).rejects.toThrow(/PROVIDER_NOT_INSTALLED: 找不到 codex 命令.*下一步：/su);
    expect(runCount(fixture.projectRoot)).toBe(before);
  });

  it('returns the auth warning and passthrough names with an admitted run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const restorePath = installFakeProviderCommands('codex');
    cleanupTasks.push(restorePath);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerPreflight: createProviderPreflight({
        env: { PATH: process.env.PATH, CODEX_HOME: emptyDir() },
      }),
    });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'codex without login',
      token: fixture.sessionToken,
      agent: 'codex',
      mode: 'goal',
    });
    expect(result.preflight).toMatchObject({ provider: 'codex', auth: 'none' });
    expect(result.preflight?.warnings[0]).toContain('codex login');
  });

  it('checks the provider before recording an approval', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    await createRepositories(db).recordRunProviderConfig({
      runId: 'run_1',
      provider: 'codex',
      configSummary: {
        provider: 'codex',
        command: 'codex',
        args: [],
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 300_000,
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: [fixture.projectRoot],
          network: 'restricted',
          tools: { allow: ['git'], deny: ['rm'] },
        },
      },
      createdAt: '2026-11-11T00:00:00.000Z',
    });
    db.close();
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerPreflight: createProviderPreflight({ env: { PATH: emptyDir() } }),
    });
    cleanupTasks.push(() => api.close());

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        token: fixture.sessionToken,
      }),
    ).rejects.toThrow(/PROVIDER_NOT_INSTALLED: 找不到 codex 命令/u);
    const check = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    expect((await createRepositories(check).getHumanDecision('decision_1'))?.status).toBe('pending');
    check.close();
  });
});
