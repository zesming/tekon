import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, openTekonDatabase } from '@tekon/core';
import { runCli, type CliIO } from '../src/index.js';

// M5/M8: terminal runs must fail loudly (exit 1 + Chinese message) instead of
// the legacy behavior of printing the terminal status and exiting 0.
describe('approval/resume on terminal runs (M5/M8)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  async function createCancelledRunWithPendingDecision(): Promise<{
    repoPath: string;
    runId: string;
    decisionId: string;
  }> {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();

    await expect(
      runCli(
        [
          'run',
          '终态运行的审批与恢复',
          '--template',
          'bugfix',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(io.takeStdout())?.[1];
    expect(runId).toBeTruthy();

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    const repositories = createRepositories(db);
    // Seed a pending human decision directly on an existing node — deterministic,
    // not dependent on high-risk demand text triggering the conditional gate.
    // The test's subject is M5/M8 terminal behavior, not gate-triggering mechanics.
    const nodes = await repositories.listNodes(runId!);
    expect(nodes.length).toBeGreaterThan(0);
    const decisionId = `decision_${runId}`;
    await repositories.createHumanDecision({
      id: decisionId,
      runId: runId!,
      nodeId: nodes[0]!.id,
      status: 'pending',
      createdAt: '2026-08-21T00:00:00.000Z',
    });

    // Force the run into a terminal state.
    await repositories.updateWorkflowInstanceStatus(runId!, 'cancelled');
    db.close();

    return { repoPath, runId: runId!, decisionId };
  }

  it('M5: tekon resume on a cancelled run exits 1 with a Chinese terminal message', async () => {
    const { repoPath, runId } = await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(['resume', '--run-id', runId, '--repo', repoPath], io),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');
    expect(io.takeStdout()).toBe('');
  });

  it('M8: tekon resume --approve-human on a cancelled run exits 1 and leaves the decision pending', async () => {
    const { repoPath, runId, decisionId } =
      await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(
        [
          'resume',
          '--run-id',
          runId,
          '--decision-id',
          decisionId,
          '--approve-human',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    const decision = await createRepositories(db).getHumanDecision(decisionId);
    expect(decision).toMatchObject({ status: 'pending', actor: null });
    db.close();
  });

  it('M8: tekon approval reject on a cancelled run exits 1 and leaves the decision pending', async () => {
    const { repoPath, runId, decisionId } =
      await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(
        [
          'approval',
          'reject',
          '--run-id',
          runId,
          '--decision-id',
          decisionId,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    const decision = await createRepositories(db).getHumanDecision(decisionId);
    expect(decision).toMatchObject({ status: 'pending', actor: null });
    db.close();
  });
  it('M5: tekon pause on a cancelled run exits 1 and cannot revive the terminal status', async () => {
    const { repoPath, runId } = await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(['pause', '--run-id', runId, '--repo', repoPath], io),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    expect(
      await createRepositories(db).getWorkflowInstance(runId),
    ).toMatchObject({
      status: 'cancelled',
    });
    db.close();
  });
});

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    takeStdout() {
      const value = stdout;
      stdout = '';
      return value;
    },
    takeStderr() {
      const value = stderr;
      stderr = '';
      return value;
    },
  };
}

function createFixtureRepo(tempDirs: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-approval-terminal-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  execFileSync('npm', ['init', '-y'], { cwd: repoPath });
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.test=node -e "process.exit(0)"'],
    {
      cwd: repoPath,
    },
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
