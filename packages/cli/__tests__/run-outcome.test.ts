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

  it('does not offer resume for a failed run, pointing to explicit retry instead', () => {
    const lines = runOutcomeDetails({ status: 'failed', runId: 'run_1' });
    expect(lines.join('\n')).not.toContain('tekon resume');
    // PD-17 步 3：failed 终态的下一步是显式 retry，不是裸 resume。
    expect(lines.join('\n')).toContain('tekon retry --run-id run_1');
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

  it('tells a paused run waiting for a person how to continue', () => {
    expect(runOutcomeDetails({ status: 'paused', runId: 'run_1', pendingHuman: true })).toEqual([
      '  下一步: tekon review 查看后，执行 tekon resume --run-id run_1 --approve-human 批准并继续',
    ]);
    expect(runOutcomeDetails({ status: 'paused', runId: 'run_1' })).toEqual([
      '  下一步: 执行 tekon resume --run-id run_1 继续',
    ]);
  });

  it('gives the login hint for a run blocked by a failure retrying cannot fix', () => {
    expect(
      runOutcomeDetails({
        status: 'blocked',
        runId: 'run_1',
        failure: { kind: 'not-authenticated', message: 'claude 未登录或凭据无效', hint: '执行 claude auth login，然后执行 tekon resume' },
      }),
    ).toEqual([
      '  原因: claude 未登录或凭据无效',
      '  下一步: 执行 claude auth login，然后执行 tekon resume',
    ]);
  });

  it('does not repeat resume when the hint already leads with it', () => {
    const lines = runOutcomeDetails({
      status: 'interrupted',
      runId: 'run_1',
      failure: { kind: 'timeout', message: 'claude 运行超时', hint: '执行 tekon resume 重试；任务确实需要更久时，用更大的 --timeout-ms 重新执行 tekon run' },
    });
    expect(lines[1]).toBe('  下一步: 执行 tekon resume --run-id run_1 重试；任务确实需要更久时，用更大的 --timeout-ms 重新执行 tekon run');
    expect(lines[1]!.match(/tekon resume/gu)).toHaveLength(1);
  });

  it('renders the deterministic-block reason and its next step for a fail-fast blocked run', () => {
    expect(
      runOutcomeDetails({
        status: 'blocked',
        runId: 'run_1',
        failure: {
          kind: 'deterministic-block',
          message: '门禁绑定的检查命令仍缺失（missing-command），在配置修复前重跑 agent 必然再次失败。',
          hint: '在 .tekon/repo-profile.yaml 的 commands.build 下补全工具命令，然后恢复运行；要让本运行直接采用新配置，使用 tekon resume --rebind。',
        },
      }),
    ).toEqual([
      '  原因: 门禁绑定的检查命令仍缺失（missing-command），在配置修复前重跑 agent 必然再次失败。',
      '  下一步: 在 .tekon/repo-profile.yaml 的 commands.build 下补全工具命令，然后恢复运行；要让本运行直接采用新配置，使用 tekon resume --rebind。',
    ]);
  });
});
