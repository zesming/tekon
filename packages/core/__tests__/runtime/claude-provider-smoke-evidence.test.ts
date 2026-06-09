import { describe, expect, it } from 'vitest';

import {
  buildClaudeProviderEnv,
  buildClaudeProviderSmokeEvidenceHtml,
  buildClaudeProviderSmokeEvidenceMarkdown,
} from '../../src/runtime/claude-code-support.js';

describe('claude provider smoke support', () => {
  it('does not record smoke environment variable assignments in evidence', () => {
    const evidence = {
      version: '2.1.163 (Claude Code)',
      durationMs: 1234,
      stdoutPath: '/tmp/tekon/stdout.log',
      stderrPath: '/tmp/tekon/stderr.log',
    };

    const markdown = buildClaudeProviderSmokeEvidenceMarkdown(evidence);
    const html = buildClaudeProviderSmokeEvidenceHtml(evidence);

    for (const body of [markdown, html]) {
      expect(body).toContain('npm run smoke:claude-provider');
      expect(body).toContain('具体值不记录');
      expect(body).not.toContain('TEKON_CLAUDE_PROVIDER_SMOKE=');
      expect(body).not.toContain('TEKON_CLAUDE_COMMAND=');
    }
  });

  it('uses an allowlisted environment for Claude provider preflight checks', () => {
    expect(
      buildClaudeProviderEnv({
        PATH: '/usr/bin',
        HOME: '/tmp/tekon-home',
        LANG: 'C.UTF-8',
        ANTHROPIC_API_KEY: 'secret',
        CLAUDE_CODE_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        NODE_OPTIONS: '--require /tmp/evil.js',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/tekon-home',
      LANG: 'C.UTF-8',
    });
  });
});
