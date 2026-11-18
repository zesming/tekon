import { useEffect, useState } from 'react';

import { useQuery } from './use-query.js';
import { rpc } from '../lib/rpc-client.js';
import { authScope, queryKeys } from '../lib/query-keys.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

// PD-08：运行模板/Provider/Goal 选择的共享逻辑。SessionComposer（首页）与
// StartRunForm（高级表单）共用同一套 agent 常量、默认代理解析与 Goal/DSH
// 互斥约束；两个入口各自维护 JSX 与提交流程，这里只放无副作用的状态与查询。

export const AGENT_OPTIONS = [
  'codex',
  'claude-code',
  'mock',
  'dsh-headless',
] as const;

/** Human-facing labels; synthetic caveats stay inline, while dsh maturity is in adjacent help. */
export const AGENT_LABELS: Record<(typeof AGENT_OPTIONS)[number], string> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  mock: 'mock（仅测试/演示）',
  'dsh-headless': 'dsh-headless（仅 Goal）',
};

export type RunMode = 'workflow' | 'goal';

/** Goal 模式不携带模板；workflow 模式空串表示交给服务端缺省模板。 */
export function effectiveTemplateFor(
  mode: RunMode,
  template: string,
): string | undefined {
  return mode === 'goal' ? undefined : template || undefined;
}

export interface RunPlanSelection {
  mode: RunMode;
  setMode: (next: RunMode) => void;
  template: string;
  setTemplate: (next: string) => void;
  agent: string;
  setAgent: (next: string) => void;
  workflows: RpcProcedureMap['workflow.list']['output']['workflows'];
  effectiveTemplate: string | undefined;
  planKey: string;
}

/**
 * 单一事实源的运行选择状态：默认 workflow 模式、模板留空（服务端回落
 * lightweight-delivery）、agent 由 project.overview 的 defaultAgent 解析一次。
 * Goal 清空模板且 DSH 仅能在 Goal 下运行的约束与高级表单完全一致。
 */
export function useRunPlanSelection(token: string | null): RunPlanSelection {
  const [mode, setModeState] = useState<RunMode>('workflow');
  const [template, setTemplate] = useState('');
  const [agent, setAgentState] = useState('');
  const [agentInitialized, setAgentInitialized] = useState(false);

  const { data: workflowData } = useQuery<
    RpcProcedureMap['workflow.list']['output']
  >(queryKeys.workflows(), () => rpc.call('workflow.list'));

  const { data: overviewData } = useQuery<
    RpcProcedureMap['project.overview']['output']
  >(queryKeys.projectOverview(authScope(token)), () =>
    rpc.call('project.overview'),
  );

  useEffect(() => {
    if (agentInitialized || !overviewData?.defaultAgent) return;
    setAgentState(overviewData.defaultAgent);
    setAgentInitialized(true);
  }, [agentInitialized, overviewData?.defaultAgent]);

  const setMode: RunPlanSelection['setMode'] = (nextMode) => {
    setModeState(nextMode);
    if (nextMode === 'goal') {
      setTemplate('');
    } else if (agent === 'dsh-headless') {
      setAgentState(overviewData?.defaultAgent ?? '');
    }
  };

  const setAgent: RunPlanSelection['setAgent'] = (nextAgent) => {
    setAgentState(nextAgent);
    if (nextAgent === 'dsh-headless') {
      setModeState('goal');
      setTemplate('');
    }
  };

  const effectiveTemplate = effectiveTemplateFor(mode, template);
  const planKey = queryKeys.workflowPlan(
    mode,
    effectiveTemplate,
    agent,
    mode === 'workflow' ? 'human-web' : undefined,
  );

  return {
    mode,
    setMode,
    template,
    setTemplate,
    agent,
    setAgent,
    workflows: workflowData?.workflows ?? [],
    effectiveTemplate,
    planKey,
  };
}
