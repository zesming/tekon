import { delimiter } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openTekonDatabase } from '@tekon/core';
import { writeFakeClaude } from '../../../cli/__tests__/helpers/fake-provider.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { createWebFixtureProject } from '../fixtures/project.js';

// TS-01: a write node started from the Web must reach Claude with the same
// on-failure permission profile as the CLI — acceptEdits and a concrete deny
// list — proven through the real API caller and a fake provider, not only by
// reading the runtime's configSummary.
const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) cleanup();
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

async function waitForStatus(
  projectRoot: string,
  runId: string,
  status: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (runStatus(projectRoot, runId) !== status) {
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} is ${runStatus(projectRoot, runId)}, expected ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Claude write permission argv from the Web entry (TS-01)', () => {
  it('starts a goal run with acceptEdits and a non-empty disallowedTools list', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const binDir = mkdtempSync(join(tmpdir(), 'tekon-web-claude-argv-'));
    cleanupTasks.push(() => rmSync(binDir, { recursive: true, force: true }));
    const capture = join(binDir, 'calls.jsonl');
    writeFakeClaude(binDir, { behavior: 'success', captureFile: capture });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    cleanupTasks.push(() => {
      process.env.PATH = originalPath;
    });

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const started = await api.project.run({
      demandText: 'Web write node must carry the on-failure permission profile.',
      mode: 'goal',
      agent: 'claude-code',
      token: fixture.sessionToken,
      allowDirtyBase: true,
    });
    expect(started.jobId).toBeTruthy();
    await waitForStatus(fixture.projectRoot, started.run.id, 'passed');

    const invocations = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] });
    const providerRun = invocations.find((entry) =>
      entry.argv.includes('--permission-mode'),
    );
    expect(providerRun, JSON.stringify(invocations)).toBeDefined();
    const argv = providerRun!.argv;
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const denyIndex = argv.indexOf('--disallowedTools');
    expect(denyIndex).toBeGreaterThan(-1);
    const nextFlag = argv
      .slice(denyIndex + 1)
      .findIndex((value) => value.startsWith('--'));
    const denyValues = nextFlag === -1
      ? argv.slice(denyIndex + 1)
      : argv.slice(denyIndex + 1, denyIndex + 1 + nextFlag);
    expect(denyValues.length).toBeGreaterThan(0);
    expect(denyValues.some((value) => value.includes('rm') || value.includes('sudo'))).toBe(true);
  }, 120_000);
});
