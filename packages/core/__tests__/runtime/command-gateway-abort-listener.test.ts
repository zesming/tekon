import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandGateway } from '../../src/index.js';

function createFakeChild(input?: {
  onKill?: (signal: NodeJS.Signals) => void;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.kill = ((signal?: NodeJS.Signals) => {
    const resolvedSignal = signal ?? 'SIGTERM';
    input?.onKill?.(resolvedSignal);
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, resolvedSignal);
    });
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

function completeSuccessfully(child: ChildProcessWithoutNullStreams): void {
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  });
}

describe('command gateway AbortSignal listener lifecycle', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the per-command abort listener after every settled command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-abort-listener-'));
    tempDirs.push(cwd);
    const controller = new AbortController();
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = createFakeChild();
        completeSuccessfully(child);
        return child;
      },
    });

    for (let index = 0; index < 12; index += 1) {
      await expect(
        gateway.run({
          command: { tool: 'node', args: [`command-${index}.js`] },
          cwd,
          signal: controller.signal,
          policy: {
            allow: [{ tool: 'node', args: [] }],
            deny: [],
            cwdScope: [cwd],
            network: 'disabled',
          },
        }),
      ).resolves.toMatchObject({
        status: 'executed',
        exitCode: 0,
        timedOut: false,
      });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('observes an abort that fires during spawn before listener registration', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-abort-spawn-race-'));
    tempDirs.push(cwd);
    const controller = new AbortController();
    const killSignals: NodeJS.Signals[] = [];
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = createFakeChild({
          onKill: (signal) => killSignals.push(signal),
        });
        // Reproduce the narrow window after the pre-spawn `aborted` check but
        // before CommandGateway has registered its per-child abort listener.
        controller.abort();
        return child;
      },
    });

    const result = await gateway.run({
      command: { tool: 'node', args: ['long-running.js'] },
      cwd,
      signal: controller.signal,
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      status: 'executed',
      exitCode: null,
      signal: 'SIGKILL',
    });
    expect(killSignals).toEqual(['SIGKILL']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
