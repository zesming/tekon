import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { rpc } from '../../lib/rpc-client.js';
import type {
  agentDiscoverySnapshotSchema,
  discoveredAgentSchema,
  linearWorkflowNodeSchema,
  linearWorkflowRecordSchema,
  roleRecordSchema,
  workbenchPreferencesSchema,
} from '../../../shared/workbench-contract.js';
import { AgentIcon, WbIcons } from './AgentIcon.js';

type DiscoveredAgent = z.infer<typeof discoveredAgentSchema>;
type AgentSnapshot = z.infer<typeof agentDiscoverySnapshotSchema>;
type RoleRecord = z.infer<typeof roleRecordSchema>;
type WorkflowRecord = z.infer<typeof linearWorkflowRecordSchema>;
type WorkflowNode = z.infer<typeof linearWorkflowNodeSchema>;
type WorkbenchPrefs = z.infer<typeof workbenchPreferencesSchema>;

export type SettingsTab = 'workflows' | 'roles' | 'agents';

function statusText(status: DiscoveredAgent['status']): string {
  if (status === 'ready') return '就绪';
  if (status === 'unauthenticated') return '未登录';
  return '未安装';
}

function getModelsForAgent(agent: DiscoveredAgent | undefined, currentModel: string): string[] {
  const list = agent?.models ? [...agent.models] : [];
  if (currentModel && !list.includes(currentModel)) {
    list.unshift(currentModel);
  }
  return list.length > 0 ? list : ['default'];
}

function getEffortsForAgent(
  agent: DiscoveredAgent | undefined,
  model: string,
  currentEffort: string,
): string[] {
  const list = agent?.modelEfforts?.[model]
    ? [...agent.modelEfforts[model]!]
    : agent?.efforts
      ? [...agent.efforts]
      : ['low', 'medium', 'high', 'max'];
  if (currentEffort && !list.includes(currentEffort)) {
    list.unshift(currentEffort);
  }
  return list;
}

interface RoleDraft {
  id: string;
  name: string;
  description: string;
  driver: string;
  model: string;
  effort: string;
  isolated: boolean;
  systemPrompt: string;
}

interface WorkflowDraft {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
}

