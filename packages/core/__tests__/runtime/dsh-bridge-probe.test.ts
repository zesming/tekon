import { describe, expect, it } from 'vitest';

import {
  TESTED_DSH_VERSION,
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
      expect(message).toContain('0.2.0'); // actual
      expect(message).toContain(TESTED_DSH_VERSION); // tested
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
    JSON.stringify({ plugins: ids.map((id) => ({ id })) });

  it('accepts a config tree that contains all required plugin ids', () => {
    expect(() =>
      assertDshDefaultConfigContract(
        configWithPlugins([...REQUIRED_DSH_PLUGIN_IDS, 'some-extra-plugin']),
      ),
    ).not.toThrow();
  });

  it('accepts required ids anywhere in the raw text (id-substring match)', () => {
    // The dump format is not a schema we bind; substring presence of each id
    // is the deliberately loose contract (drift = a required id disappears).
    const raw = REQUIRED_DSH_PLUGIN_IDS.map(
      (id) => `- id: ${id}\n  name: '@deepseek-ai/x'`,
    ).join('\n');
    expect(() => assertDshDefaultConfigContract(raw)).not.toThrow();
  });

  it('throws naming the missing plugin id when the tree drifts', () => {
    const missing = REQUIRED_DSH_PLUGIN_IDS[0];
    const partial = REQUIRED_DSH_PLUGIN_IDS.slice(1).join(' ');
    try {
      assertDshDefaultConfigContract(partial);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshCapabilityError);
      expect((error as Error).message).toContain(missing);
    }
  });

  it('lists the canonical required plugin ids (drift lock)', () => {
    // If this set changes, the fixture + manual claims must change with it.
    expect([...REQUIRED_DSH_PLUGIN_IDS].sort()).toEqual(
      [
        'agent-default-model',
        'headless-runner',
        'sandbox-policy',
        'session-persistence-jsonl',
        'user-approval',
      ].sort(),
    );
  });
});

// ── runDshPreflight ─────────────────────────────────────────────────────

describe('runDshPreflight', () => {
  const validVersion = '0.1.1-rc.2\n';
  const validHelp = [
    'Usage: dsh --profile headless [options] [task...]',
    'Answer one task, print the final assistant message, and exit.',
  ].join('\n');
  const validConfig = JSON.stringify({
    plugins: [
      { id: 'headless-runner' },
      { id: 'sandbox-policy' },
      { id: 'user-approval' },
      { id: 'session-persistence-jsonl' },
      { id: 'agent-default-model' },
    ],
  });

  it('succeeds when version and contracts match', async () => {
    const { runDshPreflight } = await import('../../src/runtime/dsh-bridge-probe.js');
    const result = await runDshPreflight('dsh', {
      probeVersion: async () => validVersion,
      probeHelp: async () => validHelp,
      probeConfig: async () => validConfig,
    });

    expect(result).toEqual({
      testedVersion: '0.1.1-rc.2',
      actualVersion: '0.1.1-rc.2',
      helpContractOk: true,
      configContractOk: true,
      installHint: 'npm install -g @deepseek-ai/dsh@0.1.1-rc.2',
    });
  });

  it('fails fast on version mismatch', async () => {
    const { runDshPreflight } = await import('../../src/runtime/dsh-bridge-probe.js');
    await expect(
      runDshPreflight('dsh', {
        probeVersion: async () => '0.2.0\n',
        probeHelp: async () => validHelp,
        probeConfig: async () => validConfig,
      }),
    ).rejects.toThrow(DshVersionGateError);
  });

  it('fails when help contract is missing anchor', async () => {
    const { runDshPreflight } = await import('../../src/runtime/dsh-bridge-probe.js');
    await expect(
      runDshPreflight('dsh', {
        probeVersion: async () => validVersion,
        probeHelp: async () => 'Usage: dsh [options]',
        probeConfig: async () => validConfig,
      }),
    ).rejects.toThrow(DshCapabilityError);
  });

  it('fails when config contract is missing required plugin', async () => {
    const { runDshPreflight } = await import('../../src/runtime/dsh-bridge-probe.js');
    await expect(
      runDshPreflight('dsh', {
        probeVersion: async () => validVersion,
        probeHelp: async () => validHelp,
        probeConfig: async () => JSON.stringify({ plugins: [{ id: 'headless-runner' }] }),
      }),
    ).rejects.toThrow(DshCapabilityError);
  });
});
