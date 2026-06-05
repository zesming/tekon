import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CommandGateway,
  CommandGatewayRunInput,
} from '../../src/runtime/command-gateway.js';
import { createScmDelivery } from '../../src/delivery/scm.js';

describe('scm delivery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('dry-runs commit, push, and PR commands without side effects and requires approval before push', async () => {
    const repoPath = createGitRepo(tempDirs);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');

    const delivery = createScmDelivery({ repoPath });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.commands.map((command) => command.join(' '))).toEqual([
      'git checkout -B donkey/phase-3',
      'git add .',
      'git commit -m Phase 3 delivery',
      'git push -u origin donkey/phase-3',
      'gh pr create --title Phase 3 delivery --body Evidence body --head donkey/phase-3',
    ]);
    expect(
      execFileSync('git', ['status', '--short'], {
        cwd: repoPath,
        encoding: 'utf8',
      }),
    ).toContain('feature.txt');
  });

  it('captures a PR URL from a fake gh fixture after human-approved push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'donkey-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'donkey-fake-gh-'));
    tempDirs.push(remotePath, binDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFakeGh(binDir);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');

    const delivery = createScmDelivery({
      repoPath,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/1');
    expect(result.requiresHumanApproval).toBe(false);
    expect(readFileSync(join(binDir, 'gh.log'), 'utf8')).toContain('pr create');
  });

  it('reports remote, current branch, dirty worktree, auth, and approval requirements', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'donkey-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'donkey-fake-gh-auth-'));
    tempDirs.push(remotePath, binDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFakeGh(binDir, { authenticated: true });
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');

    const delivery = createScmDelivery({
      repoPath,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });

    const status = await delivery.getStatus({ branch: 'donkey/phase-3' });

    expect(status).toMatchObject({
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: remotePath,
      dirty: true,
      ghAuthenticated: true,
      branchPushed: false,
      pushRequiresHumanApproval: true,
      prRequiresHumanApproval: true,
    });
    expect(status.currentBranch).toBeTruthy();
  });

  it('uses CommandGateway argv commands for approved commit, push, and PR creation', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-logs-'));
    tempDirs.push(outputDir);
    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/donkey/pull/2\n', 'utf8');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath:
            input.command.tool === 'gh' && input.command.args[0] === 'pr'
              ? stdoutPath
              : join(outputDir, `${calls.length}.stdout.log`),
          stderrPath: join(outputDir, `${calls.length}.stderr.log`),
          durationMs: 1,
        };
      },
    };

    const delivery = createScmDelivery({ repoPath, gateway, outputDir });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/2');
    expect(calls.map((call) => call.command)).toEqual([
      { tool: 'git', args: ['checkout', '-B', 'donkey/phase-3'] },
      { tool: 'git', args: ['add', '.'] },
      { tool: 'git', args: ['commit', '-m', 'Phase 3 delivery'] },
      { tool: 'git', args: ['push', '-u', 'origin', 'donkey/phase-3'] },
      {
        tool: 'gh',
        args: [
          'pr',
          'create',
          '--title',
          'Phase 3 delivery',
          '--body',
          'Evidence body',
          '--head',
          'donkey/phase-3',
        ],
      },
    ]);
    expect(
      calls.every(
        (call) =>
          call.cwd === repoPath &&
          call.policy.network === 'enabled' &&
          call.policy.cwdScope.includes(repoPath),
      ),
    ).toBe(true);
  });
});

function createGitRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'donkey-scm-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'donkey@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Donkey Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

function writeFakeGh(
  binDir: string,
  options: { authenticated?: boolean } = {},
) {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
echo "$*" >> "${join(binDir, 'gh.log')}"
if [ "$1 $2" = "auth status" ]; then
  ${
    options.authenticated
      ? 'echo "Logged in to github.example" >&2\n  exit 0'
      : 'echo "not logged in" >&2\n  exit 1'
  }
fi
echo "https://github.example/donkey/pull/1"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
  expect(existsSync(ghPath)).toBe(true);
}