export function SettingsView({
  tab,
  onTabChange,
  agentsSnapshot,
  roles,
  workflows,
  prefs,
  onRefreshAgents,
  onReloadCatalog,
  onUpdatePrefs,
  onNotify,
}: {
  tab: SettingsTab;
  onTabChange: (t: SettingsTab) => void;
  agentsSnapshot: AgentSnapshot | null;
  roles: RoleRecord[];
  workflows: WorkflowRecord[];
  prefs: WorkbenchPrefs;
  onRefreshAgents: () => Promise<void>;
  onReloadCatalog: () => Promise<void>;
  onUpdatePrefs: (patch: Partial<WorkbenchPrefs>) => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  const agents = agentsSnapshot?.agents ?? [];
  const agentById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const roleById = useMemo(
    () => new Map(roles.map((r) => [r.id, r])),
    [roles],
  );

  // ── Workflow editor state ──
  const [selectedWfId, setSelectedWfId] = useState<string>(workflows[0]?.id ?? '');
  const [wfDraft, setWfDraft] = useState<WorkflowDraft | null>(null);
  const [openAdvNodeIds, setOpenAdvNodeIds] = useState<Record<string, boolean>>({});
  const [savingWf, setSavingWf] = useState(false);

  // Sync selected workflow when catalog loads
  useEffect(() => {
    if (!selectedWfId && workflows[0]) {
      setSelectedWfId(workflows[0].id);
    }
  }, [workflows, selectedWfId]);

  useEffect(() => {
    const found = workflows.find((w) => w.id === selectedWfId);
    if (found) {
      setWfDraft({
        id: found.id,
        name: found.name,
        description: found.description,
        nodes: found.nodes.map((n) => ({ ...n })),
      });
    }
  }, [selectedWfId, workflows]);

  // ── Role editor drafts (preserved across width/theme toggles & refreshes) ──
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [refreshingAgents, setRefreshingAgents] = useState(false);

  useEffect(() => {
    setRoleDrafts((prev) => {
      const next: Record<string, RoleDraft> = {};
      for (const r of roles) {
        // Keep existing local draft if present so unsaved edits are never wiped
        next[r.id] = prev[r.id] ?? {
          id: r.id,
          name: r.name,
          description: r.description,
          driver: r.driver,
          model: r.model,
          effort: r.effort,
          isolated: r.isolated,
          systemPrompt: r.systemPrompt,
        };
      }
      return next;
    });
  }, [roles]);

  function patchRoleDraft(roleId: string, patch: Partial<RoleDraft>) {
    setRoleDrafts((prev) => {
      const cur = prev[roleId];
      if (!cur) return prev;
      return { ...prev, [roleId]: { ...cur, ...patch } };
    });
  }

  const readyFallbackAgent = useMemo(
    () => agents.find((a) => a.status === 'ready') ?? agents[0],
    [agents],
  );

  function handleRoleAgentChange(roleId: string, nextDriver: string) {
    const resolvedDriver = nextDriver || readyFallbackAgent?.id || '';
    const targetAgent = agentById.get(resolvedDriver);
    const nextModel = targetAgent?.models[0] ?? 'default';
    const nextEfforts =
      targetAgent?.modelEfforts?.[nextModel] ?? targetAgent?.efforts ?? ['high'];
    const nextEffort = nextEfforts.includes('high')
      ? 'high'
      : nextEfforts[0] ?? 'high';
    patchRoleDraft(roleId, {
      driver: nextDriver,
      model: nextDriver ? nextModel : '',
      effort: nextDriver ? nextEffort : '',
    });
  }

  function handleRoleModelChange(roleId: string, nextModel: string) {
    const cur = roleDrafts[roleId];
    if (!cur) return;
    const agent = agentById.get(cur.driver || readyFallbackAgent?.id || '');
    const allowed = agent?.modelEfforts?.[nextModel] ?? agent?.efforts ?? [];
    const nextEffort =
      allowed.length > 0 && !allowed.includes(cur.effort)
        ? allowed[0]!
        : cur.effort;
    patchRoleDraft(roleId, { model: nextModel, effort: nextEffort });
  }

  async function handleSaveRole(roleId: string) {
    const draft = roleDrafts[roleId];
    if (!draft) return;
    setSavingRoleId(roleId);
    try {
      const res = await rpc.call('role.save', {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        driver: draft.driver,
        model: draft.model,
        effort: draft.effort,
        isolated: draft.isolated,
        systemPrompt: draft.systemPrompt,
      });
      await onReloadCatalog();
      setRoleDrafts((prev) => ({
        ...prev,
        [roleId]: {
          id: res.role.id,
          name: res.role.name,
          description: res.role.description,
          driver: res.role.driver,
          model: res.role.model,
          effort: res.role.effort,
          isolated: res.role.isolated,
          systemPrompt: res.role.systemPrompt,
        },
      }));
      if (res.cleanedWorkflows.length > 0) {
        onNotify(
          `已保存角色「${res.role.name}」，并自动清理 ${res.cleanedWorkflows.length} 个模板中的跨 Provider 覆写`,
        );
      } else {
        onNotify(`已保存角色「${res.role.name}」`);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '保存角色失败');
    } finally {
      setSavingRoleId(null);
    }
  }

  async function handleCreateRole() {
    const readyAgent = agents.find((a) => a.status === 'ready') ?? agents[0];
    const driver = readyAgent?.id ?? 'claude-code';
    const model = readyAgent?.models[0] ?? 'sonnet';
    const effort = readyAgent?.efforts.includes('high')
      ? 'high'
      : readyAgent?.efforts[0] ?? 'high';
    const newId = `custom-role-${Date.now().toString(36).slice(-4)}`;
    try {
      await rpc.call('role.save', {
        id: newId,
        name: '自定义角色',
        description: '自定义职责与提示词',
        driver,
        model,
        effort,
        isolated: false,
        systemPrompt: '# 自定义角色\n请根据输入上下文完成本节点任务并输出结构化结论。',
      });
      await onReloadCatalog();
      onNotify(`已新建角色 ${newId}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '新建角色失败');
    }
  }

  async function handleDuplicateRole(sourceId: string) {
    try {
      const res = await rpc.call('role.duplicate', { sourceId });
      await onReloadCatalog();
      onNotify(`已复制角色「${res.role.name}」`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '复制角色失败');
    }
  }

  async function handleDeleteRole(id: string) {
    try {
      await rpc.call('role.delete', { id });
      await onReloadCatalog();
      onNotify(`已删除角色 ${id}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '删除角色失败');
    }
  }

  async function handleResetRole(id: string) {
    try {
      const res = await rpc.call('role.resetBuiltIn', { id });
      await onReloadCatalog();
      setRoleDrafts((prev) => ({
        ...prev,
        [id]: {
          id: res.role.id,
          name: res.role.name,
          description: res.role.description,
          driver: res.role.driver,
          model: res.role.model,
          effort: res.role.effort,
          isolated: res.role.isolated,
          systemPrompt: res.role.systemPrompt,
        },
      }));
      onNotify(`已恢复内置角色「${res.role.name}」默认配置`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '恢复默认失败');
    }
  }

  // ── Workflow actions ──
  function moveWfNode(idx: number, dir: -1 | 1) {
    if (!wfDraft) return;
    const target = idx + dir;
    if (target < 0 || target >= wfDraft.nodes.length) return;
    const next = [...wfDraft.nodes];
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item!);
    setWfDraft({ ...wfDraft, nodes: next });
  }

  function updateWfNode(idx: number, patch: Partial<WorkflowNode>) {
    if (!wfDraft) return;
    const next = wfDraft.nodes.map((n, i) => (i === idx ? { ...n, ...patch } : n));
    setWfDraft({ ...wfDraft, nodes: next });
  }

  function addWfNode() {
    if (!wfDraft) return;
    const defaultRole = roles[0]?.id ?? 'explorer';
    const idx = wfDraft.nodes.length + 1;
    setWfDraft({
      ...wfDraft,
      nodes: [
        ...wfDraft.nodes,
        {
          id: `step-${idx}-${Date.now().toString(36).slice(-3)}`,
          name: `步骤 ${idx}`,
          role: defaultRole,
          expectedDoc: `doc-${idx}.md`,
          contextMode: 'auto',
          confirmAfter: false,
        },
      ],
    });
  }

  function removeWfNode(idx: number) {
    if (!wfDraft || wfDraft.nodes.length <= 1) return;
    setWfDraft({
      ...wfDraft,
      nodes: wfDraft.nodes.filter((_, i) => i !== idx),
    });
  }

  async function handleSaveWorkflow() {
    if (!wfDraft) return;
    setSavingWf(true);
    try {
      await rpc.call('workflow.save', {
        id: wfDraft.id,
        name: wfDraft.name,
        description: wfDraft.description,
        nodes: wfDraft.nodes,
      });
      await onReloadCatalog();
      onNotify(`已保存模板「${wfDraft.name}」`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '保存模板失败');
    } finally {
      setSavingWf(false);
    }
  }

  async function handleCreateWorkflow() {
    const newId = `custom-wf-${Date.now().toString(36).slice(-4)}`;
    const defaultRole = roles[0]?.id ?? 'explorer';
    try {
      const res = await rpc.call('workflow.save', {
        id: newId,
        name: '自定义工作流',
        description: '线性多 Agent 协作模板',
        nodes: [
          {
            id: 'step-1',
            name: '调研分析',
            role: defaultRole,
            expectedDoc: 'research.md',
            contextMode: 'auto',
          },
        ],
      });
      await onReloadCatalog();
      setSelectedWfId(res.workflow.id);
      onNotify(`已新建模板「${res.workflow.name}」`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '新建模板失败');
    }
  }

  async function handleDuplicateWorkflow(id: string) {
    try {
      const res = await rpc.call('workflow.duplicate', { sourceId: id });
      await onReloadCatalog();
      setSelectedWfId(res.workflow.id);
      onNotify(`已复制模板「${res.workflow.name}」`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '复制模板失败');
    }
  }

  async function handleDeleteWorkflow(id: string) {
    try {
      await rpc.call('workflow.delete', { id });
      await onReloadCatalog();
      const remaining = workflows.filter((w) => w.id !== id);
      setSelectedWfId(remaining[0]?.id ?? '');
      onNotify(`已删除模板 ${id}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '删除模板失败');
    }
  }

  async function handleResetWorkflow(id: string) {
    try {
      await rpc.call('workflow.resetBuiltIn', { id });
      await onReloadCatalog();
      onNotify('已恢复内置模板默认定义');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '恢复默认失败');
    }
  }

  async function handleRefreshAgentsClick() {
    setRefreshingAgents(true);
    try {
      await onRefreshAgents();
      onNotify('已刷新本机 Agent 探测列表');
    } finally {
      setRefreshingAgents(false);
    }
  }

  const activeWfRecord = workflows.find((w) => w.id === selectedWfId) ?? null;

  return (
    <>
      <div className="wb-s-tabs" role="tablist" aria-label="设置分区">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'workflows'}
          className={`wb-s-tab ${tab === 'workflows' ? 'active' : ''}`}
          onClick={() => onTabChange('workflows')}
        >
          工作流模板
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'roles'}
          className={`wb-s-tab ${tab === 'roles' ? 'active' : ''}`}
          onClick={() => onTabChange('roles')}
        >
          角色管理
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'agents'}
          className={`wb-s-tab ${tab === 'agents' ? 'active' : ''}`}
          onClick={() => onTabChange('agents')}
        >
          Agent 与上下文
        </button>
      </div>

      <div className="wb-s-body">
        <div className="wb-s-inner">
          {/* ── Tab 1: Workflow Templates ── */}
          {tab === 'workflows' ? (
            <div className="wb-wf-grid">
              <div className="wb-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-t)' }}>
                    模板 ({workflows.length})
                  </span>
                  <button
                    type="button"
                    className="wb-btn wb-btn-xs wb-btn-primary"
                    onClick={() => void handleCreateWorkflow()}
                  >
                    {WbIcons.plus} 新建
                  </button>
                </div>
                {workflows.map((wf) => (
                  <button
                    key={wf.id}
                    type="button"
                    className={`wb-task-item ${wf.id === selectedWfId ? 'active' : ''}`}
                    onClick={() => setSelectedWfId(wf.id)}
                  >
                    <div className="wb-ti-row1">
                      <span className="wb-ti-title">{wf.name}</span>
                    </div>
                    <div className="wb-ti-row2" style={{ paddingLeft: 0 }}>
                      <span>{wf.nodes.length} 节点</span>
                      <span>{wf.builtIn ? (wf.overridden ? '内置·已改' : '内置') : '自定义'}</span>
                    </div>
                  </button>
                ))}
              </div>

              {wfDraft ? (
                <div className="wb-card" data-testid="workflow-editor">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                    <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                      {wfDraft.id}
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="wb-btn wb-btn-xs"
                        onClick={() => void handleDuplicateWorkflow(wfDraft.id)}
                      >
                        {WbIcons.copy} 复制
                      </button>
                      {activeWfRecord?.builtIn && activeWfRecord.overridden ? (
                        <button
                          type="button"
                          className="wb-btn wb-btn-xs"
                          onClick={() => void handleResetWorkflow(wfDraft.id)}
                        >
                          恢复默认
                        </button>
                      ) : null}
                      {activeWfRecord && !activeWfRecord.builtIn ? (
                        <button
                          type="button"
                          className="wb-btn wb-btn-xs"
                          onClick={() => void handleDeleteWorkflow(wfDraft.id)}
                        >
                          {WbIcons.trash} 删除
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="wb-btn wb-btn-xs wb-btn-primary"
                        disabled={savingWf}
                        onClick={() => void handleSaveWorkflow()}
                      >
                        {savingWf ? '保存中…' : '保存模板'}
                      </button>
                    </div>
                  </div>

                  <div className="wb-f-grid2">
                    <div className="wb-f-grp">
                      <label htmlFor="wf-name-input">模板名称</label>
                      <input
                        id="wf-name-input"
                        className="wb-input"
                        value={wfDraft.name}
                        onChange={(e) => setWfDraft({ ...wfDraft, name: e.target.value })}
                      />
                    </div>
                    <div className="wb-f-grp">
                      <label htmlFor="wf-desc-input">简介</label>
                      <input
                        id="wf-desc-input"
                        className="wb-input"
                        value={wfDraft.description}
                        onChange={(e) => setWfDraft({ ...wfDraft, description: e.target.value })}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 8px' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-t)' }}>
                      执行节点 ({wfDraft.nodes.length})
                    </span>
                    <button type="button" className="wb-btn wb-btn-xs" onClick={addWfNode}>
                      {WbIcons.plus} 添加节点
                    </button>
                  </div>

                  {wfDraft.nodes.map((node, idx) => {
                    const role = roleById.get(node.role);
                    const driver =
                      role?.driver || readyFallbackAgent?.id || 'claude-code';
                    const agent = agentById.get(driver);
                    const models = getModelsForAgent(agent, node.overrideModel ?? '');
                    const effModel = node.overrideModel || role?.model || models[0] || 'default';
                    const efforts = getEffortsForAgent(agent, effModel, node.overrideEffort ?? '');
                    const advOpen = Boolean(openAdvNodeIds[node.id]);

                    return (
                      <div key={node.id} className="wb-step-row">
                        <div className="wb-step-main">
                          <div className="wb-step-left" style={{ flex: 1 }}>
                            <span className="wb-step-idx">{idx + 1}</span>
                            <input
                              className="wb-input"
                              style={{ maxWidth: 160 }}
                              value={node.name}
                              aria-label={`节点 ${idx + 1} 名称`}
                              onChange={(e) => updateWfNode(idx, { name: e.target.value })}
                            />
                            <div className="wb-select-with-icon" style={{ minWidth: 135 }}>
                              <AgentIcon agentId={driver} size="sm" />
                              <select
                                className="wb-select"
                                aria-label={`节点 ${idx + 1} 角色`}
                                value={node.role}
                                onChange={(e) =>
                                  updateWfNode(idx, {
                                    role: e.target.value,
                                    overrideModel: undefined,
                                    overrideEffort: undefined,
                                  })
                                }
                              >
                                {roles.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name} ({r.id})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <input
                              className="wb-input wb-mono"
                              style={{ maxWidth: 140 }}
                              placeholder="产物文件，如 draft.md"
                              value={node.expectedDoc ?? ''}
                              aria-label={`节点 ${idx + 1} 期望文档`}
                              onChange={(e) =>
                                updateWfNode(idx, {
                                  expectedDoc: e.target.value || undefined,
                                })
                              }
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-s)', marginRight: 4, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={Boolean(node.confirmAfter)}
                                onChange={(e) =>
                                  updateWfNode(idx, { confirmAfter: e.target.checked })
                                }
                              />
                              确认点
                            </label>
                            <button
                              type="button"
                              className={`wb-icon-btn wb-icon-btn-sm ${advOpen ? 'active' : ''}`}
                              onClick={() =>
                                setOpenAdvNodeIds((prev) => ({
                                  ...prev,
                                  [node.id]: !prev[node.id],
                                }))
                              }
                              title="高级覆写（模型 / Effort / 上下文）"
                              aria-label={`节点 ${idx + 1} 高级设置`}
                            >
                              {WbIcons.sliders}
                            </button>
                            <button
                              type="button"
                              className="wb-icon-btn wb-icon-btn-sm"
                              disabled={idx === 0}
                              onClick={() => moveWfNode(idx, -1)}
                              title="上移"
                              aria-label="上移节点"
                            >
                              {WbIcons.up}
                            </button>
                            <button
                              type="button"
                              className="wb-icon-btn wb-icon-btn-sm"
                              disabled={idx === wfDraft.nodes.length - 1}
                              onClick={() => moveWfNode(idx, 1)}
                              title="下移"
                              aria-label="下移节点"
                            >
                              {WbIcons.down}
                            </button>
                            <button
                              type="button"
                              className="wb-icon-btn wb-icon-btn-sm danger"
                              disabled={wfDraft.nodes.length <= 1}
                              onClick={() => removeWfNode(idx)}
                              title="删除节点"
                              aria-label="删除节点"
                            >
                              {WbIcons.trash}
                            </button>
                          </div>
                        </div>

                        {advOpen ? (
                          <div className="wb-adv-grid">
                            <div className="wb-f-grp" style={{ marginBottom: 0 }}>
                              <label>覆写模型（默认 {role?.model ?? '-'}）</label>
                              <select
                                className="wb-select"
                                value={node.overrideModel ?? ''}
                                onChange={(e) =>
                                  updateWfNode(idx, {
                                    overrideModel: e.target.value || undefined,
                                  })
                                }
                              >
                                <option value="">跟随角色默认</option>
                                {models.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="wb-f-grp" style={{ marginBottom: 0 }}>
                              <label>覆写 Effort（默认 {role?.effort ?? '-'}）</label>
                              <select
                                className="wb-select"
                                value={node.overrideEffort ?? ''}
                                onChange={(e) =>
                                  updateWfNode(idx, {
                                    overrideEffort: e.target.value || undefined,
                                  })
                                }
                              >
                                <option value="">跟随角色默认</option>
                                {efforts.map((ef) => (
                                  <option key={ef} value={ef}>
                                    {ef}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="wb-f-grp" style={{ marginBottom: 0 }}>
                              <label>上下文策略</label>
                              <select
                                className="wb-select"
                                value={node.contextMode ?? 'auto'}
                                onChange={(e) =>
                                  updateWfNode(idx, {
                                    contextMode: e.target.value as WorkflowNode['contextMode'],
                                  })
                                }
                              >
                                <option value="auto">auto（自动）</option>
                                <option value="reuse">reuse（同角色续接）</option>
                                <option value="isolated">isolated（独立隔离）</option>
                                <option value="full">full（全量固化文档）</option>
                              </select>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Tab 2: Roles ── */}
          {tab === 'roles' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: 'var(--text-t)' }}>
                  本机 Agent 探测时间：{agentsSnapshot?.probedAt ? new Date(agentsSnapshot.probedAt).toLocaleTimeString() : '—'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="wb-btn wb-btn-xs"
                    disabled={refreshingAgents}
                    onClick={() => void handleRefreshAgentsClick()}
                  >
                    {WbIcons.reuse} {refreshingAgents ? '探测中…' : '刷新 Agent'}
                  </button>
                  <button
                    type="button"
                    className="wb-btn wb-btn-xs wb-btn-primary"
                    onClick={() => void handleCreateRole()}
                  >
                    {WbIcons.plus} 新建角色
                  </button>
                </div>
              </div>

              <div className="wb-role-grid">
                {roles.map((r) => {
                  const draft = roleDrafts[r.id] ?? r;
                  const effectiveDriver = draft.driver || readyFallbackAgent?.id || '';
                  const selectedAgent = agentById.get(effectiveDriver);
                  const agentExists = !draft.driver || Boolean(agentById.get(draft.driver));
                  const modelOptions = getModelsForAgent(selectedAgent, draft.model);
                  const effortOptions = getEffortsForAgent(
                    selectedAgent,
                    draft.model,
                    draft.effort,
                  );
                  return (
                    <div key={r.id} className="wb-card" data-testid={`role-card-${r.id}`}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <AgentIcon agentId={effectiveDriver} size="md" />
                          <strong style={{ fontSize: 13.5 }}>{draft.name}</strong>
                          <span className="wb-tb-tag">{r.id}</span>
                        </div>
                        <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                          {r.builtIn ? (r.overridden ? '内置·已改' : '内置') : '自定义'}
                        </span>
                      </div>

                      <div className="wb-f-grp">
                        <label htmlFor={`role-name-${r.id}`}>名称</label>
                        <input
                          id={`role-name-${r.id}`}
                          className="wb-input"
                          value={draft.name}
                          onChange={(e) => patchRoleDraft(r.id, { name: e.target.value })}
                        />
                      </div>

                      <div className="wb-f-grp">
                        <label htmlFor={`role-agent-${r.id}`}>Agent</label>
                        <div className="wb-select-with-icon">
                          <AgentIcon agentId={effectiveDriver} size="md" />
                          <select
                            id={`role-agent-${r.id}`}
                            className="wb-select"
                            value={draft.driver}
                            onChange={(e) => handleRoleAgentChange(r.id, e.target.value)}
                          >
                            <option value="">自动（首个就绪本机 Agent）</option>
                            {!agentExists ? (
                              <option value={draft.driver}>
                                {draft.driver}（当前值·本机未检测到）
                              </option>
                            ) : null}
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}（{statusText(a.status)}）
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="wb-f-grid2">
                        <div className="wb-f-grp">
                          <label htmlFor={`role-model-${r.id}`}>模型</label>
                          <select
                            id={`role-model-${r.id}`}
                            className="wb-select"
                            value={draft.model}
                            onChange={(e) => handleRoleModelChange(r.id, e.target.value)}
                          >
                            {modelOptions.map((m) => (
                              <option key={m} value={m}>
                                {m}
                                {selectedAgent && !selectedAgent.models.includes(m)
                                  ? '（当前值）'
                                  : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="wb-f-grp">
                          <label htmlFor={`role-effort-${r.id}`}>Effort</label>
                          <select
                            id={`role-effort-${r.id}`}
                            className="wb-select"
                            value={draft.effort}
                            onChange={(e) => patchRoleDraft(r.id, { effort: e.target.value })}
                          >
                            {effortOptions.map((ef) => (
                              <option key={ef} value={ef}>
                                {ef}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="wb-f-grp">
                        <label htmlFor={`role-prompt-${r.id}`}>角色 Prompt</label>
                        <textarea
                          id={`role-prompt-${r.id}`}
                          className="wb-textarea"
                          value={draft.systemPrompt}
                          onChange={(e) =>
                            patchRoleDraft(r.id, { systemPrompt: e.target.value })
                          }
                        />
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-s)', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={draft.isolated}
                            onChange={(e) =>
                              patchRoleDraft(r.id, { isolated: e.target.checked })
                            }
                          />
                          独立会话隔离
                        </label>
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button
                            type="button"
                            className="wb-btn wb-btn-xs"
                            onClick={() => void handleDuplicateRole(r.id)}
                          >
                            复制
                          </button>
                          {r.builtIn && r.overridden ? (
                            <button
                              type="button"
                              className="wb-btn wb-btn-xs"
                              onClick={() => void handleResetRole(r.id)}
                            >
                              恢复默认
                            </button>
                          ) : null}
                          {!r.builtIn ? (
                            <button
                              type="button"
                              className="wb-btn wb-btn-xs"
                              onClick={() => void handleDeleteRole(r.id)}
                            >
                              删除
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="wb-btn wb-btn-xs wb-btn-primary"
                            disabled={savingRoleId === r.id}
                            onClick={() => void handleSaveRole(r.id)}
                          >
                            {savingRoleId === r.id ? '保存中…' : '保存'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* ── Tab 3: Agents & Context Preferences ── */}
          {tab === 'agents' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="wb-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ fontSize: 13.5 }}>本机已探测 Agent</strong>
                    <span className="wb-mono" style={{ marginLeft: 8, color: 'var(--text-t)' }}>
                      {agentsSnapshot?.probedAt ? new Date(agentsSnapshot.probedAt).toLocaleTimeString() : '—'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="wb-btn wb-btn-xs"
                    disabled={refreshingAgents}
                    onClick={() => void handleRefreshAgentsClick()}
                  >
                    {WbIcons.reuse} {refreshingAgents ? '探测中…' : '重新探测'}
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {agents.map((a) => (
                    <div key={a.id} className="wb-step-row" style={{ marginBottom: 0 }}>
                      <div className="wb-step-main">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <AgentIcon agentId={a.id} size="lg" />
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <strong style={{ fontSize: 13 }}>{a.name}</strong>
                              <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                                {a.id}
                              </span>
                              <span
                                className="wb-tb-status"
                                style={{
                                  color:
                                    a.status === 'ready'
                                      ? 'var(--pass-t)'
                                      : a.status === 'unauthenticated'
                                        ? 'var(--pend-t)'
                                        : 'var(--text-t)',
                                }}
                              >
                                <span
                                  className={`wb-s-dot ${
                                    a.status === 'ready'
                                      ? 'done'
                                      : a.status === 'unauthenticated'
                                        ? 'confirm'
                                        : 'cancelled'
                                  }`}
                                />
                                {statusText(a.status)}
                              </span>
                            </div>
                            <div className="wb-mono" style={{ color: 'var(--text-t)', marginTop: 2 }}>
                              模型：{a.models.join(', ')}
                              {a.version ? ` · ${a.version}` : ''}
                            </div>
                          </div>
                        </div>
                        {a.status === 'unauthenticated' && a.loginHint ? (
                          <span className="wb-tb-tag wb-mono">{a.loginHint}</span>
                        ) : a.status === 'not_installed' && a.installHint ? (
                          <span className="wb-tb-tag wb-mono">{a.installHint}</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="wb-card">
                <strong style={{ fontSize: 13.5, display: 'block', marginBottom: 12 }}>
                  上下文与界面偏好
                </strong>
                <div className="wb-f-grid2">
                  <div className="wb-f-grp">
                    <label htmlFor="pref-orch">动态编排默认角色</label>
                    <select
                      id="pref-orch"
                      className="wb-select"
                      value={prefs.defaultOrchestrator}
                      onChange={(e) =>
                        void onUpdatePrefs({ defaultOrchestrator: e.target.value })
                      }
                    >
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="wb-f-grp">
                    <label htmlFor="pref-compact">自动压缩阈值</label>
                    <select
                      id="pref-compact"
                      className="wb-select"
                      value={prefs.compactThreshold}
                      onChange={(e) =>
                        void onUpdatePrefs({
                          compactThreshold: e.target.value as WorkbenchPrefs['compactThreshold'],
                        })
                      }
                    >
                      <option value="75">75%</option>
                      <option value="85">85%</option>
                      <option value="manual">仅手动压缩</option>
                    </select>
                  </div>

                  <div className="wb-f-grp">
                    <label htmlFor="pref-rail">进度栏位置</label>
                    <select
                      id="pref-rail"
                      className="wb-select"
                      value={prefs.railMode}
                      onChange={(e) =>
                        void onUpdatePrefs({
                          railMode: e.target.value as WorkbenchPrefs['railMode'],
                        })
                      }
                    >
                      <option value="top">顶部点线（默认）</option>
                      <option value="right">右侧竖向进度轨</option>
                    </select>
                  </div>

                  <div className="wb-f-grp">
                    <label htmlFor="pref-theme">外观主题</label>
                    <select
                      id="pref-theme"
                      className="wb-select"
                      value={prefs.theme}
                      onChange={(e) =>
                        void onUpdatePrefs({
                          theme: e.target.value as WorkbenchPrefs['theme'],
                        })
                      }
                    >
                      <option value="light">浅色模式</option>
                      <option value="dark">深色模式</option>
                    </select>
                  </div>
                </div>

                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-s)', cursor: 'pointer', marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={prefs.autoArchiveLogs}
                    onChange={(e) =>
                      void onUpdatePrefs({ autoArchiveLogs: e.target.checked })
                    }
                  />
                  节点完成后自动归档私有推理日志
                </label>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
