import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandGateway, createRepositories, migrateDatabase, openTekonDatabase } from '@tekon/core';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebAgentRuntime } from '../../src/server/api/agents.js';

// PD-10/PD-24: the Web write baseline must match the CLI. createWebAgentRuntime
// previously hard-coded the read-only 'on-request' profile, so headless write
// nodes could not edit files. It now resolves to 'on-failure', which the Claude
// adapter turns into --permission-mode acceptEdits plus the role's
// --disallowedTools (the on-failure → acceptEdits mapping itself is locked by
// the core claude-code-adapter unit tests).
const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) cleanup();
});

describe('web write permission baseline', () => {
  it('builds an on-failure permission profile with a non-empty deny list for Claude', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const gateway = createCommandGateway({ repositories });

    const runtime = createWebAgentRuntime({
      agent: 'claude-code',
      repoPath: fixture.projectRoot,
      gateway,
    });

    const summary = runtime.configSummary as {
      permissionProfile: {
        approval: string;
        tools: { allow: string[]; deny: string[] };
      };
    };
    expect(summary.permissionProfile.approval).toBe('on-failure');
    // A concrete deny list is what the adapter serializes into --disallowedTools.
    expect(summary.permissionProfile.tools.deny.length).toBeGreaterThan(0);

    db.close();
  });

  it('no longer carries the read-only on-request default', async () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'tekon-web-baseline-'));
    cleanupTasks.push(() => rmSync(tempRepo, { recursive: true, force: true }));
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const gateway = createCommandGateway({ repositories: createRepositories(db) });

    const runtime = createWebAgentRuntime({
      agent: 'claude-code',
      repoPath: tempRepo,
      gateway,
    });

    const summary = runtime.configSummary as {
      permissionProfile: { approval: string };
    };
    expect(summary.permissionProfile.approval).not.toBe('on-request');
    db.close();
  });
});
