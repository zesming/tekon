export type RunKind = 'workflow' | 'goal';

export interface RunModePolicyInput {
  agent: string;
  kind: RunKind;
  template?: string | null;
  profile?: string | null;
}

/**
 * Return the first human-facing incompatibility for a requested run.
 *
 * This policy is shared by CLI and Web so provider/mode constraints fail before
 * a workflow, Session, or background job is created. Keep it limited to
 * product-level combinations that cannot succeed by design; provider-specific
 * capability checks still live in each adapter.
 */
export function getRunModePolicyIssue(
  input: RunModePolicyInput,
): string | null {
  if (input.kind === 'goal' && input.template?.trim()) {
    return '--goal 模式下不能同时指定 --template';
  }

  if (
    input.kind === 'goal' &&
    input.profile === 'autonomous-delivery'
  ) {
    return 'goal 模式不支持 autonomous-delivery；Goal 不进入 Gate、Artifact 或交付链路。';
  }

  if (input.agent === 'dsh-headless' && input.kind !== 'goal') {
    return 'dsh-headless 仅支持 goal 一次性任务；完整受控交付请改用 codex 或 claude-code，或启用 goal 模式。';
  }

  return null;
}
