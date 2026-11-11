import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { redactSecrets } from '../security/secrets.js';
import type { AgentRunDiagnostic } from './agent-adapter.js';
import type { CommandGatewayResult } from './command-gateway.js';

/** Bytes read from the end of each provider log, for classification only. */
const TAIL_BYTES = 4096;
const MAX_DETAIL_CHARS = 300;

type ProviderName = 'claude-code' | 'codex' | 'dsh-headless' | 'custom';

const AUTH_FAILURE =
  /not logged in|\/login|invalid api key|api key.*(invalid|missing)|unauthori[sz]ed|\b401\b|authentication|oauth token|codex login|OPENAI_API_KEY/iu;

const LOGIN_HINT: Record<string, string> = {
  'claude-code': '执行 claude /login，或在启动 Tekon 的环境里配置 ANTHROPIC_API_KEY，然后执行 tekon resume',
  codex: '执行 codex login，或在启动 Tekon 的环境里配置 OPENAI_API_KEY，然后执行 tekon resume',
};

/**
 * Turns a provider process outcome into a stable, bounded diagnostic. Log
 * tails are read only to classify; they never leave this function except as
 * a single redacted, truncated detail line in `message`.
 */
export function classifyProviderFailure(input: {
  provider: ProviderName;
  command: string;
  result: CommandGatewayResult;
  /** The run's abort signal fired (user cancel, run stop). */
  aborted?: boolean;
}): AgentRunDiagnostic {
  const { provider, command, result } = input;
  if (input.aborted) {
    return diagnostic('cancelled', `${command} 已取消`, undefined);
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
    if (result.errorCode === 'ENOENT' || /\bENOENT\b/u.test(result.reason)) {
      return diagnostic(
        'not-installed',
        `找不到 ${command} 命令（Tekon 进程的 PATH 里没有）`,
        `安装 ${command} 并确认启动 Tekon 的终端里能执行它，然后执行 tekon resume`,
      );
    }
    return diagnostic(
      'invalid-config',
      `${command} 没有启动：${detail(result.reason)}`,
      '检查 .tekon/config.yaml 和 provider 配置，修改后执行 tekon resume',
    );
  }
  if (result.timedOut) {
    return diagnostic(
      'timeout',
      `${command} 运行超时`,
      '确认任务规模后用更大的 --timeout-ms 执行 tekon resume',
    );
  }
  const stdoutTail = readTail(result.stdoutPath);
  const stderrTail = readTail(result.stderrPath);
  const claudeError = provider === 'claude-code' ? lastClaudeError(stdoutTail) : undefined;
  const reason = claudeError ?? lastLine(stderrTail) ?? lastLine(stdoutTail);
  if (reason && AUTH_FAILURE.test(reason)) {
    return diagnostic(
      'not-authenticated',
      `${command} 未登录或凭据无效：${detail(reason)}`,
      LOGIN_HINT[provider] ?? '完成 provider 登录或配置凭据，然后执行 tekon resume',
    );
  }
  return diagnostic(
    'exit-nonzero',
    `${command} 退出码 ${String(result.exitCode)}${reason ? `：${detail(reason)}` : ''}`,
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
