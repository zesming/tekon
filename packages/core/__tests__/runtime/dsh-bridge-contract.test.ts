import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TESTED_DSH_VERSION,
  assertDshDefaultConfigContract,
  assertDshHeadlessHelpContract,
  assertDshVersionAllowed,
  parseDshVersion,
  runDshPreflight,
} from '../../src/index.js';

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'dsh',
);
const fixture = (name: string): string =>
  readFileSync(join(fixturesDir, name), 'utf8');

// ── L1: fixture contract (CI-resident, no external dependency) ───────────
//
// These assert the ACL parser against the outputs cross-checked against the
// official @deepseek-ai/dsh@0.1.2-alpha.3 source (commit dd6322d6). The help
// and config fixtures are source-level cross-checks, not recordings from a
// locally installed dsh binary. A real L2 binary probe (DSH_CLI_PATH) must run
// before release; a separate L3 provider smoke with credentials is still needed
// before claiming end-to-end model compatibility. If the pinned version bumps,
// regenerate the fixtures and this test proves the parser still accepts them.

describe('dsh L1 fixture contract (design §5.3)', () => {
  it('parses the measured --version fixture to the pinned version', () => {
    const parsed = parseDshVersion(fixture('version.txt'));
    expect(parsed).toBe(TESTED_DSH_VERSION);
    expect(() => assertDshVersionAllowed(parsed, {})).not.toThrow();
  });

  it('accepts the measured headless --help fixture (stdout contract anchor)', () => {
    expect(() =>
      assertDshHeadlessHelpContract(fixture('headless-help.txt')),
    ).not.toThrow();
  });

  it('accepts the measured --dump-default-config fixture (all required plugins)', () => {
    expect(() =>
      assertDshDefaultConfigContract(
        fixture('headless-dump-default-config.txt'),
      ),
    ).not.toThrow();
  });
});

// ── L2: live probe against a real dsh binary (opt-in) ────────────────────
//
// Skipped unless DSH_CLI_PATH points at an installed dsh. This never runs a
// model or needs an API key. Metadata commands may initialize profile state, so
// the live test deliberately uses the same isolated wrapper as production:
// one temporary cwd/DSH_HOME, minimal environment, telemetry hard opt-out,
// sequential config/help validation, and cleanup in finally.
//
// DSH_EXPECTED_VERSION defaults to Tekon's tested pin. Release-candidate review
// may set it to an unpinned version; the wrapper then uses an exact, explicit
// allowVersion while the assertions still require the installed version to
// match DSH_EXPECTED_VERSION exactly.

const dshPath = process.env.DSH_CLI_PATH;
const expectedLiveVersion =
  process.env.DSH_EXPECTED_VERSION?.trim() || TESTED_DSH_VERSION;
const describeLive = dshPath ? describe : describe.skip;

describeLive('dsh L2 live probe (opt-in via DSH_CLI_PATH)', () => {
  it('validates the real binary through Tekon\'s isolated metadata wrapper', async () => {
    const warnings: string[] = [];
    const reviewingUntestedVersion = expectedLiveVersion !== TESTED_DSH_VERSION;

    const result = await runDshPreflight(dshPath as string, {
      allowVersion: reviewingUntestedVersion
        ? expectedLiveVersion
        : undefined,
      onWarn: (warning) => warnings.push(warning),
    });

    expect(result.actualVersion).toBe(expectedLiveVersion);
    expect(result.helpContractOk).toBe(true);
    expect(result.configContractOk).toBe(true);
    expect(result.versionCompatible).toBe(!reviewingUntestedVersion);
    expect(result.versionBypassed).toBe(reviewingUntestedVersion);
    if (reviewingUntestedVersion) {
      expect(warnings.join('\n')).toContain(expectedLiveVersion);
    }
  });
});
