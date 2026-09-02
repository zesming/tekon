import { describe, expect, it } from 'vitest';

import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
  dshInstallHint,
  DshVersionGateError,
  DshCapabilityError,
  DshHostNodeError,
  isHostNodeVersionCompatible,
  parseDshVersion,
  assertDshVersionAllowed,
  assertDshHeadlessHelpContract,
  assertDshDefaultConfigContract,
  REQUIRED_DSH_PLUGIN_IDS,
  runDshPreflight,
} from '../../src/index.js';

describe('parseDshVersion', () => {
  it('extracts a clean single-line version', () => {
    expect(parseDshVersion('0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
    expect(parseDshVersion('  0.1.1-rc.2  ')).toBe('0.1.1-rc.2');
  });

  it('takes the last non-empty line and tolerates a boot banner', () => {
    expect(parseDshVersion('some banner\n0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
  });

  it('throws on empty output', () => {
    expect(() => parseDshVersion('')).toThrow(/could not parse/i);
    expect(() => parseDshVersion('   \n  ')).toThrow(/could not parse/i);
  });
});

describe('assertDshVersionAllowed', () => {
  it('accepts the pinned version', () => {
    expect(() => assertDshVersionAllowed(TESTED_DSH_VERSION, {})).not.toThrow();
  });

  it('rejects a mismatched version and names both versions', () => {
    expect(() => assertDshVersionAllowed('0.2.0', {})).toThrow(
      DshVersionGateError,
    );
    try {
      assertDshVersionAllowed('0.2.0', {});
    } catch (error) {
      expect((error as Error).message).toContain('0.2.0');
      expect((error as Error).message).toContain(TESTED_DSH_VERSION);
    }
  });

  it('allows an explicitly acknowledged exact version and warns', () => {
    const warnings: string[] = [];
    expect(() =>
      assertDshVersionAllowed('0.2.0', {
        allowVersion: '0.2.0',
        onWarn: (warning) => warnings.push(warning),
      }),
    ).not.toThrow();
    expect(warnings.join('\n')).toContain('0.2.0');
  });

  it('does not let a non-matching escape hatch bypass the gate', () => {
    expect(() =>
      assertDshVersionAllowed('0.3.0', { allowVersion: '0.2.0' }),
    ).toThrow(DshVersionGateError);
  });
});

describe('assertDshHeadlessHelpContract', () => {
  it('accepts the documented stdout anchor', () => {
    expect(() =>
      assertDshHeadlessHelpContract(
        'Answer one task, print the final assistant message, and exit.',
      ),
    ).not.toThrow();
  });

  it('throws when the anchor is absent', () => {
    expect(() =>
      assertDshHeadlessHelpContract('Usage: dsh --profile headless [task...]'),
    ).toThrow(DshCapabilityError);
  });
});

describe('assertDshDefaultConfigContract', () => {
  const configWithPlugins = (ids: readonly string[]): string =>
    ['plugins:', ...ids.map((id) => `  - id: ${id}`)].join('\n');

  it('accepts a YAML tree containing all required row ids', () => {
    expect(() =>
      assertDshDefaultConfigContract(
        configWithPlugins([...REQUIRED_DSH_PLUGIN_IDS, 'some-extra-plugin']),
      ),
    ).not.toThrow();
  });

  it('accepts quoted complete id rows', () => {
    const raw = REQUIRED_DSH_PLUGIN_IDS.map(
      (id) => `- id: "${id}"\n  name: '@deepseek-ai/x'`,
    ).join('\n');
    expect(() => assertDshDefaultConfigContract(raw)).not.toThrow();
  });

  it('does not let a package-name substring replace a missing row id', () => {
    const raw = [
      ...REQUIRED_DSH_PLUGIN_IDS.filter((id) => id !== 'approval').map(
        (id) => `- id: ${id}`,
      ),
      "- id: unrelated-row\n  name: '@deepseek-ai/dsh-user-approval'",
    ].join('\n');
    expect(() => assertDshDefaultConfigContract(raw)).toThrow(/approval/);
  });

  it('names the missing row when the composition drifts', () => {
    const missing = REQUIRED_DSH_PLUGIN_IDS[0];
    expect(() =>
      assertDshDefaultConfigContract(
        configWithPlugins(REQUIRED_DSH_PLUGIN_IDS.slice(1)),
      ),
    ).toThrow(missing);
  });

  it('locks the canonical required row ids', () => {
    expect([...REQUIRED_DSH_PLUGIN_IDS].sort()).toEqual(
      [
        'agent-default-model',
        'approval',
        'headless-runner',
        'sandbox-policy',
        'session-persistence-jsonl',
      ].sort(),
    );
  });
});

describe('dsh install metadata', () => {
  it('keeps the install command executable and exposes Node separately', () => {
    expect(dshInstallHint()).toBe(
      `npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
    );
    expect(dshInstallHint()).not.toContain('Node');
    expect(DSH_NODE_REQUIREMENT).toBe('^22.19.0 || >=24.0.0');
  });
});

describe('isHostNodeVersionCompatible', () => {
  it.each([
    '20.19.0',
    '22.14.0',
    '22.18.0',
    '18.20.0',
    '23.0.0',
    '22.19.0-rc',
    '24.0.0-rc.1',
    '22.19',
    '24.0garbage',
    '',
    'abc',
    '22',
  ])('rejects incompatible, prerelease, partial, or malformed host %s', (version) => {
    expect(isHostNodeVersionCompatible(version)).toBe(false);
  });

  it.each([
    '22.19.0',
    '22.20.1',
    '24.0.0',
    '25.1.0',
    'v24.0.0',
    '24.0.0+vendor.1',
  ])('accepts stable compatible host %s', (version) => {
    expect(isHostNodeVersionCompatible(version)).toBe(true);
  });
});

describe('runDshPreflight', () => {
  const validVersion = `${TESTED_DSH_VERSION}\n`;
  const validHelp = [
    'Usage: dsh --profile headless [options] [task...]',
    'Answer one task, print the final assistant message, and exit.',
  ].join('\n');
  const validConfig = [
    'plugins:',
    '  - id: headless-runner',
    '  - id: sandbox-policy',
    '  - id: approval',
    '  - id: session-persistence-jsonl',
    '  - id: agent-default-model',
  ].join('\n');

  const validProbes = {
    probeVersion: async () => validVersion,
    probeHelp: async () => validHelp,
    probeConfig: async () => validConfig,
  };

  it('succeeds when the stable host, version, and contracts match', async () => {
    await expect(
      runDshPreflight('dsh', {
        ...validProbes,
        hostNodeVersion: '22.19.0',
      }),
    ).resolves.toEqual({
      testedVersion: TESTED_DSH_VERSION,
      actualVersion: TESTED_DSH_VERSION,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      helpContractOk: true,
      configContractOk: true,
      installHint: dshInstallHint(),
      hostNodeVersion: '22.19.0',
      hostNodeCompatible: true,
      hostNodeBypassed: false,
    });
  });

  it('fails fast on version mismatch', async () => {
    await expect(
      runDshPreflight('dsh', {
        ...validProbes,
        probeVersion: async () => '0.2.0\n',
        hostNodeVersion: '22.19.0',
      }),
    ).rejects.toThrow(DshVersionGateError);
  });

  it('preserves the detected version when a later contract fails', async () => {
    try {
      await runDshPreflight('dsh', {
        ...validProbes,
        probeHelp: async () => 'Usage: dsh [options]',
        hostNodeVersion: '22.19.0',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshCapabilityError);
      expect((error as DshCapabilityError).actualVersion).toBe(
        TESTED_DSH_VERSION,
      );
    }
  });

  it('fails when config contract is missing a required plugin', async () => {
    await expect(
      runDshPreflight('dsh', {
        ...validProbes,
        probeConfig: async () => '- id: headless-runner',
        hostNodeVersion: '22.19.0',
      }),
    ).rejects.toThrow(DshCapabilityError);
  });

  it('rejects an incompatible host before any dsh probe runs', async () => {
    let probeCalls = 0;
    const forbiddenProbe = async () => {
      probeCalls += 1;
      return '';
    };
    await expect(
      runDshPreflight('dsh', {
        probeVersion: forbiddenProbe,
        probeHelp: forbiddenProbe,
        probeConfig: forbiddenProbe,
        hostNodeVersion: '20.19.0',
      }),
    ).rejects.toThrow(DshHostNodeError);
    expect(probeCalls).toBe(0);
  });

  it('admits an exact acknowledged stable host without relabeling it compatible', async () => {
    const warnings: string[] = [];
    const result = await runDshPreflight('dsh', {
      ...validProbes,
      hostNodeVersion: '20.19.0',
      allowHostNode: '20.19.0',
      onWarn: (warning) => warnings.push(warning),
    });

    expect(result.hostNodeCompatible).toBe(false);
    expect(result.hostNodeBypassed).toBe(true);
    expect(warnings.join('\n')).toContain('TEKON_DSH_ALLOW_HOST_NODE');
  });

  it('does not bypass with a non-matching host acknowledgement', async () => {
    await expect(
      runDshPreflight('dsh', {
        ...validProbes,
        hostNodeVersion: '20.19.0',
        allowHostNode: '22.18.0',
      }),
    ).rejects.toThrow(DshHostNodeError);
  });

  it.each(['abc', '22.19.0-rc.1', '24.0garbage'])(
    'does not admit an unparseable or prerelease host even with exact acknowledgement: %s',
    async (hostNodeVersion) => {
      await expect(
        runDshPreflight('dsh', {
          ...validProbes,
          hostNodeVersion,
          allowHostNode: hostNodeVersion,
        }),
      ).rejects.toThrow(DshHostNodeError);
    },
  );
});
