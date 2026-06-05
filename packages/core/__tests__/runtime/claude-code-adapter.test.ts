import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeCodeCommand,
  createClaudeCodeAdapter,
  createCommandGateway,
} from '../../src/index.js';

describe('claude code adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('builds permission-aware commands without bypassPermissions by default', () => {
    const command = buildClaudeCodeCommand(
      {
        provider: 'claude-code',
        command: 'claude',
        args: [],
        promptMode: 'arg-append',
        outputFormat: 'json',
        timeoutMs: 1000,
        permissionProfile: safePermissionProfile('/tmp/repo'),
      },
      { prompt: 'hello' },
    );

    expect(command.args).toContain('--output-format');
    expect(command.args).toContain('json');
    expect(command.args.join(' ')).not.toContain('bypassPermissions');
    expect(command.args.at(-1)).toBe('hello');
  });

  it('streams large stdout/stderr without deadlock and reports timeout', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-claude-agent-'));
    tempDirs.push(repoPath);
    const loudScript = join(repoPath, 'loud.mjs');
    const sleepScript = join(repoPath, 'sleep.mjs');
    writeFileSync(
      loudScript,
      "process.stdout.write('x'.repeat(128 * 1024))\nprocess.stderr.write('y'.repeat(128 * 1024))\n",
      'utf8',
    );
    writeFileSync(sleepScript, "setTimeout(() => {}, 10_000)\n", 'utf8');
    const gateway = createCommandGateway();

    const loudAdapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [loudScript],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 2_000,
        permissionProfile: safePermissionProfile(repoPath),
      },
      gateway,
    );
    const loudResult = await loudAdapter.runAgent(baseRunInput(repoPath));
    expect(loudResult).toMatchObject({ provider: 'claude-code', exitCode: 0, timedOut: false });

    const sleepAdapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: process.execPath,
        args: [sleepScript],
        promptMode: 'arg-append',
        outputFormat: 'text',
        timeoutMs: 50,
        permissionProfile: safePermissionProfile(repoPath),
      },
      gateway,
    );
    const sleepResult = await sleepAdapter.runAgent(baseRunInput(repoPath));
    expect(sleepResult).toMatchObject({ provider: 'claude-code', timedOut: true });
  });
});

function safePermissionProfile(repoPath: string) {
  return {
    sandbox: 'workspace-write' as const,
    approval: 'on-request' as const,
    filesystemScope: [repoPath],
    network: 'disabled' as const,
    tools: { allow: ['Read', 'Edit', 'Bash(git *)'], deny: ['Bash(rm *)'] },
  };
}

function baseRunInput(repoPath: string) {
  return {
    roleConfig: { role: 'rd' as const },
    prompt: 'fixture prompt',
    worktreeLease: {
      id: 'lease_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd' as const,
      repoPath,
      worktreePath: repoPath,
      branchName: 'donkey/run_1/node_1-rd',
      createdAt: '2026-06-05T00:00:00.000Z',
    },
    outputDir: join(repoPath, '.donkey', 'runs', 'run_1', 'agent'),
    commandPolicy: {
      allow: [{ tool: process.execPath, args: [] }],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: [repoPath],
      network: 'disabled' as const,
    },
    runContext: {
      runId: 'run_1',
      nodeId: 'node_1',
      projectId: 'project_1',
      repoPath,
      dataDir: '.donkey',
    },
  };
}
