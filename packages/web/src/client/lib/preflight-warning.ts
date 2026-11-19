import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

export type RunPreflight =
  RpcProcedureMap['project.run']['output']['preflight'];

/**
 * Build a human-readable, non-blocking warning from a provider preflight
 * result (PD-02 Web). Hard failures (provider not installed) are already
 * rejected server-side; this surfaces softer signals such as missing login and
 * the passthrough variable names that will reach the provider process.
 * Returns null when there is nothing worth telling the user.
 */
export function preflightWarning(preflight: RunPreflight): string | null {
  if (!preflight) return null;
  const lines: string[] = [];
  if (preflight.auth === 'none' || preflight.auth === 'unknown') {
    lines.push(`未检测到 ${preflight.provider} 的登录凭据，节点可能失败，请先完成登录。`);
  }
  for (const warning of preflight.warnings) lines.push(warning);
  if (preflight.passthroughEnv.length > 0) {
    lines.push(`将透传环境变量：${preflight.passthroughEnv.join('、')}。`);
  }
  return lines.length > 0 ? lines.join(' ') : null;
}
