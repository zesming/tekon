import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import {
  REQUIRED_DSH_PLUGIN_IDS,
  TESTED_DSH_VERSION,
} from '@tekon/core';

const cleanupTasks: Array<() => Promise<void> | void> = [];

/**
 * The host running these tests may not satisfy DSH's Node requirement
 * (e.g. Node 22.16 < 22.19). Set the exact-match escape hatch so the
 * preflight does not reject the run before it reaches the network gate.
 */
function allowHostNodeForDsh(): void {
  process.env.TEKON_DSH_ALLOW_HOST_NODE = process.versions.node;
  cleanupTasks.push(() => {
    delete process.env.TEKON_DSH_ALLOW_HOST_NODE;
  });
}

/**
 * Create a fake `dsh` binary on PATH that satisfies the preflight contract
 * (version + headless help anchor + required plugin ids), so tests exercise
 * the run path rather than the preflight rejection.
 */
function installFakeDsh(): string {
  const binDir = join(tmpdir(), `tekon-fake-dsh-${process.pid}`);
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'dsh');
  const helpAnchor = 'print the final assistant message';
  const configYaml = REQUIRED_DSH_PLUGIN_IDS.map(
    (id) => `- id: ${id}`,
  ).join('\n');
  const lines = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    `if (args.includes('--version')) { process.stdout.write('${TESTED_DSH_VERSION}' + '\\n'); }`,
    `else if (args.includes('--help')) { process.stdout.write('${helpAnchor}' + '\\n'); }`,
    `else if (args.includes('--dump-default-config')) { process.stdout.write(${JSON.stringify(
      `${configYaml}\n`,
    )}); }`,
    '',
  ];
  writeFileSync(script, lines.join('\n'));
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  cleanupTasks.push(() => {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
  });
  return binDir;
}

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('project.run unrestricted network verification (P1-SEC-01)', () => {
  it('hard-rejects dsh-headless run when unrestricted network is not acknowledged', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'test dsh unacknowledged',
        token: fixture.sessionToken,
        agent: 'dsh-headless',
        mode: 'goal',
      }),
    ).rejects.toThrow('联网不受限需知情确认');
  });

  it('admits dsh-headless run when unrestricted network is explicitly acknowledged', async () => {
    allowHostNodeForDsh();
    installFakeDsh();
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'test dsh acknowledged',
      token: fixture.sessionToken,
      agent: 'dsh-headless',
      mode: 'goal',
      acknowledgeUnrestrictedNetwork: true,
    });

    expect(result.sessionId).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.run.status).toBe('running');

    // Verify audit contains the network acknowledgment event
    const auditRes = await api.audit.list({ runId: result.run.id });
    const netAckEvent = auditRes.events.find(
      (e) => e.type === 'run.network-acknowledged',
    );
    expect(netAckEvent).toBeDefined();
    expect(netAckEvent?.payload).toMatchObject({
      agent: 'dsh-headless',
      acknowledgeUnrestrictedNetwork: true,
    });
  });

  it('admits codex run without unrestricted network acknowledgment', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'test codex normal run',
      token: fixture.sessionToken,
      agent: 'codex',
      mode: 'goal',
    });

    expect(result.sessionId).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.run.status).toBe('running');
  });
  it('does not record run.network-acknowledged audit for codex even if acknowledgedNetwork flag is passed', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'test codex with ack flag',
      token: fixture.sessionToken,
      agent: 'codex',
      mode: 'goal',
      acknowledgeUnrestrictedNetwork: true,
    });

    const auditRes = await api.audit.list({ runId: result.run.id });
    const netAckEvent = auditRes.events.find(
      (e) => e.type === 'run.network-acknowledged',
    );
    expect(netAckEvent).toBeUndefined();
  });
});
