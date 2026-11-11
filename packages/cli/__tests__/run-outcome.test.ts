import { describe, expect, it } from 'vitest';

import {
  formatPreflightNotice,
  runOutcomeDetails,
  runOutcomeHeader,
} from '../src/lib/run-outcome.js';

describe('run outcome output', () => {
  it('heads each final status with what happened', () => {
    expect(runOutcomeHeader('passed', false)).toBe('✅ 运行已完成');
    expect(runOutcomeHeader('paused', true)).toBe('⏸ 运行已暂停，等待人工确认');
    expect(runOutcomeHeader('failed', false)).toBe('❌ 运行失败');
    expect(runOutcomeHeader('interrupted', false)).toBe('⚠ 运行中断');
    expect(runOutcomeHeader('cancelled', false)).toBe('⏹ 运行已取消');
  });

  it('leads with the fix, and with resume only when retrying can help', () => {
    const fixFirst = runOutcomeDetails({
      status: 'interrupted',
      runId: 'run_1',
      failure: { kind: 'not-installed', message: '找不到 claude 命令', hint: '安装 claude' },
    });
    expect(fixFirst).toEqual(['  原因: 找不到 claude 命令', '  下一步: 安装 claude']);
    const retryFirst = runOutcomeDetails({
      status: 'interrupted',
      runId: 'run_1',
      failure: { kind: 'timeout', message: 'claude 运行超时' },
    });
    expect(retryFirst[1]).toMatch(/^ {2}下一步: 执行 tekon resume --run-id run_1 重试/u);
  });

  it('does not offer resume for a failed run', () => {
    const lines = runOutcomeDetails({ status: 'failed', runId: 'run_1' });
    expect(lines.join('\n')).not.toContain('tekon resume');
    expect(runOutcomeDetails({ status: 'passed', runId: 'run_1' })).toEqual([]);
  });

  it('names the auth category and passthrough variables, never values', () => {
    expect(
      formatPreflightNotice({
        provider: 'codex',
        auth: 'api-key',
        passthroughEnv: ['AZURE_OPENAI_API_KEY'],
        warnings: [],
      }),
    ).toBe('Provider: codex，认证方式: API key\n透传环境变量: AZURE_OPENAI_API_KEY\n');
    expect(formatPreflightNotice(undefined)).toBe('');
  });
});
