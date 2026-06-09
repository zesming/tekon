import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('web http rpc', () => {
  it('serves fallback html and routes typed RPC calls with write authorization', async () => {
    const fixture = await createWebFixtureProject();
    let server: RunningWebServer | null = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
    });
    cleanupTasks.push(async () => {
      await server?.close();
      server = null;
      fixture.cleanup();
    });
    await server.listen();

    await expect(
      fetch(server.url).then((response) => response.text()),
    ).resolves.toContain('Tekon Web');
    await expect(
      fetch(`${server.url}/api/rpc`, { method: 'GET' }).then((response) => ({
        status: response.status,
      })),
    ).resolves.toEqual({ status: 405 });

    const overview = await rpc<{ project: { id: string } }>(server.url, {
      path: 'project.overview',
    });
    expect(overview.project.id).toBe('project_1');

    await expect(
      rawRpc(server.url, {
        path: 'gate.approve',
        input: {
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'web-test',
          token: 'wrong-token',
        },
      }).then((response) => response.status),
    ).resolves.toBe(401);

    const approval = await rpc<{ decision: { status: string } }>(server.url, {
      path: 'gate.approve',
      input: {
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'web-test',
        note: 'approved over http',
        token: fixture.sessionToken,
      },
    });
    expect(approval.decision.status).toBe('approved');
  });
});

async function rpc<T>(
  baseUrl: string,
  body: { path: string; input?: unknown },
): Promise<T> {
  const response = await rawRpc(baseUrl, body);
  const payload = (await response.json()) as { result: T };
  expect(response.ok).toBe(true);
  return payload.result;
}

async function rawRpc(
  baseUrl: string,
  body: { path: string; input?: unknown },
): Promise<Response> {
  return fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
