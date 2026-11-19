import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

import { createCommandGateway } from '../../src/index.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  vi.mocked(fs.writeFileSync).mockClear();
});

function policy(cwd: string) {
  return {
    allow: [{ tool: process.execPath, args: [] }],
    deny: [],
    cwdScope: [cwd],
    network: 'disabled' as const,
  };
}

describe('command gateway output while a command runs', () => {
  it('has the finished lines in the log before the command exits', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-live-'));
    tempDirs.push(cwd);
    const release = join(cwd, 'release');
    const logs = join(cwd, 'logs');
    const running = createCommandGateway().run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          [
            "process.stdout.write('first line\\nsecond')",
            `const wait = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) { clearInterval(wait); process.stdout.write(' half\\n'); } }, 10)`,
          ].join('\n'),
        ],
      },
      cwd,
      outputDir: logs,
      policy: policy(cwd),
    });

    const stdoutLog = () => {
      const name = existsSync(logs) ? readdirSync(logs).find((file) => file.endsWith('.stdout.log')) : undefined;
      return name ? readFileSync(join(logs, name), 'utf8') : '';
    };
    const deadline = Date.now() + 10_000;
    while (stdoutLog() !== 'first line\n' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stdoutLog()).toBe('first line\n');
    writeFileSync(release, 'go');

    const result = await running;
    expect(result).toMatchObject({ status: 'executed', exitCode: 0 });
    expect(stdoutLog()).toBe('first line\nsecond half\n');
  });

  it('writes progress at most about once a second while output streams, and once at the end', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-throttle-'));
    tempDirs.push(cwd);
    const result = await createCommandGateway().run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          "let n = 0; const t = setInterval(() => { process.stdout.write(`line ${n}\\n`); if (++n === 60) clearInterval(t); }, 5)",
        ],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      progressIntervalMs: 60_000,
      policy: policy(cwd),
    });
    expect(result).toMatchObject({ status: 'executed', exitCode: 0 });
    const progressWrites = vi.mocked(fs.writeFileSync).mock.calls
      .filter(([path]) => String(path).endsWith('.progress.json'));
    // Start, at most one throttled update per second of output, and the end.
    expect(progressWrites.length).toBeLessThanOrEqual(4);
    if (result.status !== 'executed') throw new Error('expected command to execute');
    const progress = JSON.parse(readFileSync(result.progressPath!, 'utf8')) as { status: string; stdoutBytes: number };
    expect(progress).toMatchObject({ status: 'completed' });
    expect(progress.stdoutBytes).toBe(readFileSync(result.stdoutPath, 'utf8').length);
  });
});
