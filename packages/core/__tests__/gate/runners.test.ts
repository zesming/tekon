import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  type CommandGateway,
  type CommandGatewayRunInput,
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

  it('passes default progress heartbeat and no-progress timeout to command gates', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-gate-progress-'));
    tempDirs.push(cwd);
    let seen: CommandGatewayRunInput | null = null;
    const gateway: CommandGateway = {
      async run(input) {
        seen = input;
        const stdoutPath = join(input.outputDir!, 'stdout.log');
        const stderrPath = join(input.outputDir!, 'stderr.log');
        writeFileSync(stdoutPath, 'ok\n', 'utf8');
        writeFileSync(stderrPath, '', 'utf8');
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          durationMs: 1,
        };
      },
    };

    await runCommandGate({
      gateway,
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'build',
      cwd,
      command: {
        tool: process.execPath,
        args: ['-e', 'process.exit(0)'],
      },
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      outputDir: join(cwd, '.tekon', 'runs', 'run_1', 'gates'),
    });

    expect(seen).toMatchObject({
      progressIntervalMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
      noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    });
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
    const fakeOpenAiKey = ['sk', '123456789012345678901234'].join('-');
    writeFileSync(
      join(cwd, 'config.ts'),
      `export const token = "${fakeOpenAiKey}";\n`,
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
