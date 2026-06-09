import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  runCommandGate,
  runSecurityScanGate,
} from '../../src/index.js';

describe('command gate runner', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs command gates through CommandGateway and returns deterministic output paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-gate-'));
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
      outputDir: join(cwd, '.tekon', 'runs', 'run_1', 'gates'),
    });

    expect(result).toMatchObject({ gateType: 'test', status: 'passed' });
    expect(result.outputPath).toBeTruthy();
    expect(readFileSync(result.outputPath!, 'utf8')).toContain('gate ok');
  });

  it('runs the built-in security scan without an external command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-security-pass-'));
    tempDirs.push(cwd);

    const result = await runSecurityScanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      cwd,
      policy: {
        allow: [],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      outputDir: join(cwd, '.tekon', 'runs', 'run_1', 'gates'),
    });

    expect(result).toMatchObject({
      gateType: 'security-scan',
      status: 'passed',
    });
    expect(readFileSync(result.outputPath!, 'utf8')).toContain(
      '"findings": []',
    );
  });

  it('fails the built-in security scan when likely secrets are present', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-security-fail-'));
    tempDirs.push(cwd);
    writeFileSync(
      join(cwd, 'config.ts'),
      'export const token = "sk-123456789012345678901234";\n',
      'utf8',
    );

    const result = await runSecurityScanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      cwd,
      policy: {
        allow: [],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      outputDir: join(cwd, '.tekon', 'runs', 'run_1', 'gates'),
    });

    expect(result).toMatchObject({
      gateType: 'security-scan',
      status: 'failed',
      failureClassification: 'security-findings',
    });
    expect(readFileSync(result.outputPath!, 'utf8')).toContain(
      'openai-api-key',
    );
  });
});
