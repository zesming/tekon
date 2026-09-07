import { formatTimeout } from '../../lib/plan-format.js';
import { comparePlanCommandBindings, type BindingPreview, type PlanBindingComparison } from '../../lib/plan-command-bindings.js';

type Binding = NonNullable<BindingPreview['gates'][number]['commandBinding']>;
const BEHAVIOR_LABELS: Record<Binding['behavior'], string> = {
  'execute-command': '将执行已绑定命令',
  skip: '将跳过此检查',
  'missing-command': '缺少命令，检查将失败',
  'builtin-security': '仍执行内置安全扫描',
  'builtin-security-and-command': '内置安全扫描及已绑定命令',
  'not-command-gate': '按检查规则执行',
};
const SOURCE_LABELS: Record<Binding['source'], string> = {
  template: '模板定义',
  'repo-profile': '仓库检查配置',
  'package-json-detection': '项目脚本自动识别',
  'empty-default': '未发现仓库命令配置',
};
const CHANGE_LABELS = { added: '新增', removed: '移除', changed: '已变化' } as const;

export function PlanCommandBindings({ plan, comparison = comparePlanCommandBindings(undefined, plan), onRefresh }: {
  plan: BindingPreview;
  comparison?: PlanBindingComparison;
  onRefresh?: () => void;
}) {
  const count = (behavior: Binding['behavior']) => plan.gates.filter((gate) => gate.commandBinding?.behavior === behavior).length;
  const missing = count('missing-command');
  const skipped = count('skip');
  return (
    <section className="plan-command-bindings" data-testid="plan-command-bindings" aria-label="检查配置与适用性">
      <div className="plan-command-bindings-header">
        <strong>检查配置与适用性</strong>
        {onRefresh ? <button type="button" className="btn btn-ghost btn-xs" onClick={onRefresh}>刷新检查配置</button> : null}
      </div>
      <p className="text-muted">{plan.gates.length} 个控制点{skipped > 0 ? ` · ${skipped} 项将跳过` : ''}{missing > 0 ? ` · ${missing} 项缺少命令` : ''}</p>
      <div className="plan-binding-comparison" role="status" aria-live="polite">
        {comparison.status === 'unavailable' ? <p>暂无逐项变化信息；可刷新检查配置。</p> : null}
        {comparison.status === 'unchanged' ? <p>检查配置未变化。</p> : null}
        {comparison.status === 'changed' ? (
          <>
            <p>{comparison.settingsChanged ? '模板或运行设置已变化。' : '检查配置已变化。'}请核对后再次提交。</p>
            {comparison.changes.length > 0 ? <ul>{comparison.changes.map((change) => (
              <li key={`${change.kind}:${change.nodeId}:${change.gateIndex}`}>
                {change.nodeId} · 第 {change.gateIndex + 1} 项 {change.type}：{CHANGE_LABELS[change.kind]}
              </li>
            ))}</ul> : null}
          </>
        ) : null}
      </div>
      <details>
        <summary>查看逐项检查配置</summary>
        <ul className="plan-binding-list">
          {plan.gates.map((gate, index) => {
            const binding = gate.commandBinding;
            return (
              <li key={`${gate.nodeId}:${gate.gateIndex ?? index}`}>
                <div className="plan-binding-title"><strong>{gate.type}</strong><span>{gate.role} · {gate.nodeId}</span>{gate.requiresHumanApproval ? <span className="badge-tag risk">人工审批</span> : null}</div>
                <p>{binding ? BEHAVIOR_LABELS[binding.behavior] ?? '暂无法确认检查方式' : '暂无检查绑定信息'}</p>
                {binding ? <p className="text-muted">{SOURCE_LABELS[binding.source]}{binding.commandRef ? ` · ${binding.commandRef}` : ''}{binding.status === 'not-applicable' ? ' · 仓库配置标记为不适用' : ''}</p> : null}
                {gate.timeoutMs !== undefined ? <p className="text-muted">超时：{formatTimeout(gate.timeoutMs)}</p> : null}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
