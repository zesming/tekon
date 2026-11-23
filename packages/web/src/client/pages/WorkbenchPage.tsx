import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import { useAuth } from '../context/auth-context.js';
import { rpc } from '../lib/rpc-client.js';
import { openSessionStream } from '../lib/session-stream.js';
import type {
  agentDiscoverySnapshotSchema,
  discoveredAgentSchema,
  dynamicBlueprintNodeRpcSchema,
  linearWorkflowRecordSchema,
  roleRecordSchema,
  taskDetailViewSchema,
  taskListItemSchema,
  taskNodeViewSchema,
  workbenchPreferencesSchema,
} from '../../shared/workbench-contract.js';
import { AgentIcon, WbIcons, roleColor } from '../components/workbench/AgentIcon.js';
import { InspectorDrawer } from '../components/workbench/InspectorDrawer.js';
import {
  RightVerticalRail,
  TopDotLineRail,
  type RailStepItem,
} from '../components/workbench/ProgressRail.js';
import { SettingsView, type SettingsTab } from '../components/workbench/SettingsView.js';
import { WidthMenu, type ContentWidthPreset } from '../components/workbench/WidthMenu.js';

type AgentSnapshot = z.infer<typeof agentDiscoverySnapshotSchema>;
type DiscoveredAgent = z.infer<typeof discoveredAgentSchema>;
type RoleRecord = z.infer<typeof roleRecordSchema>;
type WorkflowRecord = z.infer<typeof linearWorkflowRecordSchema>;
type TaskListItem = z.infer<typeof taskListItemSchema>;
type TaskDetail = z.infer<typeof taskDetailViewSchema>;
type TaskNodeView = z.infer<typeof taskNodeViewSchema>;
type WorkbenchPrefs = z.infer<typeof workbenchPreferencesSchema>;
type BlueprintNode = z.infer<typeof dynamicBlueprintNodeRpcSchema> & { id: string };

const DEFAULT_PREFS: WorkbenchPrefs = {
  defaultOrchestrator: 'orchestrator',
  compactThreshold: '75',
  autoArchiveLogs: true,
  theme: 'light',
  contentWidth: 'normal',
  railMode: 'top',
};

const STORAGE_THEME_KEY = 'tekon.workbench.theme';
const STORAGE_WIDTH_KEY = 'tekon.workbench.width';
const STORAGE_RAIL_KEY = 'tekon.workbench.rail';

function readInitialTheme(): 'light' | 'dark' {
  try {
    const v = localStorage.getItem(STORAGE_THEME_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // ignore storage errors
  }
  return 'light';
}

function readInitialWidth(): ContentWidthPreset {
  try {
    const v = localStorage.getItem(STORAGE_WIDTH_KEY);
    if (v === 'normal' || v === 'wide' || v === 'full') return v;
  } catch {
    // ignore
  }
  return 'normal';
}

function readInitialRail(): 'top' | 'right' {
  try {
    const v = localStorage.getItem(STORAGE_RAIL_KEY);
    if (v === 'top' || v === 'right') return v;
  } catch {
    // ignore
  }
  return 'top';
}

function mapNodeToRailState(
  node: TaskNodeView,
  task: TaskDetail,
): RailStepItem['state'] {
  if (
    task.status === 'paused' &&
    task.pauseReason === 'confirm_checkpoint' &&
    task.currentNodeId === node.id
  ) {
    return 'confirm';
  }
  if (
    task.status === 'paused' &&
    task.pauseReason === 'user_pause' &&
    task.currentNodeId === node.id
  ) {
    return 'paused';
  }
  if (node.status === 'passed') return 'passed';
  if (node.status === 'failed') return 'failed';
  if (node.status === 'cancelled' || node.status === 'interrupted') return 'cancelled';
  if (node.status === 'running') return 'running';
  return 'pending';
}

function isExecutableAgent(agent: DiscoveredAgent | undefined): boolean {
  return Boolean(agent && agent.status === 'ready' && agent.executable !== false);
}

function statusDotClass(task: TaskListItem | TaskDetail): string {
  if (task.status === 'passed') return 'done';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'failed' || task.blueprintStatus === 'failed') return 'failed';
  if (task.status === 'paused' && task.pauseReason === 'confirm_checkpoint') return 'confirm';
  if (task.status === 'paused' && task.pauseReason === 'blueprint_review') return 'confirm';
  if (task.status === 'paused') return 'paused';
  return 'running';
}

function statusLabel(task: TaskDetail): string {
  if (task.status === 'cancelled') return '已终止';
  if (task.status === 'passed') return '已完成';
  if (task.status === 'running' && task.blueprintStatus === 'planning') return '规划中';
  if (task.status === 'paused' && task.pauseReason === 'blueprint_review' && task.blueprintStatus === 'review') {
    return '待确认计划';
  }
  if (task.blueprintStatus === 'failed') return '规划失败';
  if (task.status === 'failed') return '失败';
  if (task.status === 'paused' && task.pauseReason === 'confirm_checkpoint') return '待确认';
  if (task.status === 'paused') return '已暂停';
  return '运行中';
}

