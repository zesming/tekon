import { useState } from 'react';
import { comparePlanCommandBindings, type BindingPreview } from '../lib/plan-command-bindings.js';

/**
 * 由持续挂载的入口持有上一份成功预览。刷新中的展示组件可以卸载；上下文切换
 * 在本次 render 就丢弃旧比较，不等待父子 passive effects 的执行顺序。
 */
export function usePlanCommandComparison(
  contextKey: string,
  plan: BindingPreview | undefined,
  ready: boolean,
) {
  const [history, setHistory] = useState(() => ({
    contextKey,
    plan: ready ? plan : undefined,
    comparison: comparePlanCommandBindings(undefined, ready ? plan : undefined),
  }));
  if (history.contextKey !== contextKey || (ready && plan && history.plan !== plan)) {
    const next = {
      contextKey,
      plan: ready ? plan : undefined,
      comparison: comparePlanCommandBindings(
        history.contextKey === contextKey ? history.plan : undefined,
        ready ? plan : undefined,
      ),
    };
    setHistory(next);
    return next.comparison;
  }
  return history.comparison;
}
