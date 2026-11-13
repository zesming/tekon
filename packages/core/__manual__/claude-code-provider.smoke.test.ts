import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildClaudeProviderSmokeEvidenceHtml,
  buildClaudeProviderSmokeEvidenceMarkdown,
  type ClaudeProviderSmokeEvidenceInput,
} from '../src/runtime/claude-code-support.js';

// Contract 3 (T-17): the real-Claude smoke goes through the product entry
// point (`tekon run --goal` over a child CLI process: admission, engine and
// provider wiring), instead of calling the adapter directly.
//
// Opt-in only: TEKON_CLAUDE_PROVIDER_SMOKE=1. Without it the suite skips, so
// the default test entry never spends provider quota or needs a login. A fake
// ANTHROPIC_API_KEY is used only to prove doctor classifies "API key"; no real
// secret is ever written to evidence. Requires a built CLI
// (`pnpm --filter @tekon/cli build`) and an authenticated claude on PATH.
const smokeEnabled = process.env.TEKON_CLAUDE_PROVIDER_SMOKE === '1';
const describeSmoke = smokeEnabled ? describe : describe.skip;

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

describeSmoke('claude-code provider manual smoke (contract 3)', () => {
  it('runs a goal workflow through tekon run and classifies a fake api key in doctor', () => {
    expect(
      existsSync(cliPath),
      `built CLI required at ${cliPath}; run pnpm --filter @tekon/cli build`,
    ).toBe(true);

    const claudeCommand = process.env.TEKON_CLAUDE_COMMAND ?? 'claude';
    const version = execFileSync(claudeCommand, ['--version'], {
      encoding: 'utf8',
    }).trim();

    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-claude-smoke-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'smoke@tekon.local'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Tekon Smoke'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    writeFileSync(
      join(repoPath, 'README.md'),
      'TEKON_CLAUDE_PROVIDER_SMOKE_FIXTURE\n',
      'utf8',
    );
    execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'fixture'], {
      cwd: repoPath,
      stdio: 'pipe',
    });

    const tekon = (
      args: string[],
      extraEnv: NodeJS.ProcessEnv = {},
    ): SpawnSyncReturns<string> =>
      spawnSync(process.execPath, [cliPath, ...args, '--repo', repoPath], {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 240_000,
        env: { ...process.env, ...extraEnv },
      });

    expect(tekon(['init']).status).toBe(0);

    const startedAt = Date.now();
    const run = tekon([
      'run',
      'Read README.md and complete the single goal node.',
      '--goal',
      '--agent',
      'claude-code',
      '--allow-dirty-base',
    ]);
    const durationMs = Date.now() - startedAt;

    const stdoutPath = join(repoPath, 'smoke-stdout.log');
    const stderrPath = join(repoPath, 'smoke-stderr.log');
    writeFileSync(stdoutPath, run.stdout, 'utf8');
    writeFileSync(stderrPath, run.stderr, 'utf8');

    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('运行已完成');

    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(run.stdout)?.[1];
    expect(runId, run.stdout).toBeTruthy();
    const status = tekon(['status', '--run-id', runId!]);
    expect(status.stdout).toContain('status=passed');

    // A fake key (not a real credential) must be reported as the API-key
    // authentication kind, distinct from subscription login. The host shell
    // may already hold an OAuth login or ANTHROPIC_AUTH_TOKEN, which would
    // win the classification, so run doctor against an isolated HOME with
    // only the fake key present (the real CLI then reports authMethod
    // api_key; verified manually against claude auth status --json).
    const isolatedHome = mkdtempSync(join(tmpdir(), 'tekon-smoke-doctor-home-'));
    const doctorEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      ANTHROPIC_API_KEY: 'sk-ant-tekon-smoke-fake-key',
    };
    // A fresh HOME makes the real CLI's first auth-status probe race its own
    // cold-start initialization; allow one retry before failing the smoke.
    let doctor = tekon(['doctor'], doctorEnv);
    if (!`${doctor.stdout}${doctor.stderr}`.includes('API key')) {
      doctor = tekon(['doctor'], doctorEnv);
    }
    expect(`${doctor.stdout}${doctor.stderr}`).toContain('API key');
    rmSync(isolatedHome, { recursive: true, force: true });

    writeEvidence({ version, durationMs, stdoutPath, stderrPath });
  }, 300_000);
});

function writeEvidence(input: {
  version: string;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}): void {
  const reviewDir = join(repoRoot, 'docs', 'reviews');
  mkdirSync(reviewDir, { recursive: true });
  const executedAt = new Date();
  const evidenceName = `${executedAt.toISOString().slice(0, 10)}-claude-provider-smoke-evidence`;
  const markdownPath = join(reviewDir, `${evidenceName}.md`);
  const htmlPath = join(reviewDir, `${evidenceName}.html`);
  const evidence: ClaudeProviderSmokeEvidenceInput = { ...input, executedAt };
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
