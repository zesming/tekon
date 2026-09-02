import { describe, expect, it, vi } from 'vitest';

import {
  DSH_NODE_REQUIREMENT,
  DshNodeVersionGateError,
  isDshNodeVersionSupported,
  REQUIRED_DSH_PLUGIN_IDS,
  runDshPreflight,
  TESTED_DSH_VERSION,
} from '../../src/index.js';

const compatibleConfig = REQUIRED_DSH_PLUGIN_IDS.map(
  (id) => `- id: ${id}`,
).join('\n');

describe('dsh host Node preflight gate', () => {
  it.each([
    ['20.19.0', false],
    ['22.12.0', false],
    ['22.18.9', false],
    ['22.19.0', true],
    ['v22.20.1', true],
    ['23.9.0', false],
    ['24.0.0', true],
    ['25.1.0', true],
    ['not-a-version', false],
  ])('evaluates Node %s against the exact DSH range', (version, expected) => {
    expect(isDshNodeVersionSupported(version)).toBe(expected);
  });

  it('fails before spawning dsh when the host Node runtime is unsupported', async () => {
    const probeVersion = vi.fn(async () => TESTED_DSH_VERSION);
    const probeHelp = vi.fn(async () => 'print the final assistant message');
    const probeConfig = vi.fn(async () => compatibleConfig);

    await expect(
      runDshPreflight('dsh', {
        nodeVersion: '22.18.0',
        probeVersion,
        probeHelp,
        probeConfig,
      }),
    ).rejects.toMatchObject({
      name: 'DshNodeVersionGateError',
      actualNodeVersion: '22.18.0',
      nodeRequirement: DSH_NODE_REQUIREMENT,
    } satisfies Partial<DshNodeVersionGateError>);

    expect(probeVersion).not.toHaveBeenCalled();
    expect(probeHelp).not.toHaveBeenCalled();
    expect(probeConfig).not.toHaveBeenCalled();
  });

  it.each(['22.19.0', '24.0.0'])(
    'continues with metadata probing on supported Node %s',
    async (nodeVersion) => {
      await expect(
        runDshPreflight('dsh', {
          nodeVersion,
          probeVersion: async () => TESTED_DSH_VERSION,
          probeHelp: async () => 'Print the final assistant message',
          probeConfig: async () => compatibleConfig,
        }),
      ).resolves.toMatchObject({
        testedVersion: TESTED_DSH_VERSION,
        actualVersion: TESTED_DSH_VERSION,
        nodeRequirement: DSH_NODE_REQUIREMENT,
        helpContractOk: true,
        configContractOk: true,
      });
    },
  );
});
