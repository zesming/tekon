import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyProviderFailure } from '../../src/runtime/provider-diagnostics.js';

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

function executed(exitCode: number, stdout = '', stderr = '', timedOut = false) {
  return {
    status: 'executed' as const,
    exitCode,
    signal: null,
    timedOut,
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
});
