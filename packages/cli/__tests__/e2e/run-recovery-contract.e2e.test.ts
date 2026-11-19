import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  spawnCliWithEnv,
  writeFakeClaude,
} from '../helpers/fake-provider.js';

// Recovery contract: a run that stops part-way can be continued with plain
// CLI commands, without editing the database.
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function setup() {
  const repo = tempDir('tekon-recovery-');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(join(repo, 'README.md'), 'recovery fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
  const home = tempDir('tekon-recovery-home-');
  const binDir = createIsolatedBinDir();
  roots.push(binDir);
  const options = { cwd: repo, binDirs: [binDir], isolatePath: true, home };
  const cli = (args: string[]) =>
    runCliWithEnv(cliPath, [...args, '--repo', repo], { ...options, timeoutMs: 90_000 });
  return { repo, binDir, options, cli };
}

function runIdOf(output: string): string {
  const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(output)?.[1];
  expect(runId, output).toBeTruthy();
  return runId!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('run recovery contract through a real CLI process', () => {
  it('shows why a run stopped and finishes it with resume', () => {
    const { binDir, cli } = setup();
    writeFakeClaude(binDir, { behavior: 'fail-once' });
    expect(cli(['init']).status).toBe(0);

    const run = cli(['run', '改一下 README', '--goal', '--agent', 'claude-code']);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('⚠ 运行中断');
    expect(run.stdout).toMatch(/原因: .*退出码 1/u);
    const runId = runIdOf(run.stdout);
    expect(run.stdout).toContain(`tekon resume --run-id ${runId}`);
    expect(cli(['status', '--run-id', runId]).stdout).toContain('status=interrupted');

    const resume = cli(['resume', '--run-id', runId]);
    expect(resume.status, resume.stdout + resume.stderr).toBe(0);
    expect(cli(['status', '--run-id', runId]).stdout).toContain('status=passed');
  }, 240_000);

  it('pauses a running node at its boundary and continues with resume', async () => {
    const { binDir, options, cli } = setup();
    const capture = join(binDir, 'calls.jsonl');
    const release = join(binDir, 'release');
    writeFakeClaude(binDir, { behavior: 'slow', releaseFile: release, captureFile: capture });
    expect(cli(['init']).status).toBe(0);

    const child = spawnCliWithEnv(
      cliPath,
      ['run', '改一下 README', '--goal', '--agent', 'claude-code', '--repo', options.cwd],
      options,
    );
    children.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk; });
    child.stderr!.on('data', () => {});
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

    // The node is running once the provider was called with a prompt.
    await waitFor(() =>
      existsSync(capture) &&
      readFileSync(capture, 'utf8').split('\n').some((line) => line.includes('"-p"')),
    );
    const listed = cli(['status']).stdout;
    const runId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(listed)?.[1];
    expect(runId, listed).toBeTruthy();
    expect(cli(['pause', '--run-id', runId!]).status).toBe(0);
    writeFileSync(release, 'go');
    await exited;
    expect(stdout).toContain('⏸ 运行已暂停');
    expect(cli(['status', '--run-id', runId!]).stdout).toContain('status=paused');
    // The node finished before the pause took effect, so resume does not run it again.
    const promptCalls = () =>
      readFileSync(capture, 'utf8').split('\n').filter((line) => line.includes('"-p"')).length;
    expect(promptCalls()).toBe(1);

    const resume = cli(['resume', '--run-id', runId!]);
    expect(resume.status, resume.stdout + resume.stderr).toBe(0);
    expect(cli(['status', '--run-id', runId!]).stdout).toContain('status=passed');
    expect(promptCalls()).toBe(1);
  }, 240_000);
});
