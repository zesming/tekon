import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { createWebServer, type RunningWebServer } from '../../src/server/http.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

async function postRpc(
  server: RunningWebServer,
  path: string,
  input: unknown,
): Promise<{ status: number; body: unknown }> {
  const u = new URL(server.url);
  const payload = JSON.stringify({ path, input });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    Origin: server.url,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        method: 'POST',
        path: '/api/rpc',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('workflow.plan RPC', () => {
  it('returns run plan for standard template via apiCaller', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const plan = await api.workflow.plan({
      template: 'standard-feature',
      agent: 'codex',
    });

    expect(plan.roleChain).toEqual(['pm', 'rd', 'qa', 'reviewer', 'pmo']);
    expect(plan.requiresUnrestrictedNetwork).toBe(false);
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.gates.length).toBeGreaterThanOrEqual(1);
    expect(plan.gates.some((g) => g.type === 'build')).toBe(true);
    expect(plan.gates.some((g) => g.type === 'lint')).toBe(true);
  });

  it('marks requiresUnrestrictedNetwork true for dsh-headless', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const plan = await api.workflow.plan({
      template: 'bugfix',
      agent: 'dsh-headless',
    });

    expect(plan.requiresUnrestrictedNetwork).toBe(true);
  });

  it('projects goal mode plan with built-in goal template', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const plan = await api.workflow.plan({
      mode: 'goal',
      agent: 'dsh-headless',
    });

    expect(plan.roleChain).toEqual(['goal']);
    expect(plan.requiresUnrestrictedNetwork).toBe(true);
    expect(plan.gates).toEqual([]);
    expect(plan.phases).toEqual([
      {
        id: 'goal',
        name: 'Goal',
        parallel: false,
        nodeIds: ['goal-execute'],
      },
    ]);
  });

  it('throws NOT_FOUND for non-existent template', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    await expect(
      api.workflow.plan({ template: 'does-not-exist' }),
    ).rejects.toThrow(/not found/i);
  });

  it('works over HTTP without authentication (auth: none)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
    });
    await server.listen();
    cleanupTasks.push(() => server.close());

    const res = await postRpc(server, 'workflow.plan', {
      template: 'bugfix',
      agent: 'codex',
    });

    expect(res.status).toBe(200);
    const body = res.body as { result: { roleChain: string[]; requiresUnrestrictedNetwork: boolean } };
    expect(body.result.roleChain).toContain('rd');
    expect(body.result.requiresUnrestrictedNetwork).toBe(false);
  });
});
