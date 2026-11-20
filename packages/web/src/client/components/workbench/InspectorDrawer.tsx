import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { rpc } from '../../lib/rpc-client.js';
import type {
  contextArchiveEntrySchema,
  nodeContextPackageSchema,
  solidifiedDocSchema,
  taskNodeViewSchema,
} from '../../../shared/workbench-contract.js';
import { AgentIcon, WbIcons } from './AgentIcon.js';

type TaskNodeView = z.infer<typeof taskNodeViewSchema>;
type SolidifiedDoc = z.infer<typeof solidifiedDocSchema>;
type NodeContextPackage = z.infer<typeof nodeContextPackageSchema>;
type ContextArchive = z.infer<typeof contextArchiveEntrySchema>;

interface DiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

export function InspectorDrawer({
  runId,
  tab,
  nodes,
  documents,
  selectedDocId,
  selectedNodeId,
  onTabChange,
  onSelectDoc,
  onSelectNode,
  onClose,
  onTaskMutated,
  onNotify,
}: {
  runId: string;
  tab: 'docs' | 'ctx';
  nodes: TaskNodeView[];
  documents: SolidifiedDoc[];
  selectedDocId: string | null;
  selectedNodeId: string | null;
  onTabChange: (tab: 'docs' | 'ctx') => void;
  onSelectDoc: (docId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  onTaskMutated: () => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  // ── Docs state ──
  const activeDoc =
    documents.find((d) => d.id === selectedDocId) ?? documents[0] ?? null;
  const [selectedVer, setSelectedVer] = useState<number | null>(null);
  const [docContent, setDocContent] = useState<string>('');
  const [docLoading, setDocLoading] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [diffData, setDiffData] = useState<{
    fromVersion: number;
    toVersion: number;
    addedCount: number;
    removedCount: number;
    lines: DiffLine[];
  } | null>(null);

  // ── Context state ──
  const activeNode =
    nodes.find((n) => n.id === selectedNodeId) ?? nodes[0] ?? null;
  const [ctxPkg, setCtxPkg] = useState<NodeContextPackage | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [archives, setArchives] = useState<ContextArchive[]>([]);
  const [expandedArchiveIds, setExpandedArchiveIds] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState(false);

  // Reset version & diff when switching doc
  useEffect(() => {
    setSelectedVer(activeDoc?.version ?? null);
    setDiffMode(false);
    setDiffData(null);
  }, [activeDoc?.id, activeDoc?.version]);

  // Load doc content
  useEffect(() => {
    if (tab !== 'docs' || !activeDoc) return;
    let cancelled = false;
    setDocLoading(true);
    void rpc
      .call('doc.get', {
        runId,
        docId: activeDoc.id,
        version: selectedVer ?? activeDoc.version,
      })
      .then((res) => {
        if (!cancelled) {
          setDocContent(res.content);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDocContent(`读取失败：${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, runId, activeDoc?.id, activeDoc?.version, selectedVer]);

  // Load diff when toggled on
  useEffect(() => {
    if (tab !== 'docs' || !diffMode || !activeDoc || activeDoc.versions.length < 2) {
      return;
    }
    const sorted = [...activeDoc.versions].sort((a, b) => a - b);
    const toVer = selectedVer ?? sorted[sorted.length - 1]!;
    const fromVer =
      sorted.filter((v) => v < toVer).pop() ?? sorted[0]!;
    if (fromVer === toVer) return;
    let cancelled = false;
    void rpc
      .call('doc.diff', {
        runId,
        docKey: activeDoc.docKey,
        fromVersion: fromVer,
        toVersion: toVer,
      })
      .then((res) => {
        if (!cancelled) setDiffData(res);
      })
      .catch(() => {
        if (!cancelled) setDiffData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, diffMode, runId, activeDoc?.docKey, activeDoc?.versions, selectedVer]);

  // Load context inspection + archives
  const reloadContext = useCallback(async () => {
    if (!activeNode) return;
    setCtxLoading(true);
    try {
      const [inspected, arcRes] = await Promise.all([
        rpc.call('context.inspectNode', { runId, nodeId: activeNode.id }),
        rpc.call('context.listArchives', { runId }),
      ]);
      setCtxPkg(inspected.context);
      setArchives(arcRes.archives);
    } catch (err) {
      onNotify(`加载上下文失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCtxLoading(false);
    }
  }, [runId, activeNode?.id, onNotify]);

  useEffect(() => {
    if (tab === 'ctx' && activeNode) {
      void reloadContext();
    }
  }, [tab, activeNode?.id, reloadContext]);

  async function handleTogglePin() {
    if (!activeDoc || busyAction) return;
    setBusyAction(true);
    try {
      const res = await rpc.call('doc.togglePin', { runId, docId: activeDoc.id });
      await onTaskMutated();
      onNotify(res.document.pinned ? '已置顶文档' : '已取消置顶');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleExport() {
    if (!activeDoc || busyAction) return;
    setBusyAction(true);
    try {
      const res = await rpc.call('doc.export', { runId, docId: activeDoc.id });
      const blob = new Blob([res.content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotify(`已导出 ${res.filename}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleToggleReuse() {
    if (!ctxPkg || busyAction) return;
    setBusyAction(true);
    try {
      const nextMode = ctxPkg.session.mode === 'reuse' ? 'reset' : 'reuse';
      await rpc.call('context.setNodeReuseMode', {
        runId,
        roleId: ctxPkg.roleId,
        reuseMode: nextMode,
      });
      await reloadContext();
      await onTaskMutated();
      onNotify(nextMode === 'reset' ? '已切换为重置会话' : '已启用同角色会话复用');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '切换失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleCompact() {
    if (busyAction) return;
    setBusyAction(true);
    try {
      const res = await rpc.call('context.compact', { runId });
      await reloadContext();
      await onTaskMutated();
      onNotify(`已压缩 ${res.compactedCount} 条历史，原文已归档`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '压缩失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleToggleArchivePreview(archiveId: string) {
    if (expandedArchiveIds[archiveId] !== undefined) {
      setExpandedArchiveIds((prev) => {
        const next = { ...prev };
        delete next[archiveId];
        return next;
      });
      return;
    }
    try {
      const res = await rpc.call('context.getArchive', { runId, archiveId });
      setExpandedArchiveIds((prev) => ({ ...prev, [archiveId]: res.content }));
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '读取归档失败');
    }
  }

  async function handleToggleArchiveMount(archiveId: string) {
    if (busyAction) return;
    setBusyAction(true);
    try {
      const res = await rpc.call('context.toggleArchiveMount', { runId, archiveId });
      await reloadContext();
      onNotify(res.archive.mounted ? '已挂载归档到下次运行上下文' : '已取消挂载归档');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '切换挂载失败');
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <aside className="wb-drawer" aria-label={tab === 'docs' ? '文档抽屉' : '上下文检查器'}>
      <div className="wb-dr-head">
        <div className="wb-dr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'docs'}
            className={`wb-dr-tab ${tab === 'docs' ? 'active' : ''}`}
            onClick={() => onTabChange('docs')}
          >
            {WbIcons.doc} 文档 ({documents.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ctx'}
            className={`wb-dr-tab ${tab === 'ctx' ? 'active' : ''}`}
            onClick={() => onTabChange('ctx')}
          >
            {WbIcons.ctx} 上下文
          </button>
        </div>
        <button
          type="button"
          className="wb-icon-btn wb-icon-btn-sm"
          onClick={onClose}
          title="关闭抽屉"
          aria-label="关闭抽屉"
        >
          {WbIcons.stop}
        </button>
      </div>

      <div className="wb-dr-body">
        {tab === 'docs' ? (
          documents.length === 0 ? (
            <div style={{ color: 'var(--text-t)', textAlign: 'center', padding: '32px 12px', fontSize: 12.5 }}>
              暂无固化文档
            </div>
          ) : (
            <>
              <div className="wb-pill-group">
                {documents.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    className={`wb-pill ${activeDoc?.id === doc.id ? 'active' : ''}`}
                    onClick={() => onSelectDoc(doc.id)}
                  >
                    {doc.pinned ? '📌 ' : ''}
                    {doc.title} · v{doc.version}
                  </button>
                ))}
              </div>

              {activeDoc ? (
                <>
                  <div className="wb-pill-bar">
                    <div className="wb-pill-group">
                      {activeDoc.versions.map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={`wb-pill ${(selectedVer ?? activeDoc.version) === v ? 'active' : ''}`}
                          onClick={() => setSelectedVer(v)}
                        >
                          v{v}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {activeDoc.versions.length >= 2 ? (
                        <button
                          type="button"
                          className={`wb-icon-btn wb-icon-btn-sm ${diffMode ? 'active' : ''}`}
                          onClick={() => setDiffMode((d) => !d)}
                          title="版本对比"
                          aria-label="版本对比"
                        >
                          {WbIcons.diff}
                        </button>
                      ) : null}
                      {activeDoc.source === 'artifact' ? (
                        <button
                          type="button"
                          className={`wb-icon-btn wb-icon-btn-sm ${activeDoc.pinned ? 'active' : ''}`}
                          onClick={() => void handleTogglePin()}
                          disabled={busyAction}
                          title={activeDoc.pinned ? '取消置顶' : '置顶文档'}
                          aria-label={activeDoc.pinned ? '取消置顶' : '置顶文档'}
                        >
                          {WbIcons.pin}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="wb-icon-btn wb-icon-btn-sm"
                        onClick={() => void handleExport()}
                        disabled={busyAction}
                        title="导出 Markdown"
                        aria-label="导出 Markdown"
                      >
                        {WbIcons.export}
                      </button>
                    </div>
                  </div>

                  {docLoading ? (
                    <div style={{ color: 'var(--text-t)', fontSize: 12 }}>加载中…</div>
                  ) : diffMode && diffData ? (
                    <div className="wb-diff-list" data-testid="doc-diff-view">
                      <div className="wb-mono" style={{ color: 'var(--text-t)', marginBottom: 4 }}>
                        v{diffData.fromVersion} → v{diffData.toVersion} (+{diffData.addedCount} / -{diffData.removedCount})
                      </div>
                      {diffData.lines.map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.type === 'added'
                              ? 'wb-d-add'
                              : line.type === 'removed'
                                ? 'wb-d-del'
                                : 'wb-d-ctx'
                          }
                        >
                          {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                          {line.text}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="wb-md-pre" data-testid="doc-content-view">
                      {docContent}
                    </pre>
                  )}
                </>
              ) : null}
            </>
          )
        ) : (
          /* ── Context Inspector Tab ── */
          <>
            <div className="wb-pill-group">
              {nodes.map((n, idx) => (
                <button
                  key={n.id}
                  type="button"
                  className={`wb-pill ${activeNode?.id === n.id ? 'active' : ''}`}
                  onClick={() => onSelectNode(n.id)}
                >
                  #{idx + 1} {n.name.slice(0, 6)}
                </button>
              ))}
            </div>

            {ctxLoading && !ctxPkg ? (
              <div style={{ color: 'var(--text-t)', fontSize: 12 }}>加载上下文…</div>
            ) : ctxPkg ? (
              <>
                <div className="wb-kv-list" data-testid="context-summary-kv">
                  <div className="wb-kv-row">
                    <span className="wb-kv-k">节点</span>
                    <span className="wb-kv-v">{ctxPkg.nodeName}</span>
                  </div>
                  <div className="wb-kv-row">
                    <span className="wb-kv-k">Agent</span>
                    <span className="wb-kv-v wb-ag-chip wb-mono">
                      <AgentIcon agentId={ctxPkg.driver} size="sm" />
                      <span>
                        {ctxPkg.roleId} · {ctxPkg.driver}/{ctxPkg.model}/{ctxPkg.effort}
                      </span>
                    </span>
                  </div>
                  <div className="wb-kv-row">
                    <span className="wb-kv-k">会话</span>
                    <span className="wb-kv-v" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                      <span>
                        {ctxPkg.session.mode === 'reuse'
                          ? `续接 #${ctxPkg.session.anchorNodeOrder ?? '?'} 会话`
                          : ctxPkg.session.mode === 'isolated'
                            ? '独立会话（隔离）'
                            : ctxPkg.session.mode === 'reset'
                              ? '已重置为新会话'
                              : '新建会话'}
                        {ctxPkg.session.cacheReusePercent !== undefined
                          ? ` · 缓存 ${ctxPkg.session.cacheReusePercent}%`
                          : ''}
                      </span>
                      {ctxPkg.session.mode !== 'isolated' ? (
                        <button
                          type="button"
                          className="wb-btn wb-btn-xs"
                          disabled={busyAction}
                          onClick={() => void handleToggleReuse()}
                        >
                          {ctxPkg.session.mode === 'reuse' ? '重置会话' : '启用复用'}
                        </button>
                      ) : null}
                    </span>
                  </div>
                </div>

                {/* Window Meter + Compact */}
                <div className="wb-meter-row">
                  <span className="wb-mono" style={{ color: 'var(--text-t)', flexShrink: 0 }}>
                    窗口 {ctxPkg.session.windowPercent}%
                  </span>
                  <div className="wb-meter-bar">
                    <div
                      className={`wb-meter-fill ${ctxPkg.session.windowPercent >= 75 ? 'warn' : ''}`}
                      style={{ width: `${Math.min(100, ctxPkg.session.windowPercent)}%` }}
                    />
                  </div>
                  <button
                    type="button"
                    className="wb-btn wb-btn-xs"
                    disabled={busyAction}
                    onClick={() => void handleCompact()}
                    title="压缩并归档历史上下文"
                  >
                    {WbIcons.compact} 压缩
                  </button>
                </div>

                {/* General Context */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-t)' }}>
                    通用上下文 ({ctxPkg.generalEntries.length})
                  </div>
                  {ctxPkg.generalEntries.map((entry) => (
                    <div key={entry.id} className="wb-arc-row">
                      <div className="wb-arc-top">
                        <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                          {entry.kind}
                        </span>
                        {entry.status === 'queued_next' ? (
                          <span className="wb-tb-tag">待下节点注入</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-s)', whiteSpace: 'pre-wrap' }}>
                        {entry.content}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Solidified Documents injected */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-t)' }}>
                    固化文档输入 ({ctxPkg.documents.length})
                  </div>
                  {ctxPkg.documents.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-t)' }}>无</div>
                  ) : (
                    ctxPkg.documents.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className="wb-arc-row"
                        style={{ textAlign: 'left', background: 'transparent', cursor: 'pointer' }}
                        onClick={() => {
                          onSelectDoc(d.id);
                          onTabChange('docs');
                        }}
                      >
                        <div className="wb-arc-top">
                          <span style={{ fontWeight: 550, color: 'var(--text)' }}>
                            {d.pinned ? '📌 ' : ''}
                            {d.title} · v{d.version}
                          </span>
                          <span className="wb-tb-tag">
                            {d.delivery === 'full' ? '全文注入' : '索引'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-t)' }}>{d.summary}</div>
                      </button>
                    ))
                  )}
                </div>

                {/* Reversible Archives */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-t)' }}>
                    上下文归档 ({archives.length})
                  </div>
                  {archives.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-t)' }}>暂无归档记录</div>
                  ) : (
                    archives.map((arc) => {
                      const preview = expandedArchiveIds[arc.id];
                      return (
                        <div key={arc.id} className="wb-arc-row" data-testid={`archive-row-${arc.id}`}>
                          <div className="wb-arc-top">
                            <span style={{ fontWeight: 550, color: 'var(--text)' }}>{arc.title}</span>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                type="button"
                                className="wb-btn wb-btn-xs wb-btn-ghost"
                                onClick={() => void handleToggleArchivePreview(arc.id)}
                                title="预览归档原文"
                              >
                                {WbIcons.eye}
                              </button>
                              <button
                                type="button"
                                className={`wb-btn wb-btn-xs ${arc.mounted ? 'wb-btn-primary' : ''}`}
                                disabled={busyAction}
                                onClick={() => void handleToggleArchiveMount(arc.id)}
                              >
                                {arc.mounted ? '已挂载' : '挂载'}
                              </button>
                            </div>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-t)' }}>
                            {arc.summary}
                          </div>
                          {preview !== undefined ? (
                            <pre className="wb-arc-detail">{preview}</pre>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
