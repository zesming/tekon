import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  writeFakeClaude,
} from '../helpers/fake-provider.js';

// TS-01: the Web/CLI write baseline must hand Claude the on-failure permission
// profile as concrete argv — acceptEdits plus a non-empty deny list — not just
// as a runtime configSummary. The fake provider records every invocation.
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('Claude write permission argv through a real CLI process (TS-01)', () => {
  it('passes acceptEdits and a non-empty disallowedTools list on a goal run', () => {
    const repo = tempDir('tekon-claude-argv-');
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 'test@tekon.local'],
      ['config', 'user.name', 'Tekon Test'],
    ]) {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    }
    writeFileSync(join(repo, 'README.md'), 'argv fixture\n');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });

    const home = tempDir('tekon-claude-argv-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    const capture = join(binDir, 'calls.jsonl');
    writeFakeClaude(binDir, { behavior: 'success', captureFile: capture });

    const run = runCliWithEnv(
      cliPath,
      ['run', '写节点权限参数合同', '--goal', '--agent', 'claude-code', '--repo', repo],
      { cwd: repo, binDirs: [binDir], isolatePath: true, home, timeoutMs: 120_000 },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(existsSync(capture)).toBe(true);

    const invocations = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; envKeys: string[] });
    // Auth probes do not carry the permission profile; the provider run does.
    const providerRun = invocations.find((entry) =>
      entry.argv.includes('--permission-mode'),
    );
    expect(providerRun, JSON.stringify(invocations)).toBeDefined();
    const argv = providerRun!.argv;
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const denyIndex = argv.indexOf('--disallowedTools');
    expect(denyIndex).toBeGreaterThan(-1);
    // At least one concrete deny pattern follows before the next flag.
    const nextFlag = argv
      .slice(denyIndex + 1)
      .findIndex((value) => value.startsWith('--'));
    const denyValues = nextFlag === -1
      ? argv.slice(denyIndex + 1)
      : argv.slice(denyIndex + 1, denyIndex + 1 + nextFlag);
    expect(denyValues.length).toBeGreaterThan(0);
    // The deny list is wired to the role policy, not a placeholder.
    expect(denyValues.some((value) => value.includes('rm') || value.includes('sudo'))).toBe(true);
  }, 180_000);
});
