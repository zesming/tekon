import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeProviderEnv,
  buildClaudeProviderSmokeEvidenceHtml,
  buildClaudeProviderSmokeEvidenceMarkdown,
} from '../../src/runtime/claude-code-support.js';

describe('claude provider smoke support', () => {
  afterEach(() => vi.useRealTimers());
  it('does not record smoke environment variable assignments in evidence', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-08T01:00:00.000Z'));
    const evidence = {
      version: '2.1.163 (Claude Code)',
      durationMs: 1234,
      stdoutPath: '/tmp/tekon/stdout.log',
      stderrPath: '/tmp/tekon/stderr.log',
    };

    const markdown = buildClaudeProviderSmokeEvidenceMarkdown(evidence);
    const html = buildClaudeProviderSmokeEvidenceHtml(evidence);

    for (const body of [markdown, html]) {
      expect(body).toContain('生成日期：2026-09-08');
      expect(body).toContain('npm run smoke:claude-provider');
      expect(body).toContain('具体值不记录');
      expect(body).not.toContain('TEKON_CLAUDE_PROVIDER_SMOKE=');
      expect(body).not.toContain('TEKON_CLAUDE_COMMAND=');
    }
  });

  it('keeps the login, proxy and Claude settings Claude needs but drops unrelated secrets', () => {
    expect(
      buildClaudeProviderEnv({
        PATH: '/usr/bin',
        HOME: '/tmp/tekon-home',
        LANG: 'C.UTF-8',
        USER: 'alice',
        LOGNAME: 'alice',
        HTTPS_PROXY: 'http://proxy.example:8080',
        https_proxy: 'http://proxy.example:8080',
        NO_PROXY: 'localhost',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CLAUDE_CODE_USE_BEDROCK: '1',
        GITHUB_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        MY_ANTHROPIC_KEY: 'secret',
        NODE_OPTIONS: '--require /tmp/evil.js',
        EMPTY_IGNORED: '',
        CLAUDE_EMPTY: '',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/tekon-home',
      LANG: 'C.UTF-8',
      USER: 'alice',
      LOGNAME: 'alice',
      HTTPS_PROXY: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });
});
