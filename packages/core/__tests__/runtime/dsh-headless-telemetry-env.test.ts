import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDshHeadlessAdapter,
  dshHeadlessProviderConfig,
  type CommandGateway,
} from '../../src/index.js';

describe('dsh-headless telemetry environment', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('hard-disables upstream telemetry and ignores ambient telemetry settings', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-dsh-telemetry-'));
    tempDirs.push(repoPath);

    let capturedEnvMode: unknown = 'unset';
    let capturedEnv: NodeJS.ProcessEnv = {};
    const gateway: CommandGateway = {
      async run(input) {
        capturedEnvMode = input.envMode;
        capturedEnv = input.env ?? {};
        return { status: 'rejected', reason: 'stop after environment capture' };
      },
    };

    const priorMode = process.env.DSH_TELEMETRY_MODE;
    const priorDisabled = process.env.DSH_TELEMETRY_DISABLED;
    const priorEndpoint = process.env.DSH_TELEMETRY_OTLP_URL;
    try {
      process.env.DSH_TELEMETRY_MODE = 'FULL';
      // Upstream DSH treats any non-empty value of DSH_TELEMETRY_DISABLED as disabled.
      // Setting ambient '0' does not enable telemetry; fixing child env to '1' is Tekon's canonical normalization.
      process.env.DSH_TELEMETRY_DISABLED = '0';
      process.env.DSH_TELEMETRY_OTLP_URL = 'https://collector.invalid/v1/logs';

      const adapter = createDshHeadlessAdapter(
        {
          ...dshHeadlessProviderConfig(repoPath),
          command: process.execPath,
          args: [],
        },
        gateway,
      );

      await adapter.runAgent({
        roleConfig: { role: 'goal' },
        prompt: 'summarize the repository',
        worktreeLease: {
          id: 'lease_1',
          runId: 'run_1',
          nodeId: 'node_1',
          role: 'goal',
          repoPath,
          worktreePath: repoPath,
          branchName: 'tekon/run_1/node_1-goal',
          createdAt: '2026-09-03T00:00:00.000Z',
        },
        outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'agent'),
        commandPolicy: {
          allow: [{ tool: process.execPath, args: [] }],
          deny: [],
          requiresHumanApproval: [],
          cwdScope: [repoPath],
          network: 'enabled',
        },
        runContext: {
          runId: 'run_1',
          nodeId: 'node_1',
          projectId: 'project_1',
          repoPath,
          dataDir: '.tekon',
        },
      });
    } finally {
      if (priorMode === undefined) delete process.env.DSH_TELEMETRY_MODE;
      else process.env.DSH_TELEMETRY_MODE = priorMode;
      if (priorDisabled === undefined)
        delete process.env.DSH_TELEMETRY_DISABLED;
      else process.env.DSH_TELEMETRY_DISABLED = priorDisabled;
      if (priorEndpoint === undefined)
        delete process.env.DSH_TELEMETRY_OTLP_URL;
      else process.env.DSH_TELEMETRY_OTLP_URL = priorEndpoint;
    }

    expect(capturedEnvMode).toBe('exact');
    expect(capturedEnv.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(capturedEnv.DSH_TELEMETRY_MODE).toBeUndefined();
    expect(capturedEnv.DSH_TELEMETRY_OTLP_URL).toBeUndefined();
  });
});
