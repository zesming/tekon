import { execFileSync } from 'node:child_process';
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
} from '../../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dsh');
const fixture = (name: string): string =>
  readFileSync(join(fixturesDir, name), 'utf8');

// ── L1: fixture contract (CI-resident, no external dependency) ───────────
//
// These assert the ACL parser against the outputs cross-checked against the
// official @deepseek-ai/dsh@0.1.2-alpha.3 source (commit dd6322d6). The help
// and config fixtures are source-level cross-checks, not recordings from a
// locally installed dsh binary; a real L2 live smoke (DSH_CLI_PATH + API key)
// must still run before claiming provider compatibility. If the pinned version
// bumps, regenerate the fixtures and this test proves the parser still accepts
// them.

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
// Skipped unless DSH_CLI_PATH points at an installed dsh. Never runs a model
// (no API key needed): only --version / --help / --dump-default-config, which
// are side-effect free. Run before release on a machine with dsh installed.

const dshPath = process.env.DSH_CLI_PATH;
const describeLive = dshPath ? describe : describe.skip;

describeLive('dsh L2 live probe (opt-in via DSH_CLI_PATH)', () => {
  const run = (args: string[]): string =>
    execFileSync(dshPath as string, args, {
      encoding: 'utf8',
      timeout: 30_000,
    });

  it('the installed dsh version matches the pin (or gate fails closed)', () => {
    const parsed = parseDshVersion(run(['--version']));
    // Does not hard-fail on mismatch: it proves the gate behaves correctly.
    if (parsed === TESTED_DSH_VERSION) {
      expect(() => assertDshVersionAllowed(parsed, {})).not.toThrow();
    } else {
      expect(() => assertDshVersionAllowed(parsed, {})).toThrow();
    }
  });

  it('the installed headless --help still advertises the stdout contract', () => {
    expect(() =>
      assertDshHeadlessHelpContract(run(['--profile', 'headless', '--help'])),
    ).not.toThrow();
  });

  it('the installed headless default config still contains all required plugins', () => {
    expect(() =>
      assertDshDefaultConfigContract(
        run(['--profile', 'headless', '--dump-default-config']),
      ),
    ).not.toThrow();
  });
});