export function WorkbenchPage() {
  const { runId: routeRunId, tab: routeSettingsTab } = useParams<{
    runId?: string;
    tab?: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { token } = useAuth();

  const isSettingsRoute = location.pathname.startsWith('/settings');
  const settingsTab: SettingsTab =
    routeSettingsTab === 'roles' || routeSettingsTab === 'agents'
      ? routeSettingsTab
      : 'workflows';

  // ── Viewport & Preferences ──
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 900 : false,
  );
  const [prefs, setPrefs] = useState<WorkbenchPrefs>(() => ({
    ...DEFAULT_PREFS,
    theme: readInitialTheme(),
    contentWidth: readInitialWidth(),
    railMode: readInitialRail(),
  }));
  const [workspace, setWorkspace] = useState<{ name: string; path: string }>({
    name: 'workspace',
    path: '',
  });

  // ── Catalog & Tasks ──
  const [agentsSnapshot, setAgentsSnapshot] = useState<AgentSnapshot | null>(null);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [taskFilter, setTaskFilter] = useState<'all' | 'running' | 'attention' | 'done'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTask, setActiveTask] = useState<TaskDetail | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [taskLoadError, setTaskLoadError] = useState<string | null>(null);
  const [liveTraceByNode, setLiveTraceByNode] = useState<Record<string, string[]>>({});
  const routeRunIdRef = useRef<string | null>(routeRunId ?? null);
  routeRunIdRef.current = routeRunId ?? null;
  const activeTaskRef = useRef<TaskDetail | null>(activeTask);
  activeTaskRef.current = activeTask;

  // Only expose detail & actions when loaded task strictly matches current route runId
  const currentTask =
    routeRunId && activeTask && activeTask.runId === routeRunId
      ? activeTask
      : null;

  // ── UI Overlays & Drawers ──
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'docs' | 'ctx' | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedCtxNodeId, setSelectedCtxNodeId] = useState<string | null>(null);
  const [topRailExpanded, setTopRailExpanded] = useState(false);
  const [rightRailSlim, setRightRailSlim] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── New Task Hero Composer State ──
  const [heroPrompt, setHeroPrompt] = useState('');
  const [heroSelection, setHeroSelection] = useState<string>('deep-research');
  const [heroAttachments, setHeroAttachments] = useState<
    Array<{ name: string; content: string; sizeBytes: number }>
  >([]);
  const [creatingTask, setCreatingTask] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── In-Task Composer / Rework / Retry / Blueprint Draft State ──
  const [composerText, setComposerText] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [followUpRoleId, setFollowUpRoleId] = useState<string>('');
  const [sendingComposer, setSendingComposer] = useState(false);
  const [reworkOpenNodeId, setReworkOpenNodeId] = useState<string | null>(null);
  const [reworkTargetId, setReworkTargetId] = useState<string>('');
  const [reworkNote, setReworkNote] = useState('');
  const [retryOverrides, setRetryOverrides] = useState<
    Record<string, { driver: string; model: string; effort: string }>
  >({});
  const [bpDraft, setBpDraft] = useState<BlueprintNode[] | null>(null);
  const [bpReplanHint, setBpReplanHint] = useState('');
  const [bpSaveName, setBpSaveName] = useState('');
  const [bpSaveOpen, setBpSaveOpen] = useState(false);
  const [busyControl, setBusyControl] = useState(false);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Apply theme to documentElement
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    try {
      localStorage.setItem(STORAGE_THEME_KEY, prefs.theme);
      localStorage.setItem(STORAGE_WIDTH_KEY, prefs.contentWidth);
      localStorage.setItem(STORAGE_RAIL_KEY, prefs.railMode);
    } catch {
      // ignore
    }
  }, [prefs.theme, prefs.contentWidth, prefs.railMode]);

  // Listen to viewport resize for <= 900px responsive rules
  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth <= 900;
      setIsNarrow(narrow);
      if (!narrow) setSidebarOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Esc key hierarchical close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (cancelConfirmOpen) {
        setCancelConfirmOpen(false);
        return;
      }
      if (drawerTab !== null) {
        setDrawerTab(null);
        return;
      }
      if (sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelConfirmOpen, drawerTab, sidebarOpen]);

  // ── Data Loaders ──
  const loadCatalog = useCallback(async () => {
    try {
      const [prefRes, agentRes, roleRes, wfRes] = await Promise.all([
        rpc.call('prefs.get'),
        rpc.call('agent.list'),
        rpc.call('role.listDetailed', {}),
        rpc.call('workflow.listDetailed', {}),
      ]);
      setWorkspace(prefRes.workspace);
      setPrefs(prefRes.prefs);
      setAgentsSnapshot(agentRes);
      setRoles(roleRes.roles);
      setWorkflows(wfRes.workflows);
      setHeroSelection((prev) => {
        if (prev === '__dynamic__') return prev;
        if (wfRes.workflows.some((w) => w.id === prev)) return prev;
        return wfRes.workflows[0]?.id ?? '__dynamic__';
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : '加载配置失败');
    }
  }, [notify]);

  const refreshTaskList = useCallback(async () => {
    try {
      const res = await rpc.call('task.list', {
        filter: taskFilter,
        q: searchQuery.trim() || undefined,
      });
      setWorkspace(res.workspace);
      setTasks(res.tasks);
    } catch {
      // keep existing list
    }
  }, [taskFilter, searchQuery]);

  const activeTaskReqSeqRef = useRef(0);
  const refreshActiveTask = useCallback(async (runId: string) => {
    const seq = ++activeTaskReqSeqRef.current;
    try {
      const res = await rpc.call('task.get', { runId });
      if (seq !== activeTaskReqSeqRef.current || routeRunIdRef.current !== runId) {
        return;
      }
      setTaskLoadError(null);
      setLoadingTask(false);
      setActiveTask(res.task);
      setFollowUpRoleId((prev) => prev || res.task.lastRoleId || res.task.nodes[res.task.nodes.length - 1]?.role || '');
      if (res.task.blueprint?.nodes) {
        setBpDraft((prev) => {
          if (
            prev &&
            prev.length > 0 &&
            res.task.status === 'paused' &&
            res.task.pauseReason === 'blueprint_review' &&
            res.task.blueprintStatus === 'review'
          ) {
            return prev;
          }
          return res.task.blueprint!.nodes.map((n) => ({ ...n }));
        });
      }
    } catch (err) {
      if (seq === activeTaskReqSeqRef.current && routeRunIdRef.current === runId) {
        const msg = err instanceof Error ? err.message : '加载任务详情失败';
        setLoadingTask(false);
        setActiveTask((prev) => (prev?.runId === runId ? prev : null));
        setTaskLoadError(msg);
        notify(msg);
      }
    }
  }, [notify]);

  const refreshTaskListRef = useRef(refreshTaskList);
  refreshTaskListRef.current = refreshTaskList;
  const refreshActiveTaskRef = useRef(refreshActiveTask);
  refreshActiveTaskRef.current = refreshActiveTask;

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, token]);

  useEffect(() => {
    void refreshTaskList();
  }, [refreshTaskList, token]);

  useEffect(() => {
    activeTaskReqSeqRef.current += 1;
    setCancelConfirmOpen(false);
    setReworkOpenNodeId(null);
    setReworkNote('');
    setLiveTraceByNode({});
    setBpDraft(null);
    setBpSaveOpen(false);
    setBpReplanHint('');
    setBpSaveName('');
    setFollowUpRoleId('');
    setComposerText('');
    setComposerError(null);
    setSelectedDocId(null);
    setSelectedCtxNodeId(null);
    setRetryOverrides({});
    setTaskLoadError(null);
    if (!routeRunId) {
      setLoadingTask(false);
      setActiveTask(null);
      setDrawerTab(null);
      return;
    }
    if (activeTaskRef.current?.runId !== routeRunId) {
      setActiveTask(null);
      setLoadingTask(true);
    }
    void refreshActiveTask(routeRunId);
  }, [routeRunId, refreshActiveTask]);

  // Keep retry override defaults synchronized with failed nodes
  useEffect(() => {
    if (!currentTask) return;
    setRetryOverrides((prev) => {
      const next = { ...prev };
      for (const n of currentTask.nodes) {
        if (n.status === 'failed' && !next[n.id]) {
          next[n.id] = {
            driver: n.driver,
            model: n.model,
            effort: n.effort,
          };
        }
      }
      return next;
    });
  }, [currentTask]);

  // Live SSE + safety polling strictly while task is actively running/pending
  const isTaskActive =
    Boolean(currentTask) &&
    (currentTask!.status === 'running' || currentTask!.status === 'pending');

  useEffect(() => {
    if (!currentTask?.runId || !currentTask.sessionId || !isTaskActive) return;
    const runId = currentTask.runId;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (routeRunIdRef.current === runId) {
          void refreshActiveTaskRef.current(runId);
        }
        void refreshTaskListRef.current();
      }, 120);
    };

    const stream = openSessionStream({
      sessionId: currentTask.sessionId,
      token,
      onEvent(ev) {
        if (routeRunIdRef.current !== runId) return;
        const payload = (ev as unknown as { payload?: Record<string, unknown> }).payload;
        if (ev.type === 'node/progress' && payload) {
          const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : '';
          const text =
            typeof payload.line === 'string'
              ? payload.line
              : typeof payload.text === 'string'
                ? payload.text
                : '';
          if (nodeId && text) {
            setLiveTraceByNode((prev) => {
              const cur = prev[nodeId] ?? [];
              if (cur[cur.length - 1] === text) return prev;
              return { ...prev, [nodeId]: [...cur.slice(-39), text] };
            });
          }
          return;
        }
        if (
          ev.type.startsWith('node/') ||
          ev.type.startsWith('workflow/') ||
          ev.type.startsWith('artifact/') ||
          ev.type.startsWith('doc/') ||
          ev.type.startsWith('checkpoint/') ||
          ev.type.startsWith('blueprint/') ||
          ev.type.startsWith('context/') ||
          ev.type.startsWith('followup/')
        ) {
          scheduleRefresh();
        }
      },
      onTruncated() {
        scheduleRefresh();
      },
      onStateChange() {
        // non-blocking
      },
    });
    const timer = setInterval(() => {
      if (routeRunIdRef.current === runId) {
        void refreshActiveTaskRef.current(runId);
      }
      void refreshTaskListRef.current();
    }, 1500);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      stream.close();
      clearInterval(timer);
    };
  }, [currentTask?.runId, currentTask?.sessionId, isTaskActive, token]);

  // ── Preference Mutators ──
  const handleUpdatePrefs = useCallback(
    async (patch: Partial<WorkbenchPrefs>) => {
      // Optimistically update local state so form drafts & width/theme switch instantly
      setPrefs((prev) => ({ ...prev, ...patch }));
      try {
        const res = await rpc.call('prefs.update', patch);
        setPrefs(res.prefs);
      } catch (err) {
        notify(err instanceof Error ? err.message : '保存偏好失败');
      }
    },
    [notify],
  );

  const handleRefreshAgents = useCallback(async () => {
    const res = await rpc.call('agent.refresh');
    setAgentsSnapshot(res);
  }, []);

  // ── Narrow Drawer Mutual Exclusion Helpers ──
  function toggleSidebar() {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (next && isNarrow) setDrawerTab(null);
      return next;
    });
  }

  function openInspector(tab: 'docs' | 'ctx', opts?: { docId?: string; nodeId?: string }) {
    if (opts?.docId) setSelectedDocId(opts.docId);
    if (opts?.nodeId) setSelectedCtxNodeId(opts.nodeId);
    if (isNarrow) setSidebarOpen(false);
    setDrawerTab((prev) => (prev === tab && !opts?.docId && !opts?.nodeId ? null : tab));
  }

  // ── Preflight Check for Hero Composer ──
  const agentMap = useMemo(
    () => new Map((agentsSnapshot?.agents ?? []).map((a) => [a.id, a])),
    [agentsSnapshot],
  );
  const roleMap = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  const preflightBlockers = useMemo(() => {
    if (!agentsSnapshot) return [];
    const readyAgent = agentsSnapshot.agents.find((a) => isExecutableAgent(a));
    const neededRoleIds = new Set<string>();
    if (heroSelection === '__dynamic__') {
      neededRoleIds.add(prefs.defaultOrchestrator || 'orchestrator');
    } else {
      const wf = workflows.find((w) => w.id === heroSelection);
      if (wf) {
        for (const n of wf.nodes) neededRoleIds.add(n.role);
      }
    }
    const blockers: Array<{ roleId: string; driver: string; status: DiscoveredAgent['status']; hint?: string }> = [];
    for (const rid of neededRoleIds) {
      const role = roleMap.get(rid);
      if (!role) continue;
      const effectiveDriver =
        role.driver.trim() ||
        readyAgent?.id ||
        agentsSnapshot.agents[0]?.id ||
        'claude-code';
      const ag = agentMap.get(effectiveDriver);
      if (!isExecutableAgent(ag)) {
        blockers.push({
          roleId: rid,
          driver: effectiveDriver,
          status: ag?.status ?? 'not_installed',
          hint:
            ag?.status === 'unauthenticated'
              ? ag.loginHint
              : ag?.status === 'unsupported'
                ? ag.unsupportedHint
                : ag?.installHint,
        });
      }
    }
    return blockers;
  }, [agentsSnapshot, heroSelection, workflows, prefs.defaultOrchestrator, roleMap, agentMap]);

  // ── Hero Attachment Upload ──
  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const next = [...heroAttachments];
    for (const file of files) {
      if (next.length >= 5) {
        notify('最多支持上传 5 个参考附件');
        break;
      }
      if (file.size > 256 * 1024) {
        notify(`附件 ${file.name} 超过 256KB 限制`);
        continue;
      }
      const content = await file.text();
      next.push({ name: file.name, content, sizeBytes: file.size });
    }
    setHeroAttachments(next);
  }

  // ── Create Task ──
  async function handleCreateTask() {
    const prompt = heroPrompt.trim();
    if (!prompt || creatingTask) return;
    if (preflightBlockers.length > 0) {
      notify(`存在未就绪 Agent：${preflightBlockers.map((b) => b.driver).join(', ')}`);
      return;
    }
    setCreatingTask(true);
    try {
      const mode = heroSelection === '__dynamic__' ? 'dynamic' : 'static';
      const res = await rpc.call('task.create', {
        mode,
        templateId: mode === 'static' ? heroSelection : undefined,
        prompt,
        attachments: heroAttachments.map((a) => ({ name: a.name, content: a.content })),
      });
      setHeroPrompt('');
      setHeroAttachments([]);
      setActiveTask(res.task);
      await refreshTaskList();
      navigate(`/tasks/${res.runId}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : '发起任务失败');
    } finally {
      setCreatingTask(false);
    }
  }

  function handleHeroKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleCreateTask();
    }
  }

  // ── Task Controls (strictly bound to currentTask matching routeRunId) ──
  async function handlePause() {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.pause', { runId: targetRunId });
      if (routeRunIdRef.current === targetRunId) setActiveTask(res.task);
      await refreshTaskList();
      notify('已暂停任务');
    } catch (err) {
      notify(err instanceof Error ? err.message : '暂停失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleResume() {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.resume', { runId: targetRunId });
      if (routeRunIdRef.current === targetRunId) setActiveTask(res.task);
      await refreshTaskList();
      notify('已恢复任务执行');
    } catch (err) {
      notify(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleConfirmCancel() {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.cancel', { runId: targetRunId });
      if (routeRunIdRef.current === targetRunId) {
        setActiveTask(res.task);
        setCancelConfirmOpen(false);
      }
      await refreshTaskList();
      notify('任务已终止');
    } catch (err) {
      notify(err instanceof Error ? err.message : '终止失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleApproveCheckpoint() {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.approveCheckpoint', { runId: targetRunId });
      if (routeRunIdRef.current === targetRunId) {
        setActiveTask(res.task);
        setReworkOpenNodeId(null);
      }
      await refreshTaskList();
      notify('已确认，继续下一节点');
    } catch (err) {
      notify(err instanceof Error ? err.message : '确认失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleReworkSubmit() {
    if (!currentTask || !reworkTargetId || !reworkNote.trim() || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.reworkFromNode', {
        runId: targetRunId,
        targetNodeId: reworkTargetId,
        note: reworkNote.trim(),
      });
      if (routeRunIdRef.current === targetRunId) {
        setActiveTask(res.task);
        setReworkOpenNodeId(null);
        setReworkNote('');
      }
      await refreshTaskList();
      notify('已提交返工并重跑目标节点');
    } catch (err) {
      notify(err instanceof Error ? err.message : '返工失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleRetryNode(nodeId: string) {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const ov = retryOverrides[nodeId];
      const res = await rpc.call('task.retryNode', {
        runId: targetRunId,
        nodeId,
        override: ov,
      });
      if (routeRunIdRef.current === targetRunId) setActiveTask(res.task);
      await refreshTaskList();
      notify('已重跑失败节点');
    } catch (err) {
      notify(err instanceof Error ? err.message : '重试失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handlePromoteHandoff(nodeId: string) {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('doc.promoteFromHandoff', {
        runId: targetRunId,
        nodeId,
      });
      if (routeRunIdRef.current === targetRunId) {
        await refreshActiveTask(targetRunId);
        openInspector('docs', { docId: res.document.id });
      }
      notify(`已将节点结论提升为固化文档「${res.document.title}」`);
    } catch (err) {
      notify(err instanceof Error ? err.message : '固化失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleTaskComposerSend() {
    if (!currentTask || !composerText.trim() || sendingComposer) return;
    const targetRunId = currentTask.runId;
    const isFollowUp = currentTask.status === 'passed';
    const textToSend = composerText.trim();
    setSendingComposer(true);
    setComposerError(null);
    try {
      if (isFollowUp) {
        const res = await rpc.call('task.followUp', {
          runId: targetRunId,
          roleId: followUpRoleId || undefined,
          prompt: textToSend,
        });
        if (routeRunIdRef.current === targetRunId) {
          setActiveTask(res.task);
          setComposerText('');
        }
      } else {
        const res = await rpc.call('task.appendConstraint', {
          runId: targetRunId,
          text: textToSend,
        });
        if (routeRunIdRef.current === targetRunId) {
          setActiveTask(res.task);
          setComposerText('');
        }
        notify('约束已加入队列，将在下一节点自动注入');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发送失败';
      if (routeRunIdRef.current === targetRunId) {
        setComposerError(msg);
      }
      notify(msg);
    } finally {
      setSendingComposer(false);
    }
  }

  // ── Dynamic Blueprint Actions ──
  async function handleConfirmBlueprint() {
    if (!currentTask || !bpDraft || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      await rpc.call('task.updateBlueprint', {
        runId: targetRunId,
        nodes: bpDraft,
      });
      const res = await rpc.call('task.confirmBlueprint', { runId: targetRunId });
      if (routeRunIdRef.current === targetRunId) setActiveTask(res.task);
      await refreshTaskList();
      notify('已确认计划，开始执行');
    } catch (err) {
      notify(err instanceof Error ? err.message : '确认计划失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleReplanBlueprint() {
    if (!currentTask || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.replanBlueprint', {
        runId: targetRunId,
        instruction: bpReplanHint.trim() || undefined,
      });
      if (routeRunIdRef.current === targetRunId) {
        setActiveTask(res.task);
        setBpDraft(res.task.blueprint?.nodes?.map((n) => ({ ...n })) ?? null);
        setBpReplanHint('');
      }
      notify('已重新生成计划');
    } catch (err) {
      notify(err instanceof Error ? err.message : '重新规划失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleSaveBlueprintAsTemplate() {
    if (!currentTask || !bpSaveName.trim() || busyControl) return;
    const targetRunId = currentTask.runId;
    setBusyControl(true);
    try {
      if (
        bpDraft &&
        bpDraft.length > 0 &&
        currentTask.status === 'paused' &&
        currentTask.pauseReason === 'blueprint_review'
      ) {
        await rpc.call('task.updateBlueprint', {
          runId: targetRunId,
          nodes: bpDraft,
        });
      }
      const res = await rpc.call('task.saveAsTemplate', {
        runId: targetRunId,
        name: bpSaveName.trim(),
      });
      if (routeRunIdRef.current === targetRunId) {
        setBpSaveOpen(false);
        setBpSaveName('');
      }
      await loadCatalog();
      notify(`已另存为模板「${res.name}」`);
    } catch (err) {
      notify(err instanceof Error ? err.message : '另存为模板失败');
    } finally {
      setBusyControl(false);
    }
  }

  async function handleFallbackStaticFromFailedPlan(templateId: string) {
    if (!currentTask || busyControl) return;
    setBusyControl(true);
    try {
      const res = await rpc.call('task.create', {
        mode: 'static',
        templateId,
        prompt: currentTask.prompt,
      });
      setActiveTask(res.task);
      await refreshTaskList();
      navigate(`/tasks/${res.runId}`);
      notify('已切换为静态模板重新启动任务');
    } catch (err) {
      notify(err instanceof Error ? err.message : '切换失败');
    } finally {
      setBusyControl(false);
    }
  }

  // ── Derived View Data ──
  const attentionCount = tasks.filter((t) => t.uiCategory === 'attention').length;
  const effectiveRailMode = isNarrow ? 'top' : prefs.railMode;

  const railSteps: RailStepItem[] = useMemo(() => {
    if (!currentTask) return [];
    return currentTask.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      driver: n.driver,
      model: n.model,
      effort: n.effort,
      state: mapNodeToRailState(n, currentTask),
      durationSec: n.durationMs ? `${(n.durationMs / 1000).toFixed(1)}s` : undefined,
      reuseAnchorOrder: n.reuseAnchorOrder,
    }));
  }, [currentTask]);

  function scrollToNode(nodeId: string) {
    const el = document.getElementById(`wb-node-${nodeId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const showBackdrop = isNarrow && (sidebarOpen || drawerTab !== null);

  return (
    <div
      className="wb-app"
      data-width={prefs.contentWidth}
      data-theme={prefs.theme}
    >
      {/* Narrow backdrop */}
      <div
        className={`wb-backdrop ${showBackdrop ? 'open' : ''}`}
        onClick={() => {
          setSidebarOpen(false);
          setDrawerTab(null);
        }}
      />

      {/* ── Left Sidebar ── */}
      <aside className={`wb-sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="任务导航">
        <div className="wb-sb-head">
          <div className="wb-brand">
            <span className="wb-brand-mark" aria-hidden="true">T</span>
            <span className="wb-brand-name">Tekon</span>
          </div>
          <button
            type="button"
            className="wb-sb-icon-btn"
            onClick={() => {
              setSidebarOpen(false);
              navigate('/');
            }}
            title="新建任务"
            aria-label="新建任务"
          >
            {WbIcons.plus}
          </button>
        </div>

        <div className="wb-sb-controls">
          <div className="wb-sb-search">
            {WbIcons.search}
            <input
              type="search"
              placeholder="搜索任务…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="搜索任务"
            />
          </div>
          <div className="wb-sb-tabs" role="tablist" aria-label="任务状态筛选">
            {(
              [
                ['all', '全部'],
                ['running', '进行中'],
                ['attention', '待处理'],
                ['done', '已完成'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={taskFilter === key}
                className={`wb-sb-tab ${taskFilter === key ? 'active' : ''}`}
                onClick={() => setTaskFilter(key)}
              >
                {label}
                {key === 'attention' && attentionCount > 0 ? (
                  <span className="wb-dot-warn-xs" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="wb-task-list" data-testid="task-list">
          {tasks.length === 0 ? (
            <div className="wb-sb-empty">暂无任务</div>
          ) : (
            tasks.map((t) => (
              <button
                key={t.runId}
                type="button"
                className={`wb-task-item ${!isSettingsRoute && routeRunId === t.runId ? 'active' : ''}`}
                onClick={() => {
                  setSidebarOpen(false);
                  navigate(`/tasks/${t.runId}`);
                }}
              >
                <div className="wb-ti-row1">
                  <span className={`wb-s-dot ${statusDotClass(t)}`} aria-hidden="true" />
                  <span className="wb-ti-title">{t.title}</span>
                </div>
                <div className="wb-ti-row2">
                  <span>{t.templateName}</span>
                  <span className="wb-mono">{t.progressLabel}</span>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="wb-sb-foot">
          <div className="wb-ws-chip" title={workspace.path || workspace.name}>
            {WbIcons.folder}
            <span>{workspace.name}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <button
              type="button"
              className="wb-icon-btn wb-icon-btn-sm"
              onClick={() =>
                void handleUpdatePrefs({
                  theme: prefs.theme === 'dark' ? 'light' : 'dark',
                })
              }
              title={prefs.theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
              aria-label={prefs.theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
            >
              {prefs.theme === 'dark' ? WbIcons.sun : WbIcons.moon}
            </button>
            <button
              type="button"
              className={`wb-sb-settings-btn ${isSettingsRoute ? 'active' : ''}`}
              onClick={() => {
                setSidebarOpen(false);
                navigate('/settings/workflows');
              }}
            >
              {WbIcons.settings}
              <span>设置</span>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Column ── */}
      <main className="wb-main">
        {isSettingsRoute ? (
          /* ── Settings Mode ── */
          <>
            <header className="wb-topbar">
              <div className="wb-tb-left">
                <button
                  type="button"
                  className="wb-icon-btn wb-menu-btn"
                  onClick={toggleSidebar}
                  aria-label="打开任务列表"
                >
                  {WbIcons.menu}
                </button>
                <button
                  type="button"
                  className="wb-icon-btn wb-icon-btn-sm"
                  onClick={() => navigate(currentTask ? `/tasks/${currentTask.runId}` : '/')}
                  title="返回工作台"
                  aria-label="返回工作台"
                >
                  {WbIcons.back}
                </button>
                <span className="wb-tb-title">设置</span>
              </div>
              <div className="wb-tb-right">
                <WidthMenu
                  value={prefs.contentWidth}
                  onChange={(next) => void handleUpdatePrefs({ contentWidth: next })}
                />
              </div>
            </header>

            <SettingsView
              tab={settingsTab}
              onTabChange={(nextTab) => navigate(`/settings/${nextTab}`)}
              agentsSnapshot={agentsSnapshot}
              roles={roles}
              workflows={workflows}
              prefs={prefs}
              onRefreshAgents={handleRefreshAgents}
              onReloadCatalog={loadCatalog}
              onUpdatePrefs={handleUpdatePrefs}
              onNotify={notify}
            />
          </>
        ) : !routeRunId ? (
          /* ── New Task / Empty Hero Mode ── */
          <>
            <header className="wb-topbar">
              <div className="wb-tb-left">
                <button
                  type="button"
                  className="wb-icon-btn wb-menu-btn"
                  onClick={toggleSidebar}
                  aria-label="打开任务列表"
                >
                  {WbIcons.menu}
                </button>
                <span className="wb-tb-title">新任务</span>
              </div>
              <div className="wb-tb-right">
                <WidthMenu
                  value={prefs.contentWidth}
                  onChange={(next) => void handleUpdatePrefs({ contentWidth: next })}
                />
              </div>
            </header>

            <div className="wb-hero" data-testid="new-task-hero">
              <div className="wb-hero-mark" aria-hidden="true">T</div>
              <h1>描述任务，交给多 Agent 流水线</h1>

              <div className="wb-hero-composer">
                {preflightBlockers.length > 0 ? (
                  <div className="wb-action-strip" style={{ margin: '0 0 10px 0' }} data-testid="preflight-blocker">
                    <div className="wb-as-row">
                      <span className="wb-as-title">
                        前置检查：以下 Agent 尚未就绪（
                        {preflightBlockers
                          .map(
                            (b) =>
                              `${b.driver}: ${
                                b.status === 'unauthenticated'
                                  ? '未登录'
                                  : b.status === 'unsupported'
                                    ? '未注册驱动'
                                    : '未安装'
                              }`,
                          )
                          .join(' / ')}
                        ）
                      </span>
                      <div className="wb-as-btns">
                        <button
                          type="button"
                          className="wb-btn wb-btn-xs"
                          onClick={() => navigate('/settings/roles')}
                        >
                          切换角色 Agent
                        </button>
                        <button
                          type="button"
                          className="wb-btn wb-btn-xs wb-btn-primary"
                          onClick={() => navigate('/settings/agents')}
                        >
                          查看本机 Agent
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="wb-composer">
                  <textarea
                    placeholder="输入研究目标、开发需求或评审任务…（Enter 发送，Shift+Enter 换行）"
                    value={heroPrompt}
                    onChange={(e) => setHeroPrompt(e.target.value)}
                    onKeyDown={handleHeroKeyDown}
                    rows={3}
                    aria-label="任务描述"
                  />

                  {heroAttachments.length > 0 ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {heroAttachments.map((att, idx) => (
                        <span key={`${att.name}-${idx}`} className="wb-tb-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {att.name}
                          <button
                            type="button"
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 11 }}
                            onClick={() =>
                              setHeroAttachments((prev) => prev.filter((_, i) => i !== idx))
                            }
                            aria-label={`移除附件 ${att.name}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="wb-composer-foot">
                    <div className="wb-composer-left">
                      <select
                        className="wb-ghost-select"
                        value={heroSelection}
                        onChange={(e) => setHeroSelection(e.target.value)}
                        aria-label="选择工作流模板"
                      >
                        <option value="__dynamic__">✦ 动态编排（自动规划节点）</option>
                        {workflows.map((wf) => (
                          <option key={wf.id} value={wf.id}>
                            {wf.name}（{wf.nodes.length} 步）
                          </option>
                        ))}
                      </select>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => void handleFileSelect(e)}
                      />
                      <button
                        type="button"
                        className="wb-icon-btn wb-icon-btn-sm"
                        onClick={() => fileInputRef.current?.click()}
                        title="添加参考附件（最多 5 个，单个 ≤ 256KB）"
                        aria-label="添加参考附件"
                      >
                        {WbIcons.clip}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="wb-send-btn"
                      disabled={
                        !heroPrompt.trim() ||
                        creatingTask ||
                        preflightBlockers.length > 0
                      }
                      onClick={() => void handleCreateTask()}
                      title="启动任务"
                      aria-label="启动任务"
                    >
                      {WbIcons.send}
                    </button>
                  </div>
                </div>
              </div>

              <div className="wb-quick-pills">
                {workflows.slice(0, 3).map((wf) => (
                  <button
                    key={wf.id}
                    type="button"
                    className="wb-q-pill"
                    onClick={() => setHeroSelection(wf.id)}
                  >
                    <span>{wf.name}</span>
                    <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                      {wf.nodes.length} 节点
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="wb-q-pill"
                  onClick={() => setHeroSelection('__dynamic__')}
                >
                  ✦ 动态编排
                </button>
              </div>
            </div>
          </>
        ) : !currentTask ? (
          /* ── Task Loading / Load Error State (never shows stale previous task!) ── */
          <>
            <header className="wb-topbar">
              <div className="wb-tb-left">
                <button
                  type="button"
                  className="wb-icon-btn wb-menu-btn"
                  onClick={toggleSidebar}
                  aria-label="打开任务列表"
                >
                  {WbIcons.menu}
                </button>
                <span className="wb-tb-title">
                  {loadingTask || !taskLoadError ? '加载任务中…' : '无法加载任务'}
                </span>
              </div>
              <div className="wb-tb-right">
                <WidthMenu
                  value={prefs.contentWidth}
                  onChange={(next) => void handleUpdatePrefs({ contentWidth: next })}
                />
              </div>
            </header>
            <div className="wb-hero" data-testid={taskLoadError ? 'task-load-error' : 'task-loading'}>
              {loadingTask || !taskLoadError ? (
                <div style={{ color: 'var(--text-s)', fontSize: 13 }}>正在加载任务详情…</div>
              ) : (
                <div className="wb-card" style={{ maxWidth: 460, width: '100%' }}>
                  <strong style={{ color: 'var(--fail-t)', display: 'block', marginBottom: 6 }}>
                    加载任务详情失败
                  </strong>
                  <div style={{ fontSize: 12.5, color: 'var(--text-s)', marginBottom: 12 }}>
                    {taskLoadError || '任务不存在或暂时无法读取'}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="wb-btn wb-btn-xs wb-btn-primary"
                      onClick={() => {
                        setLoadingTask(true);
                        setTaskLoadError(null);
                        void refreshActiveTask(routeRunId);
                      }}
                    >
                      重试加载
                    </button>
                    <button
                      type="button"
                      className="wb-btn wb-btn-xs"
                      onClick={() => navigate('/')}
                    >
                      返回新任务
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* ── Task Detail Mode ── */
          <>
            <header className="wb-topbar">
              <div className="wb-tb-left">
                <button
                  type="button"
                  className="wb-icon-btn wb-menu-btn"
                  onClick={toggleSidebar}
                  aria-label="打开任务列表"
                >
                  {WbIcons.menu}
                </button>
                <span className="wb-tb-title" title={currentTask.title}>
                  {currentTask.title}
                </span>
                <span className="wb-tb-tag">{currentTask.templateName}</span>
                {currentTask.executor === 'legacy' ? (
                  <span className="wb-tb-tag" title="由旧版 CLI 或会话执行器创建的任务">
                    旧版任务
                  </span>
                ) : null}
                <span className="wb-tb-status">
                  <span className={`wb-s-dot ${statusDotClass(currentTask)}`} aria-hidden="true" />
                  {statusLabel(currentTask)}
                </span>
              </div>

              <div className="wb-tb-right">
                <WidthMenu
                  value={prefs.contentWidth}
                  onChange={(next) => void handleUpdatePrefs({ contentWidth: next })}
                />
                {currentTask.status === 'running' && currentTask.canControl ? (
                  <button
                    type="button"
                    className="wb-icon-btn"
                    disabled={busyControl}
                    onClick={() => void handlePause()}
                    title="暂停任务"
                    aria-label="暂停任务"
                  >
                    {WbIcons.pause}
                  </button>
                ) : null}
                {currentTask.executor === 'workbench' &&
                currentTask.status === 'paused' &&
                currentTask.pauseReason === 'user_pause' ? (
                  <button
                    type="button"
                    className="wb-icon-btn active"
                    disabled={busyControl}
                    onClick={() => void handleResume()}
                    title="继续执行"
                    aria-label="继续执行"
                  >
                    {WbIcons.play}
                  </button>
                ) : null}
                {(currentTask.status === 'running' || currentTask.status === 'paused') &&
                currentTask.canControl ? (
                  <button
                    type="button"
                    className="wb-icon-btn danger"
                    disabled={busyControl}
                    onClick={() => setCancelConfirmOpen((v) => !v)}
                    title="终止任务"
                    aria-label="终止任务"
                  >
                    {WbIcons.stop}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`wb-icon-btn ${drawerTab === 'docs' ? 'active' : ''}`}
                  onClick={() => openInspector('docs')}
                  title="固化文档"
                  aria-label="打开固化文档抽屉"
                >
                  {WbIcons.doc}
                  {currentTask.documents.length > 0 ? (
                    <span className="wb-icon-count">{currentTask.documents.length}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`wb-icon-btn ${drawerTab === 'ctx' ? 'active' : ''}`}
                  onClick={() =>
                    openInspector('ctx', {
                      nodeId:
                        currentTask.currentNodeId ?? currentTask.nodes[0]?.id,
                    })
                  }
                  title="上下文检查器"
                  aria-label="打开上下文检查器"
                >
                  {WbIcons.ctx}
                </button>
              </div>
            </header>

            {cancelConfirmOpen ? (
              <div
                className="wb-action-strip rose"
                style={{ margin: '8px 18px', flexShrink: 0 }}
                data-testid="cancel-confirm-bar"
              >
                <div className="wb-as-row">
                  <span className="wb-as-title">
                    确认终止当前任务？终止后任务不可恢复，已产出文档仍会保留。
                  </span>
                  <div className="wb-as-btns">
                    <button
                      type="button"
                      className="wb-btn wb-btn-xs"
                      onClick={() => setCancelConfirmOpen(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="wb-btn wb-btn-xs wb-btn-danger-solid"
                      disabled={busyControl}
                      onClick={() => void handleConfirmCancel()}
                    >
                      确认终止
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Top Dot-Line Rail (Default or <=900px) */}
            {railSteps.length > 0 && effectiveRailMode === 'top' ? (
              <TopDotLineRail
                steps={railSteps}
                expanded={topRailExpanded}
                narrow={isNarrow}
                onToggleExpand={() => setTopRailExpanded((v) => !v)}
                onSwitchToRight={() => void handleUpdatePrefs({ railMode: 'right' })}
                onSelectNode={scrollToNode}
                onInspectNode={(nodeId) => openInspector('ctx', { nodeId })}
              />
            ) : null}

            <div className="wb-split">
              <div className="wb-conv-col">
                <div className="wb-timeline" data-testid="task-timeline">
                  <div className="wb-tl-inner">
                    {/* User goal bubble */}
                    <div className="wb-user-bubble">{currentTask.prompt}</div>

                    {/* Dynamic Blueprint Planning / Confirmation / Failure Card (never shown after cancel/pass) */}
                    {currentTask.executor === 'workbench' &&
                    currentTask.mode === 'dynamic' &&
                    currentTask.status !== 'cancelled' &&
                    currentTask.status !== 'passed' &&
                    currentTask.blueprintStatus &&
                    currentTask.blueprintStatus !== 'locked' &&
                    (currentTask.blueprintStatus !== 'review' ||
                      (currentTask.status === 'paused' &&
                        currentTask.pauseReason === 'blueprint_review')) ? (
                      <div className="wb-card" data-testid="blueprint-card" style={{ marginBottom: 10 }}>
                        {currentTask.blueprintStatus === 'planning' ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-s)' }}>
                            <span
                              className={`wb-s-dot ${currentTask.status === 'running' ? 'running' : 'paused'}`}
                            />
                            <span>
                              {currentTask.status === 'running'
                                ? '编排者正在分析需求并生成执行计划…'
                                : '动态规划已暂停，点击顶部继续以恢复规划'}
                            </span>
                          </div>
                        ) : currentTask.blueprintStatus === 'failed' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <strong style={{ color: 'var(--fail-t)' }}>动态规划失败</strong>
                            <div style={{ fontSize: 12.5, color: 'var(--text-s)' }}>
                              {currentTask.blueprint?.error || '未能生成有效的执行计划'}
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="wb-btn wb-btn-xs wb-btn-primary"
                                disabled={busyControl}
                                onClick={() => void handleReplanBlueprint()}
                              >
                                重试规划
                              </button>
                              {workflows.slice(0, 2).map((wf) => (
                                <button
                                  key={wf.id}
                                  type="button"
                                  className="wb-btn wb-btn-xs"
                                  disabled={busyControl}
                                  onClick={() => void handleFallbackStaticFromFailedPlan(wf.id)}
                                >
                                  改用「{wf.name}」
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          /* awaiting_confirm */
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <div>
                                <strong style={{ fontSize: 13.5 }}>动态编排计划（确认后执行）</strong>
                                {currentTask.blueprint?.summary ? (
                                  <div style={{ fontSize: 12, color: 'var(--text-t)' }}>
                                    {currentTask.blueprint.summary}
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs"
                                  onClick={() =>
                                    setBpDraft((prev) => [
                                      ...(prev ?? []),
                                      {
                                        id: `bp-${Date.now().toString(36).slice(-4)}`,
                                        name: `步骤 ${(prev?.length ?? 0) + 1}`,
                                        roleId: roles[0]?.id ?? 'explorer',
                                        expectedDoc: `doc-${(prev?.length ?? 0) + 1}.md`,
                                        confirmAfter: false,
                                      },
                                    ])
                                  }
                                >
                                  {WbIcons.plus} 添加步骤
                                </button>
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs"
                                  onClick={() => setBpSaveOpen((v) => !v)}
                                >
                                  另存为模板
                                </button>
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs wb-btn-primary"
                                  disabled={busyControl || !bpDraft || bpDraft.length === 0}
                                  onClick={() => void handleConfirmBlueprint()}
                                >
                                  {WbIcons.check} 确认开始执行
                                </button>
                              </div>
                            </div>

                            {bpSaveOpen ? (
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                  className="wb-input"
                                  placeholder="输入新模板名称"
                                  value={bpSaveName}
                                  onChange={(e) => setBpSaveName(e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs wb-btn-primary"
                                  disabled={!bpSaveName.trim() || busyControl}
                                  onClick={() => void handleSaveBlueprintAsTemplate()}
                                >
                                  保存
                                </button>
                              </div>
                            ) : null}

                            {(bpDraft ?? []).map((step, idx) => {
                              const r = roleMap.get(step.roleId);
                              const readyAgentId =
                                agentsSnapshot?.agents.find((a) => isExecutableAgent(a))?.id ||
                                agentsSnapshot?.agents[0]?.id ||
                                'claude-code';
                              return (
                                <div key={step.id} className="wb-step-row" style={{ marginBottom: 0 }}>
                                  <div className="wb-step-main">
                                    <div className="wb-step-left" style={{ flex: 1 }}>
                                      <span className="wb-step-idx">{idx + 1}</span>
                                      <input
                                        className="wb-input"
                                        style={{ maxWidth: 160 }}
                                        value={step.name}
                                        onChange={(e) =>
                                          setBpDraft((prev) =>
                                            (prev ?? []).map((item, i) =>
                                              i === idx ? { ...item, name: e.target.value } : item,
                                            ),
                                          )
                                        }
                                      />
                                      <div className="wb-select-with-icon" style={{ minWidth: 130 }}>
                                        <AgentIcon agentId={r?.driver || readyAgentId} size="sm" />
                                        <select
                                          className="wb-select"
                                          value={step.roleId}
                                          onChange={(e) =>
                                            setBpDraft((prev) =>
                                              (prev ?? []).map((item, i) =>
                                                i === idx ? { ...item, roleId: e.target.value } : item,
                                              ),
                                            )
                                          }
                                        >
                                          {roles.map((ro) => (
                                            <option key={ro.id} value={ro.id}>
                                              {ro.name} ({ro.id})
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <label style={{ fontSize: 11.5, color: 'var(--text-s)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        <input
                                          type="checkbox"
                                          checked={Boolean(step.confirmAfter)}
                                          onChange={(e) =>
                                            setBpDraft((prev) =>
                                              (prev ?? []).map((item, i) =>
                                                i === idx ? { ...item, confirmAfter: e.target.checked } : item,
                                              ),
                                            )
                                          }
                                        />
                                        确认点
                                      </label>
                                      <button
                                        type="button"
                                        className="wb-icon-btn wb-icon-btn-sm danger"
                                        disabled={(bpDraft?.length ?? 0) <= 1}
                                        onClick={() =>
                                          setBpDraft((prev) =>
                                            (prev ?? []).filter((_, i) => i !== idx),
                                          )
                                        }
                                        aria-label="删除步骤"
                                      >
                                        {WbIcons.trash}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}

                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <input
                                className="wb-input"
                                placeholder="补充调整意见以重新规划（可选）"
                                value={bpReplanHint}
                                onChange={(e) => setBpReplanHint(e.target.value)}
                              />
                              <button
                                type="button"
                                className="wb-btn wb-btn-xs"
                                disabled={busyControl}
                                onClick={() => void handleReplanBlueprint()}
                              >
                                重新规划
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {/* Execution Node Timeline */}
                    {currentTask.nodes.map((node, idx) => {
                      const railState = mapNodeToRailState(node, currentTask);
                      const nodeDocs = currentTask.documents.filter(
                        (d) => d.nodeId === node.id,
                      );
                      const mergedTrace = [
                        ...node.traceLines,
                        ...(liveTraceByNode[node.id] ?? []).filter(
                          (l) => !node.traceLines.includes(l),
                        ),
                      ];
                      const isAwaitingConfirm =
                        currentTask.executor === 'workbench' &&
                        currentTask.status === 'paused' &&
                        currentTask.pauseReason === 'confirm_checkpoint' &&
                        currentTask.currentNodeId === node.id;
                      const retryOv = retryOverrides[node.id] ?? {
                        driver: node.driver,
                        model: node.model,
                        effort: node.effort,
                      };
                      const retryAgent = agentMap.get(retryOv.driver);
                      const retryModels = retryAgent?.models.length
                        ? retryAgent.models
                        : [retryOv.model];
                      const retryEfforts =
                        retryAgent?.modelEfforts?.[retryOv.model] ??
                        retryAgent?.efforts ??
                        [retryOv.effort];

                      return (
                        <article
                          key={node.id}
                          id={`wb-node-${node.id}`}
                          className={`wb-node-block ${railState === 'pending' ? 'pending' : ''}`}
                          data-testid={`node-block-${node.id}`}
                        >
                          <div className="wb-nb-head">
                            <div className="wb-nb-left">
                              <span
                                className="wb-role-dot"
                                style={{ background: roleColor(node.role) }}
                                aria-hidden="true"
                              />
                              <span className="wb-nb-title">
                                {idx + 1}. {node.name}
                              </span>
                              <span className="wb-ag-chip wb-nb-model">
                                <AgentIcon agentId={node.driver} size="sm" />
                                <span>
                                  {node.role} · {node.driver}/{node.model}/{node.effort}
                                </span>
                              </span>
                              {node.reuseAnchorOrder ? (
                                <span className="wb-tb-tag" title="复用同角色历史会话">
                                  ↻ 续接 #{node.reuseAnchorOrder}
                                </span>
                              ) : null}
                            </div>

                            <div className="wb-nb-right">
                              {node.durationMs ? (
                                <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                                  {(node.durationMs / 1000).toFixed(1)}s
                                </span>
                              ) : null}
                              {node.cacheReusePercent !== null ? (
                                <span className="wb-mono" style={{ color: 'var(--accent-h)' }}>
                                  缓存 {node.cacheReusePercent}%
                                </span>
                              ) : null}
                              <button
                                type="button"
                                className="wb-icon-btn wb-icon-btn-sm"
                                onClick={() => openInspector('ctx', { nodeId: node.id })}
                                title="检查本节点输入上下文"
                                aria-label={`检查节点 ${node.name} 上下文`}
                              >
                                {WbIcons.ctx}
                              </button>
                            </div>
                          </div>

                          {/* Collapsible inline trace */}
                          {(mergedTrace.length > 0 || node.traceSummary || railState === 'running') ? (
                            <details
                              className="wb-trace-inline"
                              open={railState === 'running'}
                            >
                              <summary>
                                <span>
                                  {railState === 'running'
                                    ? '思考与执行流（进行中）'
                                    : node.traceSummary || `执行记录（${mergedTrace.length} 行）`}
                                </span>
                              </summary>
                              <div className="wb-trace-lines">
                                {mergedTrace.length === 0 ? (
                                  <div>等待 Agent 输出…</div>
                                ) : (
                                  mergedTrace.map((line, i) => <div key={i}>{line}</div>)
                                )}
                              </div>
                            </details>
                          ) : null}

                          {/* Main conclusion body */}
                          <div className="wb-nb-body">
                            {node.handoffBrief
                              ? node.handoffBrief
                              : railState === 'running'
                                ? '正在执行中…'
                                : railState === 'paused'
                                  ? '已暂停，等待继续执行'
                                  : railState === 'pending'
                                    ? '等待上游节点完成'
                                    : railState === 'failed'
                                      ? node.errorMessage || '节点执行失败'
                                      : railState === 'cancelled'
                                        ? '已终止'
                                        : '已完成'}
                          </div>

                          {/* Document chips + promote handoff option */}
                          {(nodeDocs.length > 0 || (node.status === 'passed' && node.handoffBrief)) ? (
                            <div className="wb-doc-chips">
                              {nodeDocs.map((doc) => (
                                <button
                                  key={doc.id}
                                  type="button"
                                  className="wb-doc-chip"
                                  onClick={() => openInspector('docs', { docId: doc.id })}
                                >
                                  {WbIcons.doc}
                                  <span>{doc.title}</span>
                                  <span className="wb-doc-ver">v{doc.version}</span>
                                </button>
                              ))}
                              {currentTask.executor === 'workbench' &&
                              node.status === 'passed' &&
                              nodeDocs.length === 0 &&
                              node.handoffBrief ? (
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs wb-btn-ghost"
                                  disabled={busyControl}
                                  onClick={() => void handlePromoteHandoff(node.id)}
                                >
                                  + 固化为文档
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Human Confirmation & Targeted Rework Action Strip */}
                          {isAwaitingConfirm ? (
                            <div className="wb-action-strip" data-testid="confirm-action-strip">
                              <div className="wb-as-row">
                                <span className="wb-as-title">
                                  节点已完成，请确认是否继续下一节点
                                </span>
                                <div className="wb-as-btns">
                                  <button
                                    type="button"
                                    className="wb-btn wb-btn-xs"
                                    onClick={() => {
                                      setReworkOpenNodeId((prev) =>
                                        prev === node.id ? null : node.id,
                                      );
                                      setReworkTargetId(node.id);
                                    }}
                                  >
                                    要求返工
                                  </button>
                                  <button
                                    type="button"
                                    className="wb-btn wb-btn-xs wb-btn-primary"
                                    disabled={busyControl}
                                    onClick={() => void handleApproveCheckpoint()}
                                  >
                                    {WbIcons.check} 确认继续
                                  </button>
                                </div>
                              </div>

                              {reworkOpenNodeId === node.id ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <div className="wb-f-grid2">
                                    <select
                                      className="wb-select"
                                      value={reworkTargetId}
                                      onChange={(e) => setReworkTargetId(e.target.value)}
                                      aria-label="选择返工起始节点"
                                    >
                                      {currentTask.nodes
                                        .slice(0, idx + 1)
                                        .map((n, j) => (
                                          <option key={n.id} value={n.id}>
                                            回退到 #{j + 1} {n.name}
                                          </option>
                                        ))}
                                    </select>
                                    <input
                                      className="wb-input"
                                      placeholder="输入返工修改意见…"
                                      value={reworkNote}
                                      onChange={(e) => setReworkNote(e.target.value)}
                                      aria-label="返工修改意见"
                                    />
                                  </div>
                                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                                    <button
                                      type="button"
                                      className="wb-btn wb-btn-xs"
                                      onClick={() => setReworkOpenNodeId(null)}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="wb-btn wb-btn-xs wb-btn-primary"
                                      disabled={!reworkNote.trim() || busyControl}
                                      onClick={() => void handleReworkSubmit()}
                                    >
                                      提交返工
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Failed Node Single-Step Retry Strip */}
                          {currentTask.executor === 'workbench' && node.status === 'failed' ? (
                            <div className="wb-action-strip rose" data-testid="retry-action-strip">
                              <div className="wb-as-row">
                                <span className="wb-as-title">
                                  节点失败：{node.errorMessage || '执行异常'}
                                </span>
                                <button
                                  type="button"
                                  className="wb-btn wb-btn-xs wb-btn-primary"
                                  disabled={busyControl}
                                  onClick={() => void handleRetryNode(node.id)}
                                >
                                  仅重试此节点
                                </button>
                              </div>
                              <div className="wb-adv-grid" style={{ borderTop: 'none', paddingTop: 0 }}>
                                <div className="wb-select-with-icon">
                                  <AgentIcon agentId={retryOv.driver} size="sm" />
                                  <select
                                    className="wb-select"
                                    aria-label="重试 Agent"
                                    value={retryOv.driver}
                                    onChange={(e) => {
                                      const nextDrv = e.target.value;
                                      const ag = agentMap.get(nextDrv);
                                      const nextModel = ag?.models[0] ?? 'default';
                                      const nextEff = ag?.efforts[0] ?? 'high';
                                      setRetryOverrides((prev) => ({
                                        ...prev,
                                        [node.id]: {
                                          driver: nextDrv,
                                          model: nextModel,
                                          effort: nextEff,
                                        },
                                      }));
                                    }}
                                  >
                                    {(agentsSnapshot?.agents ?? []).map((a) => (
                                      <option
                                        key={a.id}
                                        value={a.id}
                                        disabled={a.status === 'unsupported' && retryOv.driver !== a.id}
                                      >
                                        {a.name}
                                        {a.status === 'unsupported' ? '（未注册驱动）' : ''}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <select
                                  className="wb-select"
                                  aria-label="重试模型"
                                  value={retryOv.model}
                                  onChange={(e) =>
                                    setRetryOverrides((prev) => ({
                                      ...prev,
                                      [node.id]: { ...retryOv, model: e.target.value },
                                    }))
                                  }
                                >
                                  {retryModels.map((m) => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  className="wb-select"
                                  aria-label="重试 Effort"
                                  value={retryOv.effort}
                                  onChange={(e) =>
                                    setRetryOverrides((prev) => ({
                                      ...prev,
                                      [node.id]: { ...retryOv, effort: e.target.value },
                                    }))
                                  }
                                >
                                  {retryEfforts.map((ef) => (
                                    <option key={ef} value={ef}>
                                      {ef}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}

                    {/* Queued constraints notice */}
                    {currentTask.queuedConstraints.length > 0 ? (
                      <div className="wb-action-strip indigo" style={{ marginLeft: 0 }}>
                        <div className="wb-as-title">
                          待注入约束（{currentTask.queuedConstraints.length} 条，将在下一节点自动注入）
                        </div>
                        {currentTask.queuedConstraints.map((c) => (
                          <div key={c.id} style={{ fontSize: 12, color: 'var(--text-s)' }}>
                            • {c.content}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {/* Post-completion Follow-up Turns */}
                    {currentTask.followUps.map((turn) => (
                      <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                        <div className="wb-user-bubble" style={{ marginBottom: 2 }}>
                          {turn.userText}
                        </div>
                        <div className="wb-node-block" style={{ borderBottom: 'none' }}>
                          <div className="wb-nb-head">
                            <div className="wb-nb-left">
                              <span className="wb-role-dot" style={{ background: roleColor(turn.roleId) }} />
                              <span className="wb-nb-title">追问回复 · {turn.roleId}</span>
                              <span className="wb-ag-chip wb-nb-model">
                                <AgentIcon agentId={turn.driver} size="sm" />
                                <span>
                                  {turn.driver}/{turn.model ?? 'default'}
                                </span>
                              </span>
                            </div>
                          </div>
                          <div className="wb-nb-body">{turn.assistantText}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bottom Contextual Composer */}
                {currentTask.executor === 'workbench' &&
                (currentTask.status === 'running' ||
                  currentTask.status === 'paused' ||
                  currentTask.status === 'passed') &&
                currentTask.blueprintStatus !== 'review' &&
                currentTask.blueprintStatus !== 'planning' ? (
                  <div className="wb-composer-wrap">
                    {composerError ? (
                      <div
                        className="wb-action-strip rose"
                        style={{ margin: '0 0 8px 0' }}
                        data-testid="composer-error"
                      >
                        <div className="wb-as-row">
                          <span className="wb-as-title">{composerError}</span>
                          <button
                            type="button"
                            className="wb-btn wb-btn-xs"
                            onClick={() => setComposerError(null)}
                          >
                            关闭
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="wb-composer">
                      <textarea
                        placeholder={
                          currentTask.status === 'passed'
                            ? '基于本任务固化文档继续追问…'
                            : '补充约束或反馈，将自动注入下一节点…'
                        }
                        value={composerText}
                        onChange={(e) => {
                          setComposerText(e.target.value);
                          if (composerError) setComposerError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleTaskComposerSend();
                          }
                        }}
                        rows={2}
                        aria-label={
                          currentTask.status === 'passed' ? '继续追问' : '补充约束'
                        }
                      />
                      <div className="wb-composer-foot">
                        <div className="wb-composer-left">
                          {currentTask.status === 'passed' ? (
                            <select
                              className="wb-ghost-select"
                              value={followUpRoleId}
                              onChange={(e) => setFollowUpRoleId(e.target.value)}
                              aria-label="选择追问角色"
                            >
                              {roles.map((r) => (
                                <option key={r.id} value={r.id}>
                                  由 {r.name} 回复
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span style={{ fontSize: 11.5, color: 'var(--text-t)' }}>
                              补充信息将在下一节点进入时生效
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="wb-send-btn"
                          disabled={!composerText.trim() || sendingComposer}
                          onClick={() => void handleTaskComposerSend()}
                          aria-label="发送"
                        >
                          {WbIcons.send}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Right Vertical Progress Rail (Mode B, > 900px) */}
              {railSteps.length > 0 && effectiveRailMode === 'right' ? (
                <RightVerticalRail
                  steps={railSteps}
                  slim={rightRailSlim}
                  onToggleSlim={() => setRightRailSlim((v) => !v)}
                  onSwitchToTop={() => void handleUpdatePrefs({ railMode: 'top' })}
                  onSelectNode={scrollToNode}
                  onInspectNode={(nodeId) => openInspector('ctx', { nodeId })}
                />
              ) : null}
            </div>
          </>
        )}
      </main>

      {/* ── Right Inspector Drawer (Docs / Context) ── */}
      {!isSettingsRoute && currentTask && drawerTab !== null ? (
        <InspectorDrawer
          runId={currentTask.runId}
          tab={drawerTab}
          readOnly={currentTask.executor !== 'workbench'}
          nodes={currentTask.nodes}
          documents={currentTask.documents}
          selectedDocId={selectedDocId}
          selectedNodeId={selectedCtxNodeId}
          onTabChange={(t) => setDrawerTab(t)}
          onSelectDoc={(id) => setSelectedDocId(id)}
          onSelectNode={(id) => setSelectedCtxNodeId(id)}
          onClose={() => setDrawerTab(null)}
          onTaskMutated={async () => {
            if (routeRunIdRef.current === currentTask.runId) {
              await refreshActiveTask(currentTask.runId);
            }
            await refreshTaskList();
          }}
          onNotify={notify}
        />
      ) : null}

      {/* Toast */}
      {toast ? (
        <div className="wb-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
