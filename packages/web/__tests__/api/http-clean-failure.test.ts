import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/api/root.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/server/api/root.js')
  >();
  return {
    ...actual,
    createApiCaller: vi.fn(async () => ({
      project: {
        clean: async () => {
          const { ApiError } = await import(
            '../../src/server/api/errors.js'
          );
          throw new ApiError(
            'INTERNAL_ERROR',
            'CLEAN_AUDIT_FAILED: unable to record suspended clean request',
          );
        },
      },
      close: async () => {},
    })),
  };
});

import { createWebServer } from '../../src/server/http.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) await cleanup();
});

describe('project.clean HTTP audit failure mapping', () => {
  it('returns a fixed 500 response without exposing the underlying audit error', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'tekon-clean-http-'));
    const distDir = mkdtempSync(join(tmpdir(), 'tekon-clean-http-dist-'));
    mkdirSync(join(projectRoot, '.tekon'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.tekon', 'web-session.json'),
      JSON.stringify({ token: 'fixture-session-token' }),
    );
    writeFileSync(join(distDir, 'index.html'), '<!doctype html>');
    const server = await createWebServer({
      projectRoot,
      port: 0,
      vite: false,
      distDir,
    });
    cleanupTasks.push(async () => {
      await server.close();
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(distDir, { recursive: true, force: true });
    });
    await server.listen();

    const response = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        path: 'project.clean',
        input: {
          runId: 'run_1',
          token: 'fixture-session-token',
          confirm: 'delete-run-dir',
        },
      }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message:
        'CLEAN_AUDIT_FAILED: unable to record suspended clean request',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /Disk write failure|database is locked|SQLITE/u,
    );
  });
});
