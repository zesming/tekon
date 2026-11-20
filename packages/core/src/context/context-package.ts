import type { NodeContextMode } from '../types/domain.js';

export interface ContextDocEntry {
  id: string;
  docKey: string;
  title: string;
  version: number;
  sourceNodeId: string | null;
  pinned: boolean;
  summary: string;
  delivery: 'full' | 'index';
  content?: string;
}

export interface ContextGeneralEntry {
  id: string;
  kind:
    | 'goal'
    | 'handoff'
    | 'constraint'
    | 'rework_feedback'
    | 'compaction_summary'
    | 'followup';
  nodeId: string | null;
  content: string;
  status: 'active' | 'queued_next' | 'compacted';
  createdAt: string;
}

export interface ContextArchiveEntry {
  id: string;
  nodeId: string | null;
  kind: 'private_trace' | 'doc_snapshot' | 'compacted_history';
  title: string;
  summary: string;
  filePath: string;
  byteSize: number;
  mounted: boolean;
  createdAt: string;
  content?: string;
}

export interface SessionReuseProjection {
  mode: 'new' | 'isolated' | 'reuse' | 'reset';
  anchorNodeId?: string;
  anchorNodeOrder?: number;
  providerThreadId?: string;
  cacheReusePercent?: number;
  windowPercent: number;
  windowTokens: number;
  windowLimit: number;
}

/**
 * Single Source of Truth for both:
 * 1. Exact prompt assembly fed into an AgentAdapter during execution;
 * 2. Context Inspector Drawer (`context.inspectNode`) shown to the user.
 */
export interface NodeContextPackage {
  runId: string;
  nodeId: string;
  nodeName: string;
  roleId: string;
  driver: string;
  model: string;
  effort: string;
  contextMode: NodeContextMode;
  session: SessionReuseProjection;
  generalEntries: ContextGeneralEntry[];
  queuedConstraints: ContextGeneralEntry[];
  documents: ContextDocEntry[];
  isolatedArchives: ContextArchiveEntry[];
  mountedArchives: ContextArchiveEntry[];
}

export interface BuildNodeContextInput {
  runId: string;
  nodeId: string;
  nodeName: string;
  nodeIndex: number;
  roleId: string;
  driver: string;
  model: string;
  effort: string;
  contextMode: NodeContextMode;
  roleIsolated: boolean;
  previousNodeId: string | null;
  sameRoleAnchor?: {
    nodeId: string;
    nodeOrder: number;
    providerThreadId?: string;
    reuseMode: 'reuse' | 'reset';
    cacheReusePercent?: number;
    windowTokens: number;
    windowLimit: number;
  };
  generalEntries: ContextGeneralEntry[];
  allLatestDocs: Array<{
    id: string;
    docKey: string;
    title: string;
    version: number;
    sourceNodeId: string | null;
    pinned: boolean;
    summary: string;
    content: string;
  }>;
  archives: ContextArchiveEntry[];
  windowTokens?: number;
  windowLimit?: number;
}

/**
 * Pure deterministic context package builder shared identically by execution
 * and UI inspection (Single-Source-of-Truth invariant).
 */
/**
 * Single decision function for same-role session reuse.
 * An explicit user override (`anchorReuseMode === 'reset'`) always wins over a
 * template default (`contextMode === 'reuse'`), so users can always break out
 * of session reuse before or during execution.
 */
export function resolveSameRoleReuseMode(
  contextMode: NodeContextMode,
  anchorReuseMode: 'reuse' | 'reset',
): 'reuse' | 'reset' {
  if (anchorReuseMode === 'reset') return 'reset';
  if (contextMode === 'full') return 'reset';
  return 'reuse';
}

export function buildNodeContextPackage(
  input: BuildNodeContextInput,
): NodeContextPackage {
  const isIsolated = input.contextMode === 'isolated' || input.roleIsolated;

  // Determine session strategy
  let session: SessionReuseProjection;
  const windowLimit = input.sameRoleAnchor?.windowLimit ?? input.windowLimit ?? 200_000;
  const windowTokens = input.sameRoleAnchor?.windowTokens ?? input.windowTokens ?? 0;
  const windowPercent = Math.min(
    100,
    Math.round((windowTokens / Math.max(1, windowLimit)) * 100),
  );

  if (isIsolated) {
    session = {
      mode: 'isolated',
      windowPercent,
      windowTokens,
      windowLimit,
    };
  } else if (input.sameRoleAnchor) {
    const mode = resolveSameRoleReuseMode(
      input.contextMode,
      input.sameRoleAnchor.reuseMode,
    );
    const reuse = mode === 'reuse';
    session = {
      mode,
      anchorNodeId: input.sameRoleAnchor.nodeId,
      anchorNodeOrder: input.sameRoleAnchor.nodeOrder,
      providerThreadId: reuse ? input.sameRoleAnchor.providerThreadId : undefined,
      cacheReusePercent: reuse ? input.sameRoleAnchor.cacheReusePercent : undefined,
      windowPercent,
      windowTokens,
      windowLimit,
    };
  } else {
    session = {
      mode: 'new',
      windowPercent,
      windowTokens,
      windowLimit,
    };
  }

  // Active general context vs queued constraints
  const activeGeneral = input.generalEntries.filter((e) => e.status === 'active');
  const queuedConstraints = input.generalEntries.filter(
    (e) => e.status === 'queued_next',
  );

  // Solidified documents: pinned, user attachments (sourceNodeId === null), or
  // direct upstream docs are delivered in full; older docs are index-only.
  const documents: ContextDocEntry[] = input.allLatestDocs.map((doc) => {
    const isDirectUpstream =
      input.previousNodeId !== null && doc.sourceNodeId === input.previousNodeId;
    const isAttachment = doc.sourceNodeId === null;
    const delivery: 'full' | 'index' =
      doc.pinned ||
      isAttachment ||
      isDirectUpstream ||
      input.contextMode === 'full'
        ? 'full'
        : 'index';
    return {
      id: doc.id,
      docKey: doc.docKey,
      title: doc.title,
      version: doc.version,
      sourceNodeId: doc.sourceNodeId,
      pinned: doc.pinned,
      summary: doc.summary,
      delivery,
      ...(delivery === 'full' ? { content: doc.content } : {}),
    };
  });

  // Sort pinned docs first for deterministic stable prompt prefix (KV cache friendly)
  documents.sort((a, b) => Number(b.pinned) - Number(a.pinned));

  // Private traces and historical archives are strictly isolated unless mounted=true
  const mountedArchives = input.archives.filter((a) => a.mounted);
  const isolatedArchives = input.archives.filter((a) => !a.mounted);

  return {
    runId: input.runId,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    roleId: input.roleId,
    driver: input.driver,
    model: input.model,
    effort: input.effort,
    contextMode: input.contextMode,
    session,
    generalEntries: activeGeneral,
    queuedConstraints,
    documents,
    isolatedArchives,
    mountedArchives,
  };
}

