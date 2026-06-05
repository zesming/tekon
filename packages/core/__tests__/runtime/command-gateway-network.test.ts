import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  type SpawnImpl,
} from '../../src/runtime/command-gateway.js';

describe('command gateway network policy', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each([
    { tool: 'curl', args: ['https://example.com'] },
    { tool: 'wget', args: ['https://example.com'] },
    { tool: 'ssh', args: ['git@example.com'] },
    { tool: 'scp', args: ['file.txt', 'host:/tmp/file.txt'] },
    { tool: 'sftp', args: ['host'] },
    { tool: 'git', args: ['fetch'] },
    { tool: 'git', args: ['pull'] },
    { tool: 'git', args: ['push'] },
    { tool: 'git', args: ['clone', 'https://example.com/repo.git'] },
    { tool: 'git', args: ['ls-remote', 'origin'] },
    { tool: 'git', args: ['submodule', 'update', '--init'] },
    { tool: 'npm', args: ['install'] },
    { tool: 'npm', args: ['add', 'left-pad'] },
    { tool: 'npm', args: ['update'] },
    { tool: 'pnpm', args: ['install'] },
    { tool: 'pnpm', args: ['add', 'left-pad'] },
    { tool: 'pnpm', args: ['update'] },
    { tool: 'pnpm', args: ['dlx', 'tsx'] },
    { tool: 'pnpm', args: ['exec', 'tsx'] },
    { tool: 'npx', args: ['tsx'] },
    { tool: 'gh', args: ['api', '/repos/owner/repo'] },
    { tool: 'gh', args: ['pr', 'view'] },
    { tool: 'gh', args: ['repo', 'clone', 'owner/repo'] },
    { tool: 'gh', args: ['run', 'list'] },
  ])(
    'rejects known network command $tool $args before spawn when network is disabled',
    async (command) => {
      const cwd = mkdtempSync(join(tmpdir(), 'donkey-network-disabled-'));
      tempDirs.push(cwd);
      let spawnCalls = 0;
      const spawnImpl: SpawnImpl = () => {
        spawnCalls += 1;
        throw new Error('spawn should not run');
      };
      const gateway = createCommandGateway({ spawnImpl });

      const result = await gateway.run({
        command,
        cwd,
        policy: {
          allow: [command],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      });

      expect(result).toEqual({
        status: 'rejected',
        reason: 'network command is not allowed by policy',
      });
      expect(spawnCalls).toBe(0);
    },
  );

  it.each([
    { tool: 'curl', args: ['https://example.com'] },
    { tool: 'git', args: ['fetch'] },
    { tool: 'npm', args: ['install'] },
    { tool: 'pnpm', args: ['dlx', 'tsx'] },
    { tool: 'npx', args: ['tsx'] },
    { tool: 'gh', args: ['api', '/repos/owner/repo'] },
  ])(
    'rejects known network command $tool $args before spawn when network is restricted',
    async (command) => {
      const cwd = mkdtempSync(join(tmpdir(), 'donkey-network-restricted-'));
      tempDirs.push(cwd);
      let spawnCalls = 0;
      const spawnImpl: SpawnImpl = () => {
        spawnCalls += 1;
        throw new Error('spawn should not run');
      };
      const gateway = createCommandGateway({ spawnImpl });

      const result = await gateway.run({
        command,
        cwd,
        policy: {
          allow: [command],
          deny: [],
          cwdScope: [cwd],
          network: 'restricted',
        },
      });

      expect(result).toEqual({
        status: 'rejected',
        reason: 'network command is not allowed by policy',
      });
      expect(spawnCalls).toBe(0);
    },
  );

  it('does not reject known network commands by the static network rule when network is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-network-enabled-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const spawnImpl: SpawnImpl = () => {
      spawnCalls += 1;
      throw new Error('spawn reached');
    };
    const gateway = createCommandGateway({ spawnImpl });

    const result = await gateway.run({
      command: { tool: 'curl', args: ['https://example.com'] },
      cwd,
      policy: {
        allow: [{ tool: 'curl', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'enabled',
      },
    });

    expect(result).toEqual({ status: 'rejected', reason: 'spawn reached' });
    expect(spawnCalls).toBe(1);
  });
});
