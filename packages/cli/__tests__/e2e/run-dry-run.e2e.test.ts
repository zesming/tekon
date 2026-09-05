import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('CLI dry-run admission', () => {
  for (const mode of ['workflow', 'goal'] as const) {
    it(`rejects unsupported ${mode} dry-run before initialization or execution`, () => {
      const repo = mkdtempSync(join(tmpdir(), 'tekon-dry-run-'));
      try {
        const result = spawnSync(
          process.execPath,
          [
            cliPath,
            'run',
            'Preview only; do not execute',
            '--repo', repo,
            '--agent', 'mock',
            '--dry-run',
            ...(mode === 'goal' ? ['--goal'] : []),
          ],
          { cwd: repo, encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('DRY_RUN_UNSUPPORTED');
        expect(readdirSync(repo)).toEqual([]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});
