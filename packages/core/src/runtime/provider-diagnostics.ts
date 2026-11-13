import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

import { redactSecrets } from '../security/secrets.js';
import { isJobCancellationAbort } from '../session/job-runner.js';
import type { AgentRunDiagnostic } from './agent-adapter.js';
import type { CommandGatewayResult } from './command-gateway.js';

/** Bytes read from the end of each provider log, for classification only. */
const TAIL_BYTES = 16 * 1024;
const MAX_DETAIL_CHARS = 300;

type ProviderName = 'claude-code' | 'codex' | 'dsh-headless' | 'custom';

// Each provider's own login errors. Bare words such as "authentication" or
// "401" also appear in unrelated failures, so they are not enough alone.
const AUTH_FAILURE: Record<string, RegExp> = {
  'claude-code':
    /not logged in|please run \/login|invalid api key|oauth token has expired|authentication_error|invalid x-api-key/iu,
  codex:
    /not logged in|run `?codex login|401 unauthorized|invalid api key|incorrect api key|missing (an )?api key/iu,
};

const LOGIN_HINT: Record<string, string> = {
  'claude-code':
    '执行 claude auth login（或在 claude 里输入 /login），或在启动 Tekon 的环境里配置 ANTHROPIC_API_KEY，然后执行 tekon resume',
  codex: '执行 codex login，或在启动 Tekon 的环境里配置 OPENAI_API_KEY，然后执行 tekon resume',
};

/**
 * Turns a provider process outcome into a stable, bounded diagnostic. Log
 * tails are read only to classify; only a non-zero exit keeps one redacted,
 * truncated line of provider output in `message`.
 */
export function classifyProviderFailure(input: {
  provider: ProviderName;
  command: string;
  result: CommandGatewayResult;
  /** The job's abort signal; its reason tells a user cancel from a shutdown. */
  signal?: AbortSignal;
  /** Working directory the provider was started in. */
  cwd?: string;
}): AgentRunDiagnostic {
  const { provider, command, result } = input;
  if (input.signal?.aborted) {
    return isJobCancellationAbort(input.signal)
      ? diagnostic('cancelled', `${command} 已取消`, undefined)
      : diagnostic(
          'interrupted',
          `Tekon 停止时 ${command} 被中断`,
          '执行 tekon resume 继续这次运行',
        );
  }
  if (result.status === 'blocked-for-approval') {
    return diagnostic(
      'approval-blocked',
      `${command} 的命令在等待审批（${result.decisionId}）`,
      '处理这条审批后，运行会继续或需要执行 tekon resume',
    );
  }
  if (result.status === 'rejected') {
    if (result.cancelled) {
      return diagnostic('cancelled', `${command} 已取消`, undefined);
    }
    if (result.errorCode === 'ENOENT') {
      if (input.cwd && !existsSync(input.cwd)) {
        return diagnostic(
          'invalid-config',
          `${command} 的工作目录不存在：${input.cwd}`,
          '确认运行的工作目录（worktree）还在，必要时用 tekon run 新建运行',
        );
      }
      return diagnostic(
        'not-installed',
        `找不到 ${command} 命令（Tekon 进程的 PATH 里没有）`,
        `安装 ${command} 并确认启动 Tekon 的终端里能执行它，然后执行 tekon resume`,
      );
    }
    return diagnostic(
      'invalid-config',
      `${command} 没有启动：${detail(result.reason)}`,
      '检查 .tekon/config.yaml 和 provider 配置；恢复运行沿用启动时的 provider 配置，修改后用 tekon run 新建运行',
    );
  }
  if (result.timedOut) {
    return result.timeoutReason === 'no-progress'
      ? diagnostic(
          'timeout',
          `${command} 长时间没有进展，已停止`,
          '执行 tekon resume 重试；任务确实需要更久没有输出时，用更大的 --no-progress-timeout-ms 重新执行 tekon run',
        )
      : diagnostic(
          'timeout',
          `${command} 运行超时`,
          '执行 tekon resume 重试；任务确实需要更久时，用更大的 --timeout-ms 重新执行 tekon run',
        );
  }
  const stdoutTail = readTail(result.stdoutPath);
  const stderrTail = readTail(result.stderrPath);
  const claudeError = provider === 'claude-code' ? lastClaudeError(stdoutTail) : undefined;
  const reason = claudeError ?? lastLine(stderrTail) ?? lastLine(stdoutTail);
  if (reason && AUTH_FAILURE[provider]?.test(reason)) {
    // Login errors can carry account details; keep a fixed message.
    return diagnostic(
      'not-authenticated',
      `${command} 未登录或凭据无效`,
      LOGIN_HINT[provider] ?? '完成 provider 登录或配置凭据，然后执行 tekon resume',
    );
  }
  const how = claudeError && result.exitCode === 0
    ? '报告错误'
    : result.exitCode === null
      ? `被信号 ${result.signal ?? '未知'} 终止`
      : `退出码 ${result.exitCode}`;
  return diagnostic(
    'exit-nonzero',
    `${command} ${how}${reason ? `：${detail(reason)}` : ''}`,
    '查看节点日志找到原因，修复后执行 tekon resume',
  );
}

/** Claude's `--output-format json` result line, when it reports an error. */
export function lastClaudeError(stdoutTail: string): string | undefined {
  const lines = stdoutTail.split(/\r?\n/u).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as { is_error?: unknown; result?: unknown };
      if (parsed && typeof parsed === 'object' && 'is_error' in parsed) {
        return parsed.is_error === true
          ? String(parsed.result ?? 'Claude reported an error')
          : undefined;
      }
    } catch {
      // Not a complete JSON line; keep looking further up.
    }
  }
  return undefined;
}

/** Reads the redacted end of a provider log; missing files read as empty. */
export function readTail(path: string | undefined): string {
  if (!path) return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    // Drop a possibly cut first line so classification sees whole lines.
    const text = buffer.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1);
}

function detail(text: string): string {
  const redacted = redactSecrets(text).content.replace(/\s+/gu, ' ').trim();
  return redacted.length > MAX_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : redacted;
}

function diagnostic(
  code: AgentRunDiagnostic['code'],
  message: string,
  hint: string | undefined,
): AgentRunDiagnostic {
  return { code, message, ...(hint ? { hint } : {}) };
}
