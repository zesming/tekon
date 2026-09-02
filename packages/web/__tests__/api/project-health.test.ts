import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  TESTED_DSH_VERSION,
  isHostNodeVersionCompatible,
} from '@tekon/core';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];
const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalAllowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;

const VALID_CONFIG = [
  '- id: headless-runner',
  '- id: sandbox-policy',
  '- id: approval',
  '- id: session-persistence-jsonl',
  '- id: agent-default-model',
].join('\n');

function admitCurrentHostForFixture(): void {
  if (!isHostNodeVersionCompatible(process.versions.node)) {
    process.env.TEKON_DSH_ALLOW_HOST_NODE = process.versions.node;
  }
}

function installFakeDsh(input: {
  version?: string;
  help?: string;
  config?: string;
} = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-web-health-dsh-'));
  tempDirs.push(dir);
  const scriptPath = join(dir, 'dsh');
  const version = input.version ?? TESTED_DSH_VERSION;
  const help =
    input.help ?? 'dsh headless help: print the final assistant message';
  const config = input.config ?? VALID_CONFIG;
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.includes('--version')) process.stdout.write(${JSON.stringify(`${version}\n`)});\n` +
      `else if (args.includes('--help')) process.stdout.write(${JSON.stringify(`${help}\n`)});\n` +
      `else if (args.includes('--dump-default-config')) process.stdout.write(${JSON.stringify(`${config}\n`)});\n` +
      `else process.exitCode = 1;\n`,
    'utf8',
  );
  chmodSync(scriptPath, 0o755);
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;
}

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  process.env.PATH = originalPath;
  if (originalAllowHostNode === undefined) {
    delete process.env.TEKON_DSH_ALLOW_HOST_NODE;
  } else {
    process.env.TEKON_DSH_ALLOW_HOST_NODE = originalAllowHostNode;
  }
});

describe('project.health RPC (P1-UX-02 / P1-HEALTH-01)', () => {
  it('returns not-configured when no token is provided', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health();
    expect(result.credential).toBe('not-configured');
    expect(new Date(result.checkedAt).getTime()).not.toBeNaN();

    await api.close();
  });

  it('returns available only for the full matching DSH contract', async () => {
    admitCurrentHostForFixture();
    installFakeDsh();
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe('valid');
    expect(result.dshHeadless).toBe('available');

    await api.close();
  });

  it('does not call an untested DSH version available merely because --version exits', async () => {
    admitCurrentHostForFixture();
    installFakeDsh({ version: '0.1.2-alpha.4' });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe('valid');
    expect(result.dshHeadless).toBe('unavailable');

    await api.close();
  });

  it('does not call a matching binary available when help/config contracts drift', async () => {
    admitCurrentHostForFixture();
    installFakeDsh({ help: 'usage only', config: '- id: headless-runner' });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe('valid');
    expect(result.dshHeadless).toBe('unavailable');

    await api.close();
  });

  it('returns invalid when an incorrect session token is provided', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: 'wrong-token-value' });
    expect(result.credential).toBe('invalid');
    expect(result.detail).toBe(
      'Session token does not match server configuration',
    );
    expect(result.dshHeadless).toBeUndefined();

    await api.close();
  });

  it('caches health check results within the 60s window using hashed token', async () => {
    admitCurrentHostForFixture();
    installFakeDsh();
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const first = await api.project.health({ token: fixture.sessionToken });
    const second = await api.project.health({ token: fixture.sessionToken });

    expect(first.credential).toBe('valid');
    expect(second.credential).toBe('valid');
    expect(first.checkedAt).toBe(second.checkedAt);
    expect(first.dshHeadless).toBe('available');

    await api.close();
  });

  it('caps cache size at 128 entries and evicts oldest', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    for (let index = 0; index < 135; index += 1) {
      await api.project.health({ token: `token-load-test-${index}` });
    }

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe('valid');

    await api.close();
  });
});