/**
 * Renders the exact prompt text sent to the AgentAdapter from `NodeContextPackage`.
 * Private isolated archives (`pkg.isolatedArchives`) are NEVER included.
 */
export function renderNodeContextPrompt(input: {
  pkg: NodeContextPackage;
  systemPrompt: string;
  overridePrompt?: string;
  docKey?: string;
  expectedDoc?: string;
}): string {
  const { pkg, systemPrompt, overridePrompt, docKey, expectedDoc } = input;
  const sections: string[] = [];

  // 1. Stable prefix: Role system prompt
  sections.push(`# 角色设定 (${pkg.roleId})\n\n${systemPrompt.trim()}`);

  // 2. Stable prefix: Task goal & pinned documents first (maximizes provider prompt cache)
  const goals = pkg.generalEntries.filter((e) => e.kind === 'goal');
  if (goals.length > 0) {
    sections.push(
      `# 任务目标\n\n${goals.map((g) => g.content).join('\n\n')}`,
    );
  }

  const fullDocs = pkg.documents.filter((d) => d.delivery === 'full');
  const indexDocs = pkg.documents.filter((d) => d.delivery === 'index');

  if (fullDocs.length > 0) {
    sections.push(
      `# 固化文档（全文输入）\n\n${fullDocs
        .map(
          (d) =>
            `## ${d.title} (${d.docKey} v${d.version}${d.pinned ? ' · Pin' : ''})\n\n${d.content ?? d.summary}`,
        )
        .join('\n\n---\n\n')}`,
    );
  }

  if (indexDocs.length > 0) {
    sections.push(
      `# 历史固化文档索引（按需参考）\n\n${indexDocs
        .map((d) => `- **${d.title}** (${d.docKey} v${d.version})：${d.summary}`)
        .join('\n')}`,
    );
  }

  // 3. Dynamic general context: compaction summary, handoffs, constraints, rework feedback
  const nonGoalGeneral = pkg.generalEntries.filter((e) => e.kind !== 'goal');
  if (nonGoalGeneral.length > 0) {
    const labelMap: Record<ContextGeneralEntry['kind'], string> = {
      goal: '目标',
      handoff: '上游交接摘要',
      constraint: '用户补充约束',
      rework_feedback: '打回修改意见',
      compaction_summary: '历史里程碑压缩摘要',
      followup: '后续追问',
    };
    sections.push(
      `# 通用上下文（沟通流）\n\n${nonGoalGeneral
        .map((e) => `### ${labelMap[e.kind]}${e.nodeId ? ` (${e.nodeId})` : ''}\n${e.content}`)
        .join('\n\n')}`,
    );
  }

  // 4. Explicitly user-mounted archives ONLY (never isolatedArchives!)
  if (pkg.mountedArchives.length > 0) {
    sections.push(
      `# 用户手动挂载的历史归档\n\n${pkg.mountedArchives
        .map((a) => `### ${a.title}\n${a.content ?? a.summary}`)
        .join('\n\n')}`,
    );
  }

  // 5. Current node task & slim Artifact Protocol
  const nodeDirectives: string[] = [
    `# 当前节点任务：${pkg.nodeName} (${pkg.nodeId})`,
  ];
  if (overridePrompt?.trim()) {
    nodeDirectives.push(`## 节点补充指令\n${overridePrompt.trim()}`);
  }
  if (docKey) {
    nodeDirectives.push(
      [
        '## 输出契约（Tekon Artifact Protocol）',
        `- 请将本节点的完整固化文档（${expectedDoc ?? docKey}）写入 \`$TEKON_OUTPUT_DIR/${docKey}.md\`（纯 Markdown）。`,
        '- 请将面向下游节点的精炼交接摘要写入 `$TEKON_OUTPUT_DIR/handoff.json`，格式为：`{"summary":"≤500字核心结论与风险","docTitle":"文档标题","docSummary":"一句话摘要"}`。',
        '- 切勿在文档或输出中写入任何真实密钥、Token 或凭据。',
      ].join('\n'),
    );
  } else {
    nodeDirectives.push(
      '## 输出契约\n- 请直接输出结构化清晰结论，并可将精炼交接摘要写入 `$TEKON_OUTPUT_DIR/handoff.json`。',
    );
  }
  sections.push(nodeDirectives.join('\n\n'));

  return sections.join('\n\n---\n\n');
}
