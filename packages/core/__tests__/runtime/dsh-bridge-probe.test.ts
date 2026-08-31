import { describe, expect, it } from 'vitest';

import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
  dshInstallHint,
  DshVersionGateError,
  DshCapabilityError,
  parseDshVersion,
  assertDshVersionAllowed,
  assertDshHeadlessHelpContract,
  assertDshDefaultConfigContract,
  REQUIRED_DSH_PLUGIN_IDS,
} from '../../src/index.js';

// ── parseDshVersion ─────────────────────────────────────────────────────

describe('parseDshVersion', () => {
  it('extracts a clean single-line version', () => {
    expect(parseDshVersion('0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
    expect(parseDshVersion('  0.1.1-rc.2  ')).toBe('0.1.1-rc.2');
  });

  it('takes the last non-empty line (tolerates a boot banner before it)', () => {
    expect(parseDshVersion('some banner\n0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
  });

  it('throws on empty output', () => {
    expect(() => parseDshVersion('')).toThrow(/could not parse/i);
    expect(() => parseDshVersion('   \n  ')).toThrow(/could not parse/i);
  });
});

// ── assertDshVersionAllowed ─────────────────────────────────────────────

describe('assertDshVersionAllowed', () => {
  it('accepts the pinned version', () => {
    expect(() => assertDshVersionAllowed(TESTED_DSH_VERSION, {})).not.toThrow();
  });

  it('rejects a mismatched version with a DshVersionGateError naming both versions', () => {
    try {
      assertDshVersionAllowed('0.2.0', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshVersionGateError);
      const message = (error as Error).message;
      expect(message).toContain('0.2.0');
      expect(message).toContain(TESTED_DSH_VERSION);
    }
  });

  it('allows an explicitly acknowledged version via allowVersion escape hatch', () => {
    const warnings: string[] = [];
    expect(() =>
      assertDshVersionAllowed('0.2.0', {
        allowVersion: '0.2.0',
        onWarn: (w) => warnings.push(w),
      }),
    ).not.toThrow();
    expect(warnings.join('\n')).toMatch(/0\.2\.0/);
  });

  it('does not let a non-matching allowVersion bypass the gate', () => {
    expect(() =>
      assertDshVersionAllowed('0.3.0', { allowVersion: '0.2.0' }),
    ).toThrow(DshVersionGateError);
  });
});

// ── help contract ───────────────────────────────────────────────────────

describe('assertDshHeadlessHelpContract', () => {
  it('accepts help output containing the documented stdout anchor', () => {
    const help = [
      'Usage: dsh --profile headless [options] [task...]',
      'Answer one task, print the final assistant message, and exit.',
      '  task        the task text; multiple words are joined by spaces',
      '  -h, --help  show this help',
    ].join('\n');
    expect(() => assertDshHeadlessHelpContract(help)).not.toThrow();
  });

  it('throws a DshCapabilityError when the anchor sentence is missing', () => {
    expect(() =>
      assertDshHeadlessHelpContract('Usage: dsh --profile headless [task...]'),
    ).toThrow(DshCapabilityError);
  });
});

// ── default-config plugin contract ──────────────────────────────────────

describe('assertDshDefaultConfigContract', () => {
  const configWithPlugins = (ids: string[]): string =>
    ['plugins:', ...ids.map((id) => `  - id: ${id}`)].join('\n');

  it('accepts a YAML config tree that contains all required row ids', () => {
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

  it('does not let a package-name substring stand in for a missing row id', () => {
    const raw = [
      ...REQUIRED_DSH_PLUGIN_IDS.filter((id) => id !== 'approval').map(
        (id) => `- id: ${id}`,
      ),
      "- id: unrelated-row\n  name: '@deepseek-ai/dsh-user-approval'",
    ].join('\n');

    expect(() => assertDshDefaultConfigContract(raw)).toThrow(/approval/);
  });

  it('throws naming the missing plugin id when the tree drifts', () => {
    const missing = REQUIRED_DSH_PLUGIN_IDS[0];
    const partial = configWithPlugins(REQUIRED_DSH_PLUGIN_IDS.slice(1));
    try {
      assertDshDefaultConfigContract(partial);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshCapabilityError);
      expect((error as Error).message).toContain(missing);
    }
  });

  it('lists the canonical required config row ids (drift lock)', () => {
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

// ── install metadata ────────────────────────────────────────────────────

describe('dsh install metadata', () => {
  it('keeps the install hint copy/paste-safe and exposes Node separately', () => {
    expect(dshInstallHint()).toBe(
      `npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
    );
    expect(dshInstallHint()).not.toContain('Node');
    expect(DSH_NODE_REQUIREMENT).toBe('^22.19.0 || >=24.0.0');
  });
});

// ── runDshPreflight ─────────────────────────────────────────────────────

describe('runDshPreflight', () => {
  const validVersion = TESTED_DSH_VERSION + '\n';
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

  it('succeeds when version and contracts match', async () => {
    const { runDshPreflight } =
      await import('../../src/runtime/dsh-bridge-probe.js');
    const result = await runDshPreflight('dsh', {
      probeVersion: async () => validVersion,
      probeHelp: async () => validHelp,
      probeConfig: async () => validConfig,
    });

    expect(result).toEqual({
      testedVersion: TESTED_DSH_VERSION,
      actualVersion: TESTED_DSH_VERSION,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      helpContractOk: true,
      configContractOk: true,
      installHint: dshInstallHint(),
    });
  });

  it('fails fast on version mismatch', async () => {
    const { runDshPreflight } =
      await import('../../src/runtime/dsh-bridge-probe.js');
    await expect(
      runDshPreflight('dsh', {
        probeVersion: async () => '0.2.0\n',
        probeHelp: async () => validHelp,
        probeConfig: async () => validConfig,
      }),
    ).rejects.toThrow(DshVersionGateError);
  });

  it('preserves the detected version when the help contract fails', async () => {
    const { runDshPreflight } =
      await import('../../src/runtime/dsh-bridge-probe.js');
    try {
      await runDshPreflight('dsh', {
        probeVersion: async () => validVersion,
        probeHelp: async () => 'Usage: dsh [options]',
        probeConfig: async () => validConfig,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshCapabilityError);
      expect((error as DshCapabilityError).actualVersion).toBe(
        TESTED_DSH_VERSION,
      );
    }
  });

  it('fails when config contract is missing required plugin', async () => {
    const { runDshPreflight } =
      await import('../../src/runtime/dsh-bridge-probe.js');
    await expect(
      runDshPreflight('dsh', {
        probeVersion: async () => validVersion,
        probeHelp: async () => validHelp,
        probeConfig: async () => '- id: headless-runner',
      }),
    ).rejects.toThrow(DshCapabilityError);
  });
});
