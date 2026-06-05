import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandGateway, runCommandGate } from '../../src/index.js';

describe('command gate runner', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs command gates through CommandGateway and returns deterministic output paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-gate-'));
    tempDirs.push(cwd);
    const result = await runCommandGate({
      gateway: createCommandGateway(),
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      cwd,
      command: {
        tool: process.execPath,
        args: ['-e', "console.log('gate ok')"],
      },
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      outputDir: join(cwd, '.donkey', 'runs', 'run_1', 'gates'),
    });

    expect(result).toMatchObject({ gateType: 'test', status: 'passed' });
    expect(result.outputPath).toBeTruthy();
    expect(readFileSync(result.outputPath!, 'utf8')).toContain('gate ok');
  });
});
