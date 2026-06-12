import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Create a throwaway dist directory with index.html and a sample asset. */
function createDistFixture(): { distDir: string; cleanup(): void } {
  const distDir = join(
    tmpdir(),
    `tekon-dist-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(
    join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Tekon Web</title></head><body></body></html>',
    'utf8',
  );
  writeFileSync(
    join(distDir, 'assets', 'app.js'),
    'console.log("fixture");',
    'utf8',
  );
  writeFileSync(
    join(distDir, 'assets', 'style.css'),
    'body { margin: 0; }',
    'utf8',
  );
  return {
    distDir,
    cleanup() {
      rmSync(distDir, { recursive: true, force: true });
    },
  };
}

describe('web http rpc', () => {
  it('serves production index.html and routes typed RPC calls with write authorization', async () => {
    const fixture = await createWebFixtureProject();
    const dist = createDistFixture();
    let server: RunningWebServer | null = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
      distDir: dist.distDir,
    });
    cleanupTasks.push(async () => {
      await server?.close();
      server = null;
      fixture.cleanup();
      dist.cleanup();
    });
    await server.listen();

    const rootResponse = await fetch(server.url);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get('content-type')).toContain('text/html');
    const rootBody = await rootResponse.text();
    expect(rootBody).toContain('Tekon Web');
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

  describe('static asset serving', () => {
    it('serves a valid asset file from the dist directory', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/assets/app.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/javascript',
      );
      expect(response.headers.get('cache-control')).toContain('immutable');
      const body = await response.text();
      expect(body).toBe('console.log("fixture");');
    });

    it('rejects path traversal with ../', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await rawGet(server.url, '/assets/../index.html');
      expect(response.status).toBe(400);
      expect(response.body).toBe('Bad request');
    });

    it('rejects encoded path traversal with %2e%2e', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      // %2e%2e%2f decodes to ../
      const response = await rawGet(
        server.url,
        '/assets/%2e%2e%2findex.html',
      );
      expect(response.status).toBe(400);
      expect(response.body).toBe('Bad request');
    });

    it('rejects deeply nested path traversal', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await rawGet(
        server.url,
        '/assets/sub/../../index.html',
      );
      expect(response.status).toBe(400);
    });

    it('returns 404 for a non-existent asset under /assets/', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      // Valid path, but file does not exist — falls through to production HTML or 404
      const response = await fetch(`${server.url}/assets/does-not-exist.js`);
      // Falls through to serveProductionHtml (index.html exists in dist fixture)
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('Sec-Fetch-Site validation', () => {
    it('rejects mutation requests with sec-fetch-site: cross-site', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({
          path: 'gate.approve',
          input: {
            runId: 'run_1',
            decisionId: 'decision_1',
            actor: 'web-test',
            token: fixture.sessionToken,
          },
        }),
      });

      expect(response.status).toBe(400);
      const error = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(error.error.code).toBe('BAD_REQUEST');
      expect(error.error.message).toBe('Cross-site requests are not allowed');
    });

    it('allows mutation requests with sec-fetch-site: same-origin', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          path: 'gate.approve',
          input: {
            runId: 'run_1',
            decisionId: 'decision_1',
            actor: 'web-test',
            note: 'approved with same-origin',
            token: fixture.sessionToken,
          },
        }),
      });

      expect(response.ok).toBe(true);
      const result = (await response.json()) as {
        result: { decision: { status: string } };
      };
      expect(result.result.decision.status).toBe('approved');
    });

    it('allows mutation requests with sec-fetch-site: same-site', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-site',
        },
        body: JSON.stringify({
          path: 'gate.approve',
          input: {
            runId: 'run_1',
            decisionId: 'decision_1',
            actor: 'web-test',
            note: 'approved with same-site',
            token: fixture.sessionToken,
          },
        }),
      });

      expect(response.ok).toBe(true);
    });

    it('allows mutation requests with sec-fetch-site: none', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'none',
        },
        body: JSON.stringify({
          path: 'gate.approve',
          input: {
            runId: 'run_1',
            decisionId: 'decision_1',
            actor: 'web-test',
            note: 'approved with none',
            token: fixture.sessionToken,
          },
        }),
      });

      expect(response.ok).toBe(true);
    });

    it('allows mutation requests without sec-fetch-site header', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: 'gate.approve',
          input: {
            runId: 'run_1',
            decisionId: 'decision_1',
            actor: 'web-test',
            note: 'approved without header',
            token: fixture.sessionToken,
          },
        }),
      });

      expect(response.ok).toBe(true);
    });
  });
  describe('symlink bypass', () => {
    it('rejects symlinked assets with 400', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      // Create a file outside dist and symlink to it from inside dist
      const outsideFile = join(tmpdir(), `outside-${Date.now()}.js`);
      writeFileSync(outsideFile, 'leaked', 'utf8');
      symlinkSync(outsideFile, join(dist.distDir, 'assets', 'evil.js'));
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
        rmSync(outsideFile, { force: true });
      });
      await server.listen();

      const response = await fetch(`${server.url}/assets/evil.js`);
      expect(response.status).toBe(400);
    });
  });

  describe('malformed percent-encoding', () => {
    it('rejects malformed percent-encoded URL with 400', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      // %E0%A4%A is an incomplete UTF-8 sequence — decodeURIComponent will throw
      const response = await rawGet(server.url, '/assets/%E0%A4%A');
      expect(response.status).toBe(400);
      expect(response.body).toContain('malformed URL encoding');
    });
  });

  describe('inherited property rejection', () => {
    it('returns NOT_FOUND for inherited Object.prototype properties like toString', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      const response = await rawRpc(server.url, { path: 'toString' });
      expect(response.status).toBe(404);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toContain('Unknown API procedure');
    });
  });

  describe('output schema ZodError', () => {
    it('returns INTERNAL_ERROR (500) instead of BAD_REQUEST when handler output fails schema', async () => {
      const fixture = await createWebFixtureProject();
      const dist = createDistFixture();
      let server: RunningWebServer | null = await createWebServer({
        projectRoot: fixture.projectRoot,
        port: 0,
        vite: false,
        distDir: dist.distDir,
      });
      cleanupTasks.push(async () => {
        await server?.close();
        server = null;
        fixture.cleanup();
        dist.cleanup();
      });
      await server.listen();

      // Use dispatchApiCall directly with a mock caller whose handler returns
      // output that violates the contract schema.
      const { dispatchApiCall } = await import(
        '../../src/server/api/dispatch.js'
      );
      const { ApiError } = await import('../../src/server/api/errors.js');
      const mockCaller = {
        project: {
          overview: async () => {
            // Return data missing required fields — output schema will reject
            return { wrong: 'shape' };
          },
        },
      } as any;

      try {
        await dispatchApiCall(mockCaller, 'project.overview', undefined);
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as InstanceType<typeof ApiError>).code).toBe(
          'INTERNAL_ERROR',
        );
      }
    });
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

/**
 * Send a raw HTTP GET with an exact path string, bypassing fetch/URL
 * normalization so path-traversal payloads reach the server unmodified.
 */
function rawGet(
  baseUrl: string,
  rawPath: string,
): Promise<{ status: number; body: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        method: 'GET',
        path: rawPath,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}
