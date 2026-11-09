import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer, webDevModeFromEnv, type RunningWebServer } from '../../src/server/http.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startServer(): Promise<RunningWebServer> {
  const fixture = await createWebFixtureProject();
  const server = await createWebServer({ projectRoot: fixture.projectRoot, port: 0, vite: false });
  cleanups.push(async () => {
    await server.close();
    fixture.cleanup();
  });
  await server.listen();
  return server;
}

/** Raw request so the test can set any Host header. */
function send(
  server: RunningWebServer,
  input: { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: string }> {
  const url = new URL(server.url);
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: input.method,
        path: input.path,
        headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...input.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectPromise);
    req.end(payload);
  });
}

const listProjects = { path: 'project.list' };

describe('web server request host guard', () => {
  it('answers local hosts on any port', async () => {
    const server = await startServer();
    const port = new URL(server.url).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const response = await send(server, { method: 'POST', path: '/api/rpc', headers: { host }, body: listProjects });
      expect(response.status, host).toBe(200);
      expect(response.body).toContain('"result"');
    }
  });

  it('rejects any request whose Host is not local, before routing it', async () => {
    const server = await startServer();
    const host = `other.example:${new URL(server.url).port}`;
    const origin = `http://${host}`;
    const rpc = await send(server, { method: 'POST', path: '/api/rpc', headers: { host, origin }, body: listProjects });
    const page = await send(server, { method: 'GET', path: '/', headers: { host } });
    const events = await send(server, { method: 'GET', path: '/api/sessions/s1/events', headers: { host } });
    for (const response of [rpc, page, events]) {
      expect(response.status).toBe(403);
      expect(response.body).not.toContain('"result"');
    }
  });

  it('applies the origin check to read procedures that need no token', async () => {
    const server = await startServer();
    const response = await send(server, {
      method: 'POST',
      path: '/api/rpc',
      headers: { origin: 'http://elsewhere.example' },
      body: listProjects,
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain('Origin not allowed');
  });
});

describe('web server content security policy', () => {
  it('serves built assets with a script policy that forbids inline scripts, whatever NODE_ENV says', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const server = await startServer();
      const response = await fetch(server.url);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('web server dev mode switch', () => {
  it('uses the Vite dev middleware only when TEKON_WEB_DEV=1', () => {
    expect(webDevModeFromEnv({})).toBe(false);
    expect(webDevModeFromEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(webDevModeFromEnv({ TEKON_WEB_DEV: '0' })).toBe(false);
    expect(webDevModeFromEnv({ TEKON_WEB_DEV: '1' })).toBe(true);
  });
});
