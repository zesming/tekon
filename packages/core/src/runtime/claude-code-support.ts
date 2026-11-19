export interface ClaudeProviderSmokeEvidenceInput {
  version: string;
  executedAt?: Date;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}

// Claude runs with an exact environment. Keep what it needs to find its
// login (USER/LOGNAME for the macOS Keychain), reach the network through a
// proxy, and read its own settings; drop everything else, such as other
// providers' keys and NODE_OPTIONS. Gate commands use the gateway default
// environment and never receive these values.
const CLAUDE_PROVIDER_SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'USER',
  'LOGNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

const CLAUDE_PROVIDER_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'] as const;

const SMOKE_COMMAND = 'npm run smoke:claude-provider';
const SMOKE_ENABLEMENT_NOTE =
  '已显式设置 smoke 开关和命令覆盖，环境变量具体值不记录。';

export function buildClaudeProviderEnv(
  source: NodeJS.ProcessEnv = process.env,
  passthroughEnv: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const allowed =
      (CLAUDE_PROVIDER_SAFE_ENV_KEYS as readonly string[]).includes(key) ||
      CLAUDE_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      passthroughEnv.includes(key);
    if (allowed && value) {
      env[key] = value;
    }
  }
  return env;
}

export function buildClaudeProviderSmokeEvidenceMarkdown(
  input: ClaudeProviderSmokeEvidenceInput,
): string {
  return `# Claude Provider Smoke 证据

生成日期：${(input.executedAt ?? new Date()).toISOString().slice(0, 10)}

## 结论

真实 Claude provider smoke 已执行成功。

## 证据

- Claude CLI version: ${input.version}
- command: \`${SMOKE_COMMAND}\`
- enablement: ${SMOKE_ENABLEMENT_NOTE}
- exit code: 0
- durationMs: ${input.durationMs}
- stdout log path: \`${input.stdoutPath}\`
- stderr log path: \`${input.stderrPath}\`

## 脱敏说明

未记录 API key、token、认证输出或环境变量值。
`;
}

export function buildClaudeProviderSmokeEvidenceHtml(
  input: ClaudeProviderSmokeEvidenceInput,
): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claude Provider Smoke 证据</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        line-height: 1.65;
        margin: 0;
        color: #17202a;
        background: #ffffff;
      }
      main {
        max-width: 900px;
        margin: 0 auto;
        padding: 40px 24px 72px;
      }
      h1,
      h2 {
        line-height: 1.25;
      }
      code {
        background: #eef2f7;
        border: 1px solid #dfe6ef;
        border-radius: 4px;
        padding: 1px 4px;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      li {
        margin: 6px 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Claude Provider Smoke 证据</h1>
      <p>生成日期：${(input.executedAt ?? new Date()).toISOString().slice(0, 10)}</p>
      <h2>结论</h2>
      <p>真实 Claude provider smoke 已执行成功。</p>
      <h2>证据</h2>
      <ul>
        <li>Claude CLI version: <code>${escapeHtml(input.version)}</code></li>
        <li>
          command:
          <pre><code>${escapeHtml(SMOKE_COMMAND)}</code></pre>
        </li>
        <li>
          enablement: ${escapeHtml(SMOKE_ENABLEMENT_NOTE)}
        </li>
        <li>exit code: <code>0</code></li>
        <li>durationMs: <code>${input.durationMs}</code></li>
        <li>
          stdout log path:
          <pre><code>${escapeHtml(input.stdoutPath)}</code></pre>
        </li>
        <li>
          stderr log path:
          <pre><code>${escapeHtml(input.stderrPath)}</code></pre>
        </li>
      </ul>
      <h2>脱敏说明</h2>
      <p>未记录 API key、token、认证输出或环境变量值。</p>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
