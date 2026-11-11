import type {
  ProviderAuthKind,
  ProviderPreflightResult,
  RunFailureReason,
} from '@tekon/core';

const AUTH_LABEL: Record<ProviderAuthKind, string> = {
  'api-key': 'API key',
  'auth-token': 'auth token（ANTHROPIC_AUTH_TOKEN）',
  'oauth-token': 'OAuth token',
  subscription: '订阅登录',
  'stored-login': '已保存的登录',
  none: '未检测到',
  unknown: '无法确定',
};

export function formatAuthKind(auth: ProviderAuthKind): string {
  return AUTH_LABEL[auth];
}

/** One stderr block describing the provider check of this start or resume. */
export function formatPreflightNotice(
  preflight: ProviderPreflightResult | undefined,
): string {
  if (!preflight) return '';
  const lines = [`Provider: ${preflight.provider}，认证方式: ${AUTH_LABEL[preflight.auth]}`];
  if (preflight.passthroughEnv.length > 0) {
    lines.push(`透传环境变量: ${preflight.passthroughEnv.join(', ')}`);
  }
  for (const warning of preflight.warnings) lines.push(`注意: ${warning}`);
  return `${lines.join('\n')}\n`;
}

/** Header line for a run that reached this status. */
export function runOutcomeHeader(status: string, pendingHuman: boolean): string {
  switch (status) {
    case 'passed':
      return '✅ 运行已完成';
    case 'paused':
      return pendingHuman ? '⏸ 运行已暂停，等待人工确认' : '⏸ 运行已暂停';
    case 'blocked':
      return '⏸ 运行等待处理';
    case 'failed':
      return '❌ 运行失败';
    case 'interrupted':
      return '⚠ 运行中断';
    case 'cancelled':
      return '⏹ 运行已取消';
    default:
      return '🚀 运行已启动';
  }
}

/**
 * Reason and next step for a run that stopped short. Resume leads only when
 * retrying can help (a non-zero exit or a timeout); otherwise the fix comes
 * first.
 */
export function runOutcomeDetails(input: {
  status: string;
  runId: string;
  failure?: RunFailureReason;
}): string[] {
  const { status, runId, failure } = input;
  const resume = `tekon resume --run-id ${runId}`;
  if (status === 'interrupted') {
    if (!failure) {
      return [`  下一步: tekon log --run-id ${runId} 查看原因，修复后执行 ${resume}`];
    }
    const retryFirst = failure.kind === 'exit-nonzero' || failure.kind === 'timeout';
    return [
      `  原因: ${failure.message}`,
      retryFirst
        ? `  下一步: 执行 ${resume} 重试；仍失败时 ${failure.hint ?? `用 tekon log --run-id ${runId} 查看日志`}`
        : `  下一步: ${failure.hint ?? `修复后执行 ${resume}`}`,
    ];
  }
  if (status === 'failed') {
    return [
      ...(failure ? [`  原因: ${failure.message}`] : []),
      `  运行已失败且不能恢复；用 tekon log --run-id ${runId} 查看详情`,
    ];
  }
  if (status === 'blocked') {
    return [
      ...(failure ? [`  原因: ${failure.message}`] : []),
      `  下一步: tekon review 查看需要处理的内容，处理后执行 ${resume}`,
    ];
  }
  return [];
}
