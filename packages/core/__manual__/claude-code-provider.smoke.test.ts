import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter, createCommandGateway } from '../src/index.js';
import {
  buildClaudeProviderEnv,
  buildClaudeProviderSmokeEvidenceHtml,
  buildClaudeProviderSmokeEvidenceMarkdown,
  type ClaudeProviderSmokeEvidenceInput,
} from '../src/runtime/claude-code-support.js';

describe('claude-code provider manual smoke', () => {
  it('requires explicit enablement and authenticated Claude CLI', async () => {
    if (process.env.TEKON_CLAUDE_PROVIDER_SMOKE !== '1') {
      throw new Error(
        'Claude provider smoke requires explicit enablement; this smoke is fail-closed.',
      );
    }

    const claudeCommand = process.env.TEKON_CLAUDE_COMMAND ?? 'claude';
    const preflightEnv = buildClaudeProviderEnv();
    const version = execFileSync(claudeCommand, ['--version'], {
      encoding: 'utf8',
      env: preflightEnv,
    }).trim();
    execFileSync(claudeCommand, ['auth', 'status'], {
      env: preflightEnv,
      stdio: 'pipe',
    });

    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-smoke-'));
    writeFileSync(
      join(repoPath, 'README.md'),
      'TEKON_CLAUDE_PROVIDER_SMOKE_FIXTURE\n',
      'utf8',
    );
    const dataDir = join(repoPath, '.tekon');
    const outputDir = join(dataDir, 'smoke');
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: claudeCommand,
        promptMode: 'stdin',
        outputFormat: 'json',
        timeoutMs: 120_000,
        args: ['-p'],
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: [repoPath],
          network: 'restricted',
          tools: {
            allow: ['Read'],
            deny: ['Bash(rm *)', 'Bash(git push *)', 'WebFetch', 'WebSearch'],
          },
        },
      },
      createCommandGateway(),
    );

    const result = await adapter.runAgent({
      roleConfig: { role: 'reviewer' },
      prompt:
        'Read README.md and print TEKON_CLAUDE_PROVIDER_SMOKE_OK. Do not edit files.',
      worktreeLease: {
        id: 'lease_smoke',
        runId: 'run_smoke',
        nodeId: 'node_claude',
        role: 'reviewer',
        repoPath,
        worktreePath: repoPath,
        branchName: 'tekon/run_smoke/node_claude-reviewer',
        createdAt: new Date().toISOString(),
      },
      outputDir,
      commandPolicy: {
        allow: [{ tool: claudeCommand, args: ['-p'] }],
        deny: [],
        cwdScope: [repoPath],
        network: 'restricted',
      },
      runContext: {
        projectId: 'manual',
        runId: 'run_smoke',
        nodeId: 'node_claude',
        repoPath,
        dataDir,
      },
    });

    expect(version.length).toBeGreaterThan(0);
    expect(result.provider).toBe('claude-code');
    expect(result.exitCode).toBe(0);
    expect(result.outputFiles).toHaveLength(2);
    expect(readFileSync(result.outputFiles[0]!, 'utf8')).toContain(
      'TEKON_CLAUDE_PROVIDER_SMOKE_OK',
    );

    writeEvidence({
      version,
      durationMs: result.durationMs,
      stdoutPath: result.outputFiles[0]!,
      stderrPath: result.outputFiles[1]!,
    });
  }, 150_000);
});

function writeEvidence(input: {
  version: string;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}): void {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
  );
  const reviewDir = join(repoRoot, 'docs', 'reviews');
  mkdirSync(reviewDir, { recursive: true });
  const markdownPath = join(
    reviewDir,
    '2026-06-05-claude-provider-smoke-evidence.md',
  );
  const htmlPath = join(
    reviewDir,
    '2026-06-05-claude-provider-smoke-evidence.html',
  );
  const evidence: ClaudeProviderSmokeEvidenceInput = input;
  writeFileSync(
    markdownPath,
    buildClaudeProviderSmokeEvidenceMarkdown(evidence),
    'utf8',
  );
  writeFileSync(
    htmlPath,
    buildClaudeProviderSmokeEvidenceHtml(evidence),
    'utf8',
  );
}
