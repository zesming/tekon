const EXPLANATIONS = {
  frozen: '仓库检查已绑定：执行与恢复使用本次记录的检查命令和适用性。此提示不保证脚本内容、依赖或整个运行环境不变。',
  'legacy-unbound': '历史计划未记录仓库命令绑定；使用 commandRef 时会按当前配置解析。历史运行不会自动升级为新计划。',
  invalid: '计划绑定记录无效，无法按此记录执行或恢复。请保留原运行，联系仓库维护者核查。',
  unknown: '暂无法确认检查绑定。请刷新查看；执行前仍需通过服务端校验。',
} as const;

export function ExecutionBindingNotice({ value }: { value?: string }) {
  const state = value && Object.hasOwn(EXPLANATIONS, value) ? value as keyof typeof EXPLANATIONS : 'unknown';
  return <p className="execution-binding-notice text-sm" data-testid="execution-binding-notice" data-binding-state={state} role="status">{EXPLANATIONS[state]}</p>;
}
