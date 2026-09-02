import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  projectRunPlan,
  loadWorkflowTemplate,
  openTekonDatabase,
} from '@tekon/core';

import { runCli, type CliIO } from '../src/index.js';

// A standard-delivery mock run creates the full role/gate chain and performs
// real filesystem/Git setup. Five seconds is below observed CI variance; use a
// test-local budget so shared-runner load does not turn a valid persistence
// contract into a timing flake. This is still short enough to catch hangs.
const WORKFLOW_SNAPSHOT_TIMEOUT_MS = 15_000;

describe('CLI run plan digest and snapshot persistence', () => {
  const tempDirs: string[] = [];
  const anchorCwd = process.cwd();

  afterEach(() => {
    try {
      process.chdir(anchorCwd);
    } catch {
      // ignore
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it(
    'calculates canonical plan digest for workflow run and completes',
    async () => {
      const repoPath = createFixtureRepo(tempDirs);
      const io = createMemoryIo();

      await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
      io.takeStdout();

      const template = loadWorkflowTemplate({ name: 'standard-delivery' });
      const expectedPlan = projectRunPlan(template, {
        agent: 'mock',
        profile: 'cli',
        allowDirtyBase: false,
        templateId: template.id,
        templateVersion: template.version,
        mode: 'workflow',
      });
      expect(expectedPlan.digest).toMatch(/^[a-f0-9]{64}$/);

      const exitCode = await runCli(
        [
          'run',
          '实现用户注册与登录功能',
          '--template',
          'standard-delivery',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      );

      const stdout = io.takeStdout();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('运行已启动');
      expect(stdout).toContain('状态: passed');

      const runIdMatch = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(stdout);
      expect(runIdMatch).toBeTruthy();
      const runId = runIdMatch![1];

      const db = openTekonDatabase({
        filename: join(repoPath, '.tekon', 'tekon.sqlite'),
      });
      try {
        const row = db
          .prepare('select * from workflow_instances where id = ?')
          .get(runId) as Record<string, unknown> | undefined;
        expect(row).toBeDefined();
        expect(row?.status).toBe('passed');
        // S2: assert unconditionally so a column regression fails the test
        // instead of silently skipping the persistence contract.
        expect((row as Record<string, unknown>).plan_digest).toBe(
          expectedPlan.digest,
        );
        expect((row as Record<string, unknown>).plan_snapshot).toBeTruthy();
      } finally {
        db.close();
      }
    },
    WORKFLOW_SNAPSHOT_TIMEOUT_MS,
  );

  it(
    'calculates canonical plan digest for goal mode run and completes',
    async () => {
      const repoPath = createFixtureRepo(tempDirs);
      const io = createMemoryIo();

      await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
      io.takeStdout();

      const template = loadWorkflowTemplate({ name: 'goal' });
      const expectedPlan = projectRunPlan(template, {
        agent: 'mock',
        profile: 'cli',
        allowDirtyBase: false,
        templateId: template.id,
        templateVersion: template.version,
        mode: 'goal',
      });
      expect(expectedPlan.digest).toMatch(/^[a-f0-9]{64}$/);

      const exitCode = await runCli(
        [
          'run',
          '单步执行目标任务',
          '--goal',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      );

      const stdout = io.takeStdout();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('运行已启动');
      expect(stdout).toContain('状态: passed');
    },
    WORKFLOW_SNAPSHOT_TIMEOUT_MS,
  );
});

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
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
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-run-digest-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      main: 'index.js',
      scripts: {
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
      keywords: [],
      author: '',
      license: 'ISC',
      description: '',
    }),
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
