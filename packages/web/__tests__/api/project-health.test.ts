import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TESTED_DSH_VERSION, isHostNodeVersionCompatible } from '@tekon/core';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller, dispatchApiCall } from '../../src/server/api/root.js';

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

function installFakeDsh(
  input: {
    version?: string;
    help?: string;
    config?: string;
  } = {},
): void {
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

  it('validates credentials without waiting for or invoking a provider probe', async () => {
    const providerProbe = vi.fn(async () => 'available' as const);
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerProbe,
    });

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe('valid');
    expect(result.dshHeadless).toBeUndefined();
    expect(providerProbe).not.toHaveBeenCalled();

    await api.close();
  });

  it('returns available only from the separate authenticated provider health endpoint', async () => {
    admitCurrentHostForFixture();
    installFakeDsh();
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { provider: string; status: string; checkedAt: string };
    expect(result).toMatchObject({
      provider: 'dsh-headless',
      status: 'available',
    });
    expect(new Date(result.checkedAt).getTime()).not.toBeNaN();

    await api.close();
  });

  it('does not call an untested DSH version available merely because --version exits', async () => {
    admitCurrentHostForFixture();
    installFakeDsh({ version: '0.1.2-alpha.4' });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: string };
    expect(result.status).toBe('unavailable');

    await api.close();
  });

  it('rejects a matching binary when the help contract drifts', async () => {
    admitCurrentHostForFixture();
    installFakeDsh({ help: 'usage only' });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: string };
    expect(result.status).toBe('unavailable');

    await api.close();
  });

  it('rejects a matching binary when the config contract drifts', async () => {
    admitCurrentHostForFixture();
    installFakeDsh({ config: '- id: headless-runner' });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: string };
    expect(result.status).toBe('unavailable');

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

  it('uses exact token semantics and rejects an otherwise valid token with whitespace', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({
      token: `${fixture.sessionToken} `,
    });
    expect(result.credential).toBe('invalid');
    await expect(
      dispatchApiCall(api, 'project.providerHealth', {
        token: `${fixture.sessionToken} `,
        provider: 'dsh-headless',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });

  it('deduplicates concurrent provider probes and caches unavailable results for the same authenticated scope', async () => {
    let releaseProbe!: () => void;
    const providerProbe = vi.fn(
      () =>
        new Promise<'unavailable'>((resolve) => {
          releaseProbe = () => resolve('unavailable');
        }),
    );
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerProbe,
    });

    const requests = Array.from({ length: 8 }, () =>
      dispatchApiCall(api, 'project.providerHealth', {
        token: fixture.sessionToken,
        provider: 'dsh-headless',
      }),
    );
    await vi.waitFor(() => expect(providerProbe).toHaveBeenCalledTimes(1));
    releaseProbe();
    const results = (await Promise.all(requests)) as Array<{
      status: string;
      checkedAt: string;
    }>;

    expect(results.every((result) => result.status === 'unavailable')).toBe(
      true,
    );
    expect(new Set(results.map((result) => result.checkedAt))).toHaveLength(1);
    const cached = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: string };
    expect(cached.status).toBe('unavailable');
    expect(providerProbe).toHaveBeenCalledTimes(1);

    await api.close();
  });

  it('authenticates before consulting provider cache or starting a probe', async () => {
    const providerProbe = vi.fn(async () => 'available' as const);
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerProbe,
    });

    await expect(
      dispatchApiCall(api, 'project.providerHealth', {
        token: 'wrong-token-value',
        provider: 'dsh-headless',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(providerProbe).not.toHaveBeenCalled();

    await expect(
      dispatchApiCall(api, 'project.providerHealth', {
        provider: 'dsh-headless',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(providerProbe).not.toHaveBeenCalled();

    await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    });
    expect(providerProbe).toHaveBeenCalledTimes(1);

    await api.close();
  });

  it('revalidates the token before cache access after server-side rotation', async () => {
    const providerProbe = vi.fn(async () => 'available' as const);
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerProbe,
    });

    await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    });
    expect(providerProbe).toHaveBeenCalledTimes(1);

    const rotatedToken = 'rotated-fixture-session-token';
    writeFileSync(
      join(fixture.projectRoot, '.tekon', 'web-session.json'),
      JSON.stringify({ token: rotatedToken }),
      'utf8',
    );
    await expect(
      dispatchApiCall(api, 'project.providerHealth', {
        token: fixture.sessionToken,
        provider: 'dsh-headless',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(providerProbe).toHaveBeenCalledTimes(1);

    await dispatchApiCall(api, 'project.providerHealth', {
      token: rotatedToken,
      provider: 'dsh-headless',
    });
    expect(providerProbe).toHaveBeenCalledTimes(2);

    await api.close();
  });

  it('maps provider probe errors to unavailable without exposing raw details', async () => {
    const providerProbe = vi.fn(async () => {
      throw new Error(
        'secret-token at http://user:password@proxy.internal/private/path',
      );
    });
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      providerProbe,
    });

    const result = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: 'available' | 'unavailable' };
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(
      /secret-token|password|proxy\.internal|private\/path/u,
    );
    const cached = (await dispatchApiCall(api, 'project.providerHealth', {
      token: fixture.sessionToken,
      provider: 'dsh-headless',
    })) as { status: 'available' | 'unavailable' };
    expect(cached.status).toBe('unavailable');
    expect(providerProbe).toHaveBeenCalledTimes(1);

    await api.close();
  });
});
