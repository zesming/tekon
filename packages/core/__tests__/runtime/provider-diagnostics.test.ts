import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyProviderFailure } from '../../src/runtime/provider-diagnostics.js';
import { JOB_ABORT_REASON_SHUTDOWN } from '../../src/session/job-runner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logs(stdout: string, stderr: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-diag-'));
  dirs.push(dir);
  const stdoutPath = join(dir, 'out.log');
  const stderrPath = join(dir, 'err.log');
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  return { stdoutPath, stderrPath };
}

function executed(
  exitCode: number | null,
  stdout = '',
  stderr = '',
  timedOut = false,
  extra: { signal?: NodeJS.Signals; timeoutReason?: 'total' | 'no-progress' } = {},
) {
  return {
    status: 'executed' as const,
    exitCode,
    signal: extra.signal ?? null,
    timedOut,
    ...(extra.timeoutReason ? { timeoutReason: extra.timeoutReason } : {}),
    durationMs: 1,
    ...logs(stdout, stderr),
  };
}

describe('classifyProviderFailure', () => {
  it('classifies a missing binary as not-installed', () => {
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: { status: 'rejected', reason: 'spawn claude ENOENT', errorCode: 'ENOENT' },
    });
    expect(diagnostic).toMatchObject({ code: 'not-installed' });
    expect(diagnostic.message).toContain('claude');
    expect(diagnostic.hint).toBeTruthy();
  });

  it('keeps cancellation and approval reasons', () => {
    expect(
      classifyProviderFailure({
        provider: 'codex',
        command: 'codex',
        result: { status: 'rejected', reason: 'command cancelled before spawn', cancelled: true },
      }).code,
    ).toBe('cancelled');
    const blocked = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: { status: 'blocked-for-approval', decisionId: 'decision_9' },
    });
    expect(blocked.code).toBe('approval-blocked');
    expect(blocked.message).toContain('decision_9');
  });

  it('treats other gateway rejections as invalid configuration', () => {
    const diagnostic = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: { status: 'rejected', reason: 'command not allowed by policy: codex' },
    });
    expect(diagnostic.code).toBe('invalid-config');
    expect(diagnostic.message).toContain('command not allowed by policy');
    // resume keeps the provider settings frozen at start.
    expect(diagnostic.hint).toContain('tekon run');
    expect(diagnostic.hint).not.toMatch(/修改后执行 tekon resume/u);
  });

  it('classifies timeouts', () => {
    expect(
      classifyProviderFailure({
        provider: 'claude-code',
        command: 'claude',
        result: executed(143, '', '', true),
      }).code,
    ).toBe('timeout');
  });

  it.each([
    'Invalid API key · Please run /login',
    'Not logged in · Please run /login',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
  ])('reads the Claude is_error result line: %s', (text) => {
    const stdout = `noise\n${JSON.stringify({ type: 'result', is_error: true, result: text })}\n`;
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(1, stdout),
    });
    expect(diagnostic.code).toBe('not-authenticated');
    expect(diagnostic.hint).toContain('/login');
  });

  it('reports other Claude errors as exit-nonzero with the result text', () => {
    const stdout = `${JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' })}\n`;
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(1, stdout),
    });
    expect(diagnostic).toMatchObject({ code: 'exit-nonzero' });
    expect(diagnostic.message).toContain('Credit balance is too low');
  });

  it('checks is_error even when Claude exits 0', () => {
    const stdout = `${JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })}\n`;
    expect(
      classifyProviderFailure({
        provider: 'claude-code',
        command: 'claude',
        result: executed(0, stdout),
      }).code,
    ).toBe('not-authenticated');
  });

  it('uses the last stderr line for Codex', () => {
    const codexAuth = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: executed(1, '', 'starting\nNot logged in. Run codex login.\n'),
    });
    expect(codexAuth.code).toBe('not-authenticated');
    expect(codexAuth.hint).toContain('codex login');
    const other = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: executed(2, '', 'starting\nmodel not found: gpt-x\n'),
    });
    expect(other).toMatchObject({ code: 'exit-nonzero' });
    expect(other.message).toContain('model not found: gpt-x');
    expect(other.message).toContain('2');
  });

  it('bounds the message', () => {
    const diagnostic = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: executed(1, '', `${'x'.repeat(5000)}\n`),
    });
    expect(diagnostic.message.length).toBeLessThanOrEqual(500);
  });

  it('reports a run stopped by Tekon shutting down as an interruption to resume', () => {
    const controller = new AbortController();
    controller.abort(JOB_ABORT_REASON_SHUTDOWN);
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(null, '', '', false, { signal: 'SIGTERM' }),
      signal: controller.signal,
    });
    expect(diagnostic.code).toBe('interrupted');
    expect(diagnostic.hint).toContain('tekon resume');
  });

  it('reports a user cancellation as cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      classifyProviderFailure({
        provider: 'claude-code',
        command: 'claude',
        result: executed(null, '', '', false, { signal: 'SIGTERM' }),
        signal: controller.signal,
      }).code,
    ).toBe('cancelled');
  });

  it.each([
    ['claude-code', "Error: Cannot find module './authentication'"],
    ['claude-code', 'AssertionError: expected 401 to equal 200'],
    ['codex', 'Rate limit reached for requests using OPENAI_API_KEY org-x, retry in 20s'],
  ] as const)('does not mistake %s output for a login problem: %s', (provider, stderr) => {
    expect(
      classifyProviderFailure({ provider, command: provider, result: executed(1, '', stderr) }).code,
    ).toBe('exit-nonzero');
  });

  it.each([
    ['codex', 'Error: Not logged in. Run `codex login` first.'],
    ['codex', 'unexpected status 401 Unauthorized: invalid api key'],
  ] as const)('recognizes the %s login error: %s', (provider, stderr) => {
    expect(
      classifyProviderFailure({ provider, command: provider, result: executed(1, '', stderr) }).code,
    ).toBe('not-authenticated');
  });

  it('keeps provider output out of the login message', () => {
    const stdout = `${JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in as someone@example.invalid · Please run /login' })}\n`;
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(1, stdout),
    });
    expect(diagnostic.code).toBe('not-authenticated');
    expect(diagnostic.message).not.toContain('someone@example.invalid');
    expect(diagnostic.hint).toContain('claude auth login');
  });

  it('only treats a spawn errno as a missing command', () => {
    expect(
      classifyProviderFailure({
        provider: 'claude-code',
        command: 'claude',
        result: { status: 'rejected', reason: 'failed to write command logs: ENOENT' },
      }).code,
    ).toBe('invalid-config');
  });

  it('reports a missing working directory instead of a missing command', () => {
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: { status: 'rejected', reason: 'spawn claude ENOENT', errorCode: 'ENOENT' },
      cwd: join(tmpdir(), 'tekon-diag-missing-cwd-does-not-exist'),
    });
    expect(diagnostic.code).toBe('invalid-config');
    expect(diagnostic.message).toContain('工作目录');
  });

  it('describes an error reported with exit code 0 without calling it an exit code', () => {
    const stdout = `${JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' })}\n`;
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(0, stdout),
    });
    expect(diagnostic.code).toBe('exit-nonzero');
    expect(diagnostic.message).not.toContain('退出码 0');
    expect(diagnostic.message).toContain('Credit balance is too low');
  });

  it('names the signal when the provider was killed', () => {
    const diagnostic = classifyProviderFailure({
      provider: 'codex',
      command: 'codex',
      result: executed(null, '', '', false, { signal: 'SIGKILL' }),
    });
    expect(diagnostic.message).toContain('SIGKILL');
    expect(diagnostic.message).not.toContain('null');
  });

  it.each([
    ['total', '--timeout-ms'],
    ['no-progress', '--no-progress-timeout-ms'],
  ] as const)('gives a runnable next step for a %s timeout', (timeoutReason, flag) => {
    const diagnostic = classifyProviderFailure({
      provider: 'claude-code',
      command: 'claude',
      result: executed(null, '', '', true, { timeoutReason }),
    });
    expect(diagnostic.code).toBe('timeout');
    expect(diagnostic.hint).toContain('tekon resume');
    expect(diagnostic.hint).toContain(`${flag}`);
    expect(diagnostic.hint).toContain('tekon run');
    expect(diagnostic.hint).not.toMatch(/--timeout-ms 执行 tekon resume/u);
  });
});
