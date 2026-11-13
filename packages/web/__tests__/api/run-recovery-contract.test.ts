import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, findLatestRunFailure, openTekonDatabase } from '@tekon/core';

import { writeFakeClaude } from '../../../cli/__tests__/helpers/fake-provider.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { createWebFixtureProject } from '../fixtures/project.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) await cleanup();
});

function runStatus(projectRoot: string, runId: string): string | undefined {
  const db = openTekonDatabase({ filename: join(projectRoot, '.tekon', 'tekon.sqlite') });
  try {
    return (db.prepare('select status from workflow_instances where id = ?').get(runId) as
      | { status: string }
      | undefined)?.status;
  } finally {
    db.close();
  }
}

async function latestFailure(projectRoot: string, runId: string) {
  const db = openTekonDatabase({ filename: join(projectRoot, '.tekon', 'tekon.sqlite') });
  try {
    return findLatestRunFailure(await createRepositories(db).listAuditEvents(runId));
  } finally {
    db.close();
  }
}

function jobSettled(projectRoot: string, jobId: string): boolean {
  const db = openTekonDatabase({ filename: join(projectRoot, '.tekon', 'tekon.sqlite') });
  try {
    const row = db.prepare('select status from jobs where id = ?').get(jobId) as
      | { status: string }
      | undefined;
    return Boolean(row && !['queued', 'running', 'paused', 'cancelling'].includes(row.status));
  } finally {
    db.close();
  }
}

async function waitForStatus(projectRoot: string, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (runStatus(projectRoot, runId) !== status) {
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} is ${runStatus(projectRoot, runId)}, expected ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('run recovery contract from Web', () => {
  it('shows why a run stopped and finishes it with resume', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-web-recovery-bin-'));
    cleanupTasks.push(() => rmSync(binDir, { recursive: true, force: true }));
    writeFakeClaude(binDir, { behavior: 'fail-once' });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    cleanupTasks.push(() => { process.env.PATH = originalPath; });
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.unshift(() => api.close());

    const started = await api.project.run({
      demandText: 'Change the README once the provider works.',
      token: fixture.sessionToken,
      agent: 'claude-code',
      mode: 'goal',
    });
    await waitForStatus(fixture.projectRoot, started.run.id, 'interrupted');
    // The reason is recorded by the time the job has settled.
    const deadline = Date.now() + 30_000;
    while (!jobSettled(fixture.projectRoot, started.jobId!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await expect(latestFailure(fixture.projectRoot, started.run.id)).resolves.toMatchObject({
      kind: 'exit-nonzero',
    });

    const resumed = await api.project.resume({ runId: started.run.id, token: fixture.sessionToken });
    expect(resumed.jobId).toBeTruthy();
    await waitForStatus(fixture.projectRoot, started.run.id, 'passed');
    await expect(latestFailure(fixture.projectRoot, started.run.id)).resolves.toBeUndefined();
  }, 120_000);
});
