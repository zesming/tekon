import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REQUIRED_DSH_PLUGIN_IDS } from '@tekon/core';

/**
 * Standard fake `dsh` config dump for CLI tests. Generated from the same
 * required row ids the production contract checks, so test fixtures cannot
 * drift into a hand-written list (the `user-approval` vs `approval` drift in
 * earlier rounds came from duplicated literal lists).
 */
export const VALID_DSH_CONFIG = REQUIRED_DSH_PLUGIN_IDS.map(
  (id) => `- id: ${id}`,
).join('\n');

/**
 * Write a fake `dsh` binary into `dir` that answers `--version`, `--help` and
 * `--dump-default-config` with the supplied values. Shared by the CLI unit and
 * e2e preflight tests so the fixture shape has a single owner.
 */
export function createFakeDsh(
  dir: string,
  opts: { version: string; help: string; config: string },
): void {
  const scriptPath = join(dir, 'dsh');
  const versionLine = JSON.stringify(opts.version + '\n');
  const helpLine = JSON.stringify(opts.help + '\n');
  const configLine = JSON.stringify(opts.config + '\n');
  const lines = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    `if (args.includes('--version')) { process.stdout.write(${versionLine}); process.exit(0); }`,
    `if (args.includes('--help')) { process.stdout.write(${helpLine}); process.exit(0); }`,
    `if (args.includes('--dump-default-config')) { process.stdout.write(${configLine}); process.exit(0); }`,
    'process.exit(0);',
    '',
  ];
  writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 });
}
