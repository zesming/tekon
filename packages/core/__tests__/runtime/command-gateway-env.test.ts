import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  type SpawnImpl,
} from '../../src/runtime/command-gateway.js';

describe('command gateway environment boundary', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('does not pass sensitive parent environment variables by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-env-'));
    tempDirs.push(cwd);
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'secret-value';
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      receivedEnv = options.env;
      throw new Error('stop before spawn');
    };

    try {
      const gateway = createCommandGateway({ spawnImpl });
      const result = await gateway.run({
        command: { tool: 'node', args: ['-v'] },
        cwd,
        policy: {
          allow: [{ tool: 'node', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      });

      expect(result.status).toBe('rejected');
      expect(receivedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(receivedEnv?.PATH).toBeTruthy();
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });

  it('supports exact env for manual provider smoke', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-env-'));
    tempDirs.push(cwd);
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      receivedEnv = options.env;
      throw new Error('stop before spawn');
    };

    const gateway = createCommandGateway({ spawnImpl });
    await gateway.run({
      command: { tool: 'node', args: ['-v'] },
      cwd,
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      envMode: 'exact',
      env: { PATH: '/usr/bin', HOME: '/tmp/tekon-home' },
    });

    expect(receivedEnv).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/tekon-home',
    });
  });
});
