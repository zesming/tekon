import { describe, expect, it } from 'vitest';

import { preflightWarning } from '../../src/client/lib/preflight-warning.js';

describe('preflightWarning', () => {
  it('returns null without a preflight result or when nothing is noteworthy', () => {
    expect(preflightWarning(undefined)).toBeNull();
    expect(
      preflightWarning({
        provider: 'claude-code',
        auth: 'subscription',
        passthroughEnv: [],
        warnings: [],
      }),
    ).toBeNull();
  });

  it('warns on missing login and lists passthrough variable names', () => {
    const warning = preflightWarning({
      provider: 'claude-code',
      auth: 'none',
      passthroughEnv: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
      warnings: [],
    });
    expect(warning).toContain('未检测到 claude-code 的登录凭据');
    expect(warning).toContain('ANTHROPIC_BASE_URL、CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('includes server-provided warnings and treats unknown auth as soft', () => {
    const warning = preflightWarning({
      provider: 'codex',
      auth: 'unknown',
      passthroughEnv: [],
      warnings: ['codex 版本低于推荐版本'],
    });
    expect(warning).toContain('未检测到 codex 的登录凭据');
    expect(warning).toContain('codex 版本低于推荐版本');
  });

  it('keeps an authenticated run with only passthrough vars informative', () => {
    const warning = preflightWarning({
      provider: 'codex',
      auth: 'api-key',
      passthroughEnv: ['OPENAI_API_KEY'],
      warnings: [],
    });
    expect(warning).toBe('将透传环境变量：OPENAI_API_KEY。');
  });
});
