import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('progress.list', () => {
  it('returns empty array when no progress files exist', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.progress.list({ runId: 'run_1' });
    expect(result.runId).toBe('run_1');
    expect(result.progressFiles).toEqual([]);
  });

  it('reads progress files with all required fields', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const tekonDir = join(fixture.projectRoot, '.tekon');
    const runDir = join(tekonDir, 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });

    const progressData = {
      nodeId: 'node_1',
      status: 'running',
      command: 'tekon run --token secret-token-123 --agent codex',
      startedAt: '2026-06-12T10:00:00.000Z',
      updatedAt: new Date().toISOString(),
      elapsedMs: 45000,
      timeoutMs: 600000,
      noProgressTimeoutMs: 900000,
      timeoutReason: null,
      lastOutputAt: new Date().toISOString(),
      stdoutBytes: 1024,
      stderrBytes: 256,
      lastOutputDirAt: new Date().toISOString(),
      outputDirFileCount: 5,
      heartbeatCount: 10,
    };

    writeFileSync(
      join(runDir, 'node_1.progress.json'),
      JSON.stringify(progressData, null, 2),
      'utf8',
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.progress.list({ runId: 'run_1' });

    expect(result.runId).toBe('run_1');
    expect(result.progressFiles).toHaveLength(1);

    const file = result.progressFiles[0]!;

    expect(file.nodeId).toBe('node_1');
    expect(file.status).toBe('running');
    expect(file.startedAt).toBe('2026-06-12T10:00:00.000Z');
    expect(file.updatedAt).toBeTruthy();
    expect(file.elapsedMs).toBe(45000);
    expect(file.timeoutMs).toBe(600000);
    expect(file.noProgressTimeoutMs).toBe(900000);
    expect(file.timeoutReason).toBeNull();

    expect(file.lastOutputAt).toBeTruthy();
    expect(file.stdoutBytes).toBe(1024);
    expect(file.stderrBytes).toBe(256);
    expect(file.lastOutputDirAt).toBeTruthy();
    expect(file.outputDirFileCount).toBe(5);
    expect(file.heartbeatCount).toBe(10);

    expect(typeof file.approachingTimeout).toBe('boolean');
    expect(typeof file.secondsRemaining).toBe('number');
    expect(file.secondsRemaining).toBeGreaterThanOrEqual(0);

    expect(file.redactedCommand).toContain('[REDACTED]');
    expect(file.redactedCommand).not.toContain('secret-token-123');
  });

  it('calculates approachingTimeout correctly', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const tekonDir = join(fixture.projectRoot, '.tekon');
    const runDir = join(tekonDir, 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });

    const noProgressTimeoutMs = 100000;
    const updatedAt = new Date(
      Date.now() - noProgressTimeoutMs * 0.85,
    ).toISOString();

    writeFileSync(
      join(runDir, 'node_1.progress.json'),
      JSON.stringify({
        nodeId: 'node_1',
        status: 'running',
        updatedAt,
        noProgressTimeoutMs,
      }),
      'utf8',
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.progress.list({ runId: 'run_1' });
    const file = result.progressFiles[0]!;

    expect(file.approachingTimeout).toBe(true);
    expect(file.secondsRemaining).toBeLessThan(noProgressTimeoutMs * 0.2 / 1000);
  });

  it('sets approachingTimeout to false when recently updated', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const tekonDir = join(fixture.projectRoot, '.tekon');
    const runDir = join(tekonDir, 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });

    const noProgressTimeoutMs = 900000;
    const updatedAt = new Date().toISOString();

    writeFileSync(
      join(runDir, 'node_1.progress.json'),
      JSON.stringify({
        nodeId: 'node_1',
        status: 'running',
        updatedAt,
        noProgressTimeoutMs,
      }),
      'utf8',
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.progress.list({ runId: 'run_1' });
    const file = result.progressFiles[0]!;

    expect(file.approachingTimeout).toBe(false);
    expect(file.secondsRemaining).toBeGreaterThan(0);
  });

  it('defaults missing fields to safe values', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const tekonDir = join(fixture.projectRoot, '.tekon');
    const runDir = join(tekonDir, 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runDir, 'minimal.progress.json'),
      JSON.stringify({ status: 'pending' }),
      'utf8',
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.progress.list({ runId: 'run_1' });
    const file = result.progressFiles[0]!;

    expect(file.nodeId).toBeNull();
    expect(file.status).toBe('pending');
    expect(file.elapsedMs).toBe(0);
    expect(file.timeoutMs).toBeNull();
    expect(file.noProgressTimeoutMs).toBe(900000);
    expect(file.timeoutReason).toBeNull();
    expect(file.lastOutputAt).toBeNull();
    expect(file.stdoutBytes).toBe(0);
    expect(file.stderrBytes).toBe(0);
    expect(file.lastOutputDirAt).toBeNull();
    expect(file.outputDirFileCount).toBe(0);
    expect(file.heartbeatCount).toBe(0);
    expect(file.redactedCommand).toBe('not recorded');
  });

  it('skips malformed progress files', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const tekonDir = join(fixture.projectRoot, '.tekon');
    const runDir = join(tekonDir, 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runDir, 'broken.progress.json'),
      'not valid json {{{',
      'utf8',
    );

    writeFileSync(
      join(runDir, 'valid.progress.json'),
      JSON.stringify({ nodeId: 'valid_node', status: 'running' }),
      'utf8',
    );

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const result = await api.progress.list({ runId: 'run_1' });

    expect(result.progressFiles).toHaveLength(1);
    expect(result.progressFiles[0]!.nodeId).toBe('valid_node');
  });
});
