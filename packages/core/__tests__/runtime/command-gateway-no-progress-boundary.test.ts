import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandGateway } from '../../src/index.js';

describe('command gateway no-progress boundary', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rechecks the output directory before timing out activity just beyond the first idle sample', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-no-progress-boundary-'));
    tempDirs.push(cwd);
    const outputDir = join(cwd, 'logs');
    mkdirSync(outputDir, { recursive: true });
    const killSignals: NodeJS.Signals[] = [];

    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = ((signal?: NodeJS.Signals) => {
          killSignals.push(signal ?? 'SIGTERM');
          return true;
        }) as ChildProcessWithoutNullStreams['kill'];

        // The first no-progress threshold is 80 ms. Activity lands just after
        // that observation, before a second confirmation may terminate work.
        setTimeout(() => {
          writeFileSync(join(outputDir, 'artifact.json'), '{"ready":true}');
        }, 90);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        }, 140);
        return child;
      },
    });

    const result = await gateway.run({
      command: { tool: 'node', args: ['write-artifact.js'] },
      cwd,
      outputDir,
      timeoutMs: 1_000,
      noProgressTimeoutMs: 80,
      progressIntervalMs: 20,
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      status: 'executed',
      exitCode: 0,
      timedOut: false,
    });
    expect(killSignals).toEqual([]);
  });
});
