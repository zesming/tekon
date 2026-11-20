import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  resolveSafeTekonPath,
  writeFileAtomically,
} from '../artifact/store.js';
import type { TekonDatabase } from '../db/connection.js';
import type { WriteQueue } from '../db/write-queue.js';
import { scanTextForSecrets } from '../security/secrets.js';
import type { NodeContextMode } from '../types/domain.js';
import {
  buildNodeContextPackage,
  type ContextArchiveEntry,
  type ContextGeneralEntry,
  type NodeContextPackage,
} from './context-package.js';
import { computeLineDiff, type DocumentDiffResult } from './diff.js';

export const MAX_ATTACHMENTS_PER_TASK = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 1024 * 1024;

export interface WorkbenchPreferences {
  defaultOrchestrator: string;
  compactThreshold: '75' | '85' | 'manual';
  autoArchiveLogs: boolean;
  theme: 'light' | 'dark';
  contentWidth: 'normal' | 'wide' | 'full';
  railMode: 'top' | 'right';
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  defaultOrchestrator: 'orchestrator',
  compactThreshold: '75',
  autoArchiveLogs: true,
  theme: 'light',
  contentWidth: 'normal',
  railMode: 'top',
};

export interface SolidifiedDocumentItem {
  id: string;
  source: 'artifact' | 'attachment';
  runId: string;
  nodeId: string | null;
  docKey: string;
  title: string;
  version: number;
  summary: string;
  pinned: boolean;
  archived: boolean;
  sizeBytes: number;
  createdAt: string;
  versions: number[];
}

export interface FollowUpTurnRecord {
  id: string;
  runId: string;
  roleId: string;
  driver: string;
  model: string | null;
  userText: string;
  assistantText: string;
  createdAt: string;
}

export interface CreateContextManagerOptions {
  db: TekonDatabase;
  writeQueue: WriteQueue;
  repoPath: string;
}

export interface ContextManager {
  addTaskAttachments(
    runId: string,
    attachments: Array<{ name: string; content: string }>,
  ): Promise<SolidifiedDocumentItem[]>;
  appendGeneralEntry(input: {
    runId: string;
    nodeId?: string | null;
    kind: ContextGeneralEntry['kind'];
    content: string;
    status?: ContextGeneralEntry['status'];
  }): Promise<ContextGeneralEntry>;
  activateQueuedConstraints(runId: string): Promise<number>;
  listGeneralEntries(runId: string): ContextGeneralEntry[];
  upsertRoleSession(input: {
    runId: string;
    roleId: string;
    driver: string;
    providerThreadId?: string | null;
    anchorNodeId?: string | null;
    reuseMode?: 'reuse' | 'reset';
    windowTokens?: number;
    windowLimit?: number;
  }): Promise<void>;
  setRoleSessionReuseMode(
    runId: string,
    roleId: string,
    reuseMode: 'reuse' | 'reset',
  ): Promise<void>;
  getRoleSession(
    runId: string,
    roleId: string,
  ): {
    driver: string;
    providerThreadId?: string;
    anchorNodeId?: string;
    reuseMode: 'reuse' | 'reset';
    windowTokens: number;
    windowLimit: number;
  } | null;
  recordArchive(input: {
    runId: string;
    nodeId?: string | null;
    kind: ContextArchiveEntry['kind'];
    title: string;
    summary: string;
    content: string;
  }): Promise<ContextArchiveEntry>;
  listArchives(runId: string): ContextArchiveEntry[];
  getArchiveContent(
    runId: string,
    archiveId: string,
  ): { archive: ContextArchiveEntry; content: string };
  toggleArchiveMount(
    runId: string,
    archiveId: string,
  ): Promise<ContextArchiveEntry>;
  compactContext(runId: string): Promise<{
    compactedCount: number;
    archive: ContextArchiveEntry;
    windowPercent: number;
  }>;
  listRunDocuments(runId: string): SolidifiedDocumentItem[];
  getDocumentContent(
    runId: string,
    docIdOrKey: string,
    version?: number,
  ): { document: SolidifiedDocumentItem; content: string };
  toggleDocumentPin(
    runId: string,
    docId: string,
  ): Promise<SolidifiedDocumentItem>;
  diffDocuments(
    runId: string,
    docKey: string,
    fromVersion: number,
    toVersion: number,
  ): DocumentDiffResult;
  exportDocument(
    runId: string,
    docId: string,
  ): { filename: string; content: string };
  promoteHandoffToDocument(input: {
    runId: string;
    nodeId: string;
    title?: string;
  }): Promise<SolidifiedDocumentItem>;
  inspectNodeContext(input: {
    runId: string;
    nodeId: string;
  }): NodeContextPackage;
  getPreferences(): WorkbenchPreferences;
  updatePreferences(
    patch: Partial<WorkbenchPreferences>,
  ): Promise<WorkbenchPreferences>;
  recordFollowUpTurn(input: {
    runId: string;
    roleId: string;
    driver: string;
    model?: string;
    userText: string;
    assistantText: string;
  }): Promise<FollowUpTurnRecord>;
  listFollowUpTurns(runId: string): FollowUpTurnRecord[];
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`unsafe identifier segment: ${value}`);
  }
  return value;
}

export function sanitizeExportFilename(title: string, version: number): string {
  const cleaned = title
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/\.+/gu, '.')
    .replace(/^\.+|\.+$/gu, '')
    .trim()
    .slice(0, 80);
  const base = cleaned || 'document';
  return `${base}-v${version}.md`;
}

function slugifyAttachmentName(name: string, index: number): string {
  const ascii = name
    .toLowerCase()
    .replace(/\.[^.]+$/u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  return `ref-${ascii || `file-${index + 1}`}`;
}

export function validateTaskAttachments(
  attachments: ReadonlyArray<{ name: string; content: string }>,
): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(
      `ATTACHMENT_LIMIT_EXCEEDED: 单个任务最多附加 ${MAX_ATTACHMENTS_PER_TASK} 份参考文件。`,
    );
  }
  let totalBytes = 0;
  for (const att of attachments) {
    const byteLen = Buffer.byteLength(att.content, 'utf8');
    if (byteLen > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `ATTACHMENT_TOO_LARGE: 附件 '${att.name}' 超过单文件上限（256 KB）。`,
      );
    }
    totalBytes += byteLen;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `ATTACHMENT_TOTAL_EXCEEDED: 附件总大小超过上限（1 MB）。`,
      );
    }
    const findings = scanTextForSecrets(att.content, `attachment/${att.name}`);
    if (findings.length > 0) {
      throw new Error(
        `ATTACHMENT_SECRET_DETECTED: 附件 '${att.name}' 含敏感凭据（${findings.map((f) => f.ruleId).join(',')}），已拦截。`,
      );
    }
  }
}

export function createContextManager(
  options: CreateContextManagerOptions,
): ContextManager {
  const { db, writeQueue, repoPath } = options;

  function readManagedText(relativePath: string): string {
    const abs = resolveSafeTekonPath(repoPath, relativePath);
    if (!existsSync(abs)) {
      throw new Error(`FILE_NOT_FOUND: ${relativePath}`);
    }
    return readFileSync(abs, 'utf8');
  }

  function listGeneralEntries(runId: string): ContextGeneralEntry[] {
    const rows = db
      .prepare(
        `select id, node_id, kind, content, status, created_at
         from task_context_entries
         where run_id = ?
         order by created_at asc, id asc`,
      )
      .all(runId) as Array<{
      id: string;
      node_id: string | null;
      kind: ContextGeneralEntry['kind'];
      content: string;
      status: ContextGeneralEntry['status'];
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind,
      content: r.content,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  function listArchives(runId: string): ContextArchiveEntry[] {
    const rows = db
      .prepare(
        `select id, node_id, kind, title, summary, file_path, byte_size, mounted, created_at
         from context_archives
         where run_id = ?
         order by created_at desc, id desc`,
      )
      .all(runId) as Array<{
      id: string;
      node_id: string | null;
      kind: ContextArchiveEntry['kind'];
      title: string;
      summary: string | null;
      file_path: string;
      byte_size: number;
      mounted: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind,
      title: r.title,
      summary: r.summary ?? '',
      filePath: r.file_path,
      byteSize: r.byte_size,
      mounted: Boolean(r.mounted),
      createdAt: r.created_at,
    }));
  }

  function listRawArtifactsAndAttachments(runId: string): Array<{
    id: string;
    source: 'artifact' | 'attachment';
    runId: string;
    nodeId: string | null;
    docKey: string;
    title: string;
    version: number;
    path: string;
    summary: string;
    pinned: boolean;
    archived: boolean;
    sizeBytes: number;
    createdAt: string;
  }> {
    const artRows = db
      .prepare(
        `select id, run_id, node_id, type, version, path, size_bytes, summary,
                doc_key, title, pinned, archived, created_at
         from artifacts
         where run_id = ?
         order by created_at asc, version asc`,
      )
      .all(runId) as Array<{
      id: string;
      run_id: string;
      node_id: string;
      type: string;
      version: number;
      path: string;
      size_bytes: number;
      summary: string | null;
      doc_key: string | null;
      title: string | null;
      pinned: number | null;
      archived: number | null;
      created_at: string;
    }>;

    const attRows = db
      .prepare(
        `select id, run_id, doc_key, title, file_path, size_bytes, pinned, created_at
         from task_attachments
         where run_id = ?
         order by created_at asc`,
      )
      .all(runId) as Array<{
      id: string;
      run_id: string;
      doc_key: string;
      title: string;
      file_path: string;
      size_bytes: number;
      pinned: number;
      created_at: string;
    }>;

    return [
      ...attRows.map((r) => ({
        id: r.id,
        source: 'attachment' as const,
        runId: r.run_id,
        nodeId: null,
        docKey: r.doc_key,
        title: r.title,
        version: 1,
        path: r.file_path,
        summary: `参考附件 · ${r.title}`,
        pinned: Boolean(r.pinned),
        archived: false,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
      })),
      ...artRows.map((r) => ({
        id: r.id,
        source: 'artifact' as const,
        runId: r.run_id,
        nodeId: r.node_id,
        docKey: r.doc_key ?? r.type,
        title: r.title ?? r.doc_key ?? r.type,
        version: r.version,
        path: r.path,
        summary: r.summary ?? '',
        pinned: Boolean(r.pinned),
        archived: Boolean(r.archived),
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
      })),
    ];
  }

  function listRunDocuments(runId: string): SolidifiedDocumentItem[] {
    const raw = listRawArtifactsAndAttachments(runId);
    const versionsByKey = new Map<string, number[]>();
    const latestByKey = new Map<string, (typeof raw)[number]>();

    for (const item of raw) {
      const list = versionsByKey.get(item.docKey) ?? [];
      if (!list.includes(item.version)) list.push(item.version);
      list.sort((a, b) => a - b);
      versionsByKey.set(item.docKey, list);

      const prev = latestByKey.get(item.docKey);
      if (!prev || item.version >= prev.version) {
        latestByKey.set(item.docKey, item);
      }
    }

    const docs: SolidifiedDocumentItem[] = [];
    for (const [docKey, item] of latestByKey.entries()) {
      docs.push({
        id: item.id,
        source: item.source,
        runId: item.runId,
        nodeId: item.nodeId,
        docKey,
        title: item.title,
        version: item.version,
        summary: item.summary,
        pinned: item.pinned,
        archived: item.archived,
        sizeBytes: item.sizeBytes,
        createdAt: item.createdAt,
        versions: versionsByKey.get(docKey) ?? [item.version],
      });
    }

    return docs.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  function getRoleSession(runId: string, roleId: string) {
    const row = db
      .prepare(
        `select driver, provider_thread_id, anchor_node_id, reuse_mode, window_tokens, window_limit
         from role_sessions
         where run_id = ? and role_id = ?`,
      )
      .get(runId, roleId) as
      | {
          driver: string;
          provider_thread_id: string | null;
          anchor_node_id: string | null;
          reuse_mode: 'reuse' | 'reset';
          window_tokens: number;
          window_limit: number;
        }
      | undefined;
    if (!row) return null;
    return {
      driver: row.driver,
      providerThreadId: row.provider_thread_id ?? undefined,
      anchorNodeId: row.anchor_node_id ?? undefined,
      reuseMode: row.reuse_mode,
      windowTokens: row.window_tokens,
      windowLimit: row.window_limit,
    };
  }

  return {
    async addTaskAttachments(runId, attachments) {
      if (attachments.length === 0) return [];
      if (attachments.length > MAX_ATTACHMENTS_PER_TASK) {
        throw new Error(
          `ATTACHMENT_LIMIT_EXCEEDED: 单个任务最多附加 ${MAX_ATTACHMENTS_PER_TASK} 份参考文件。`,
        );
      }
      const runSeg = safeSegment(runId);
      let totalBytes = 0;
      const prepared: Array<{
        id: string;
        docKey: string;
        title: string;
        relativePath: string;
        content: string;
        sha256: string;
        sizeBytes: number;
        createdAt: string;
      }> = [];

      const usedKeys = new Set<string>();
      for (let i = 0; i < attachments.length; i += 1) {
        const att = attachments[i]!;
        const byteLen = Buffer.byteLength(att.content, 'utf8');
        if (byteLen > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `ATTACHMENT_TOO_LARGE: 附件 '${att.name}' 超过单文件上限（256 KB）。`,
          );
        }
        totalBytes += byteLen;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(
            `ATTACHMENT_TOTAL_EXCEEDED: 附件总大小超过上限（1 MB）。`,
          );
        }
        const findings = scanTextForSecrets(att.content, `attachment/${att.name}`);
        if (findings.length > 0) {
          throw new Error(
            `ATTACHMENT_SECRET_DETECTED: 附件 '${att.name}' 含敏感凭据（${findings.map((f) => f.ruleId).join(',')}），已拦截。`,
          );
        }
        let docKey = slugifyAttachmentName(att.name, i);
        while (usedKeys.has(docKey)) {
          docKey = `${docKey}-${i + 1}`;
        }
        usedKeys.add(docKey);
        const relativePath = `.tekon/runs/${runSeg}/attachments/${docKey}.md`;
        prepared.push({
          id: `att_${randomUUID()}`,
          docKey,
          title: att.name.trim() || `参考文件 ${i + 1}`,
          relativePath,
          content: att.content,
          sha256: createHash('sha256').update(att.content).digest('hex'),
          sizeBytes: byteLen,
          createdAt: new Date().toISOString(),
        });
      }

      for (const item of prepared) {
        const abs = resolveSafeTekonPath(repoPath, item.relativePath);
        writeFileAtomically(abs, item.content);
      }

      await writeQueue.enqueue(() => {
        const stmt = db.prepare(
          `insert into task_attachments (
             id, run_id, doc_key, title, file_path, sha256, size_bytes, pinned, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        );
        for (const item of prepared) {
          stmt.run(
            item.id,
            runId,
            item.docKey,
            item.title,
            item.relativePath,
            item.sha256,
            item.sizeBytes,
            item.createdAt,
          );
        }
      });

      return prepared.map((p) => ({
        id: p.id,
        source: 'attachment',
        runId,
        nodeId: null,
        docKey: p.docKey,
        title: p.title,
        version: 1,
        summary: `参考附件 · ${p.title}`,
        pinned: true,
        archived: false,
        sizeBytes: p.sizeBytes,
        createdAt: p.createdAt,
        versions: [1],
      }));
    },

    async appendGeneralEntry(input) {
      const entry: ContextGeneralEntry = {
        id: `ctx_${randomUUID()}`,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        content: input.content.trim(),
        status: input.status ?? 'active',
        createdAt: new Date().toISOString(),
      };
      await writeQueue.enqueue(() => {
        db.prepare(
          `insert into task_context_entries (id, run_id, node_id, kind, content, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          input.runId,
          entry.nodeId,
          entry.kind,
          entry.content,
          entry.status,
          entry.createdAt,
        );
      });
      return entry;
    },

    async activateQueuedConstraints(runId) {
      return writeQueue.enqueue(() => {
        const res = db
          .prepare(
            `update task_context_entries
             set status = 'active'
             where run_id = ? and status = 'queued_next'`,
          )
          .run(runId);
        return res.changes;
      });
    },

    listGeneralEntries,

    async upsertRoleSession(input) {
      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        const existing = db
          .prepare(
            `select id, provider_thread_id, anchor_node_id, reuse_mode, window_tokens, window_limit
             from role_sessions where run_id = ? and role_id = ?`,
          )
          .get(input.runId, input.roleId) as
          | {
              id: string;
              provider_thread_id: string | null;
              anchor_node_id: string | null;
              reuse_mode: 'reuse' | 'reset';
              window_tokens: number;
              window_limit: number;
            }
          | undefined;

        if (existing) {
          db.prepare(
            `update role_sessions
             set driver = ?,
                 provider_thread_id = ?,
                 anchor_node_id = ?,
                 reuse_mode = ?,
                 window_tokens = ?,
                 window_limit = ?,
                 updated_at = ?
             where id = ?`,
          ).run(
            input.driver,
            input.providerThreadId !== undefined
              ? input.providerThreadId
              : existing.provider_thread_id,
            input.anchorNodeId !== undefined
              ? input.anchorNodeId
              : existing.anchor_node_id,
            input.reuseMode ?? existing.reuse_mode,
            input.windowTokens ?? existing.window_tokens,
            input.windowLimit ?? existing.window_limit,
            now,
            existing.id,
          );
        } else {
          db.prepare(
            `insert into role_sessions (
               id, run_id, role_id, driver, provider_thread_id, anchor_node_id,
               reuse_mode, window_tokens, window_limit, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `rs_${randomUUID()}`,
            input.runId,
            input.roleId,
            input.driver,
            input.providerThreadId ?? null,
            input.anchorNodeId ?? null,
            input.reuseMode ?? 'reuse',
            input.windowTokens ?? 0,
            input.windowLimit ?? 200_000,
            now,
          );
        }
      });
    },

    async setRoleSessionReuseMode(runId, roleId, reuseMode) {
      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        const res = db
          .prepare(
            `update role_sessions set reuse_mode = ?, updated_at = ?
             where run_id = ? and role_id = ?`,
          )
          .run(reuseMode, now, runId, roleId);
        if (res.changes === 0) {
          db.prepare(
            `insert into role_sessions (
               id, run_id, role_id, driver, reuse_mode, window_tokens, window_limit, updated_at
             ) values (?, ?, ?, 'unknown', ?, 0, 200000, ?)`,
          ).run(`rs_${randomUUID()}`, runId, roleId, reuseMode, now);
        }
      });
    },

    getRoleSession,

    async recordArchive(input) {
      const runSeg = safeSegment(input.runId);
      const id = `arc_${randomUUID()}`;
      const relativePath = `.tekon/runs/${runSeg}/archives/${id}.md`;
      const abs = resolveSafeTekonPath(repoPath, relativePath);
      writeFileAtomically(abs, input.content);
      const byteSize = statSync(abs).size;
      const createdAt = new Date().toISOString();
      await writeQueue.enqueue(() => {
        db.prepare(
          `insert into context_archives (
             id, run_id, node_id, kind, title, summary, file_path, byte_size, mounted, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          id,
          input.runId,
          input.nodeId ?? null,
          input.kind,
          input.title,
          input.summary,
          relativePath,
          byteSize,
          createdAt,
        );
      });
      return {
        id,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        filePath: relativePath,
        byteSize,
        mounted: false,
        createdAt,
      };
    },

    listArchives,

    getArchiveContent(runId, archiveId) {
      const row = db
        .prepare(
          `select id, node_id, kind, title, summary, file_path, byte_size, mounted, created_at
           from context_archives where id = ? and run_id = ?`,
        )
        .get(archiveId, runId) as
        | {
            id: string;
            node_id: string | null;
            kind: ContextArchiveEntry['kind'];
            title: string;
            summary: string | null;
            file_path: string;
            byte_size: number;
            mounted: number;
            created_at: string;
          }
        | undefined;
      if (!row) {
        throw new Error(`ARCHIVE_NOT_FOUND: 归档项 '${archiveId}' 不存在。`);
      }
      const content = readManagedText(row.file_path);
      return {
        archive: {
          id: row.id,
          nodeId: row.node_id,
          kind: row.kind,
          title: row.title,
          summary: row.summary ?? '',
          filePath: row.file_path,
          byteSize: row.byte_size,
          mounted: Boolean(row.mounted),
          createdAt: row.created_at,
        },
        content,
      };
    },

    async toggleArchiveMount(runId, archiveId) {
      const existing = listArchives(runId).find((a) => a.id === archiveId);
      if (!existing) {
        throw new Error(`ARCHIVE_NOT_FOUND: 归档项 '${archiveId}' 不存在。`);
      }
      const nextMounted = !existing.mounted;
      await writeQueue.enqueue(() => {
        db.prepare(
          `update context_archives set mounted = ? where id = ? and run_id = ?`,
        ).run(nextMounted ? 1 : 0, archiveId, runId);
      });
      return { ...existing, mounted: nextMounted };
    },

    async compactContext(runId) {
      const entries = listGeneralEntries(runId).filter(
        (e) =>
          e.status === 'active' &&
          e.kind !== 'goal' &&
          e.kind !== 'compaction_summary',
      );
      // Preserve the 2 most recent non-goal entries + all goals & pinned docs
      const toCompact =
        entries.length > 2 ? entries.slice(0, entries.length - 2) : [];
      const snapshotText =
        toCompact.length > 0
          ? toCompact
              .map((e) => `## [${e.kind}] ${e.createdAt}\n${e.content}`)
              .join('\n\n---\n\n')
          : '当前无早期轮次可压缩，已记录活跃上下文检查点。';

      const archive = await this.recordArchive({
        runId,
        kind: 'compacted_history',
        title: `压缩前历史快照 (${toCompact.length} 条)`,
        summary: snapshotText.slice(0, 180),
        content: snapshotText,
      });

      const anchoredSummary =
        toCompact.length > 0
          ? `已压缩 ${toCompact.length} 条早期交互（原文留档于「${archive.title}」）：\n` +
            toCompact
              .map((e) => `- ${e.content.split(/\r?\n/u)[0]?.slice(0, 140) ?? ''}`)
              .join('\n')
          : '已执行锚定压缩（保留任务目标、固定文档与最近轮次）。';

      await writeQueue.enqueue(() => {
        for (const item of toCompact) {
          db.prepare(
            `update task_context_entries set status = 'compacted' where id = ?`,
          ).run(item.id);
        }
        db.prepare(
          `insert into task_context_entries (id, run_id, node_id, kind, content, status, created_at)
           values (?, ?, null, 'compaction_summary', ?, 'active', ?)`,
        ).run(
          `ctx_${randomUUID()}`,
          runId,
          anchoredSummary,
          new Date().toISOString(),
        );
        // Reduce tracked active window usage after compaction
        db.prepare(
          `update role_sessions
           set window_tokens = cast(window_tokens * 0.4 as integer),
               updated_at = ?
           where run_id = ?`,
        ).run(new Date().toISOString(), runId);
      });

      const sessionRows = db
        .prepare(
          `select window_tokens, window_limit from role_sessions where run_id = ?`,
        )
        .all(runId) as Array<{ window_tokens: number; window_limit: number }>;
      const maxWindowPercent = sessionRows.reduce((maxPct, r) => {
        const pct = Math.min(
          100,
          Math.round((r.window_tokens / Math.max(1, r.window_limit)) * 100),
        );
        return Math.max(maxPct, pct);
      }, 0);

      return {
        compactedCount: toCompact.length,
        archive,
        windowPercent: maxWindowPercent,
      };
    },

    listRunDocuments,

    getDocumentContent(runId, docIdOrKey, version) {
      const raw = listRawArtifactsAndAttachments(runId);
      let match = raw.find((r) => r.id === docIdOrKey);
      if (!match) {
        const candidates = raw.filter((r) => r.docKey === docIdOrKey);
        if (version !== undefined) {
          match = candidates.find((c) => c.version === version);
        } else {
          match = candidates.sort((a, b) => b.version - a.version)[0];
        }
      }
      if (!match) {
        throw new Error(`DOCUMENT_NOT_FOUND: 未找到文档 '${docIdOrKey}'。`);
      }
      const versions = raw
        .filter((r) => r.docKey === match!.docKey)
        .map((r) => r.version)
        .sort((a, b) => a - b);
      const content = readManagedText(match.path);
      return {
        document: {
          id: match.id,
          source: match.source,
          runId: match.runId,
          nodeId: match.nodeId,
          docKey: match.docKey,
          title: match.title,
          version: match.version,
          summary: match.summary,
          pinned: match.pinned,
          archived: match.archived,
          sizeBytes: match.sizeBytes,
          createdAt: match.createdAt,
          versions,
        },
        content,
      };
    },

    async toggleDocumentPin(runId, docId) {
      const raw = listRawArtifactsAndAttachments(runId);
      const match = raw.find((r) => r.id === docId);
      if (!match) {
        throw new Error(`DOCUMENT_NOT_FOUND: 未找到文档 '${docId}'。`);
      }
      const nextPinned = !match.pinned;
      await writeQueue.enqueue(() => {
        if (match.source === 'attachment') {
          db.prepare(
            `update task_attachments set pinned = ? where id = ? and run_id = ?`,
          ).run(nextPinned ? 1 : 0, docId, runId);
        } else {
          // Pin applies per docKey family across versions
          db.prepare(
            `update artifacts set pinned = ?
             where run_id = ? and (id = ? or doc_key = ?)`,
          ).run(nextPinned ? 1 : 0, runId, docId, match.docKey);
        }
      });
      const updated = listRunDocuments(runId).find(
        (d) => d.docKey === match.docKey,
      );
      if (!updated) {
        throw new Error(`DOCUMENT_NOT_FOUND: '${docId}'`);
      }
      return updated;
    },

    diffDocuments(runId, docKey, fromVersion, toVersion) {
      const from = this.getDocumentContent(runId, docKey, fromVersion);
      const to = this.getDocumentContent(runId, docKey, toVersion);
      return computeLineDiff(from.content, to.content, fromVersion, toVersion);
    },

    exportDocument(runId, docId) {
      const { document, content } = this.getDocumentContent(runId, docId);
      return {
        filename: sanitizeExportFilename(document.title, document.version),
        content,
      };
    },

    async promoteHandoffToDocument(input) {
      const handoff = listGeneralEntries(input.runId)
        .filter((e) => e.kind === 'handoff' && e.nodeId === input.nodeId)
        .at(-1);
      if (!handoff) {
        throw new Error(
          `HANDOFF_NOT_FOUND: 节点 '${input.nodeId}' 尚无交接摘要可转为固化文档。`,
        );
      }
      const runSeg = safeSegment(input.runId);
      const nodeSeg = safeSegment(input.nodeId);
      const docKey = `handoff-${nodeSeg.toLowerCase().replace(/[^a-z0-9-]/gu, '-')}`;
      const existing = listRawArtifactsAndAttachments(input.runId).filter(
        (r) => r.docKey === docKey,
      );
      const version =
        existing.reduce((max, r) => Math.max(max, r.version), 0) + 1;
      const relativePath = `.tekon/runs/${runSeg}/artifacts/${nodeSeg}/${docKey}.v${version}.md`;
      const abs = resolveSafeTekonPath(repoPath, relativePath);
      const content = `# ${input.title?.trim() || `节点结论 (${input.nodeId})`}\n\n${handoff.content}\n`;
      const findings = scanTextForSecrets(content, relativePath);
      if (findings.length > 0) {
        throw new Error(
          `artifact contains sensitive content: ${findings.map((f) => f.ruleId).join(',')}`,
        );
      }
      writeFileAtomically(abs, content);
      const id = `artifact_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const sizeBytes = statSync(abs).size;
      const sha256 = createHash('sha256').update(content).digest('hex');
      const title = input.title?.trim() || `节点结论 (${input.nodeId})`;
      await writeQueue.enqueue(() => {
        db.prepare(
          `insert into artifacts (
             id, run_id, node_id, type, version, path, sha256, size_bytes, summary,
             doc_key, title, pinned, archived, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        ).run(
          id,
          input.runId,
          input.nodeId,
          docKey,
          version,
          relativePath,
          sha256,
          sizeBytes,
          handoff.content.slice(0, 200),
          docKey,
          title,
          createdAt,
        );
      });
      return listRunDocuments(input.runId).find((d) => d.docKey === docKey)!;
    },

    inspectNodeContext(input) {
      const nodes = db
        .prepare(
          `select id, name, role, status, resolved_driver, resolved_model, resolved_effort,
                  frozen_role_json, context_mode, node_order, token_input, token_cached
           from nodes
           where run_id = ?
           order by node_order asc, id asc`,
        )
        .all(input.runId) as Array<{
        id: string;
        name: string | null;
        role: string;
        status: string;
        resolved_driver: string | null;
        resolved_model: string | null;
        resolved_effort: string | null;
        frozen_role_json: string | null;
        context_mode: NodeContextMode | null;
        node_order: number;
        token_input: number | null;
        token_cached: number | null;
      }>;

      const nodeIndex = nodes.findIndex((n) => n.id === input.nodeId);
      if (nodeIndex < 0) {
        throw new Error(`NODE_NOT_FOUND: 节点 '${input.nodeId}' 不存在。`);
      }
      const node = nodes[nodeIndex]!;
      const previousNode = nodeIndex > 0 ? nodes[nodeIndex - 1]! : null;

      let roleIsolated = node.role === 'reviewer';
      if (node.frozen_role_json) {
        try {
          const frozen = JSON.parse(node.frozen_role_json) as {
            isolated?: boolean;
          };
          if (typeof frozen.isolated === 'boolean') {
            roleIsolated = frozen.isolated;
          }
        } catch {
          // ignore malformed frozen role json
        }
      }

      // Find earlier node with the same role for reuse anchor
      let sameRoleAnchor:
        | {
            nodeId: string;
            nodeOrder: number;
            providerThreadId?: string;
            reuseMode: 'reuse' | 'reset';
            cacheReusePercent?: number;
            windowTokens: number;
            windowLimit: number;
          }
        | undefined;

      for (let i = nodeIndex - 1; i >= 0; i -= 1) {
        if (nodes[i]!.role === node.role) {
          const rs = getRoleSession(input.runId, node.role);
          const sameDriver = !rs?.driver || !node.resolved_driver || rs.driver === node.resolved_driver;
          const cacheReusePercent =
            node.token_input && node.token_input > 0 && node.token_cached != null
              ? Math.round((node.token_cached / node.token_input) * 100)
              : undefined;
          sameRoleAnchor = {
            nodeId: nodes[i]!.id,
            nodeOrder: i + 1,
            providerThreadId: sameDriver ? rs?.providerThreadId : undefined,
            reuseMode: sameDriver ? (rs?.reuseMode ?? 'reuse') : 'reset',
            cacheReusePercent,
            windowTokens: rs?.windowTokens ?? node.token_input ?? 0,
            windowLimit: rs?.windowLimit ?? 200_000,
          };
          break;
        }
      }

      // Only documents produced BEFORE this node (or attachments with nodeId === null)
      const priorNodeIds = new Set(nodes.slice(0, nodeIndex).map((n) => n.id));
      const allRawDocs = listRawArtifactsAndAttachments(input.runId).filter(
        (d) => d.nodeId === null || priorNodeIds.has(d.nodeId),
      );
      const latestMap = new Map<string, (typeof allRawDocs)[number]>();
      for (const d of allRawDocs) {
        const prev = latestMap.get(d.docKey);
        if (!prev || d.version >= prev.version) latestMap.set(d.docKey, d);
      }

      const allLatestDocs = [...latestMap.values()].map((d) => ({
        id: d.id,
        docKey: d.docKey,
        title: d.title,
        version: d.version,
        sourceNodeId: d.nodeId,
        pinned: d.pinned,
        summary: d.summary,
        content: existsSync(resolveSafeTekonPath(repoPath, d.path))
          ? readManagedText(d.path)
          : d.summary,
      }));

      const archives = listArchives(input.runId).map((a) => ({
        ...a,
        ...(a.mounted
          ? {
              content: existsSync(resolveSafeTekonPath(repoPath, a.filePath))
                ? readManagedText(a.filePath)
                : a.summary,
            }
          : {}),
      }));

      const rsSelf = getRoleSession(input.runId, node.role);

      return buildNodeContextPackage({
        runId: input.runId,
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeIndex,
        roleId: node.role,
        driver: node.resolved_driver ?? 'claude-code',
        model: node.resolved_model ?? 'default',
        effort: node.resolved_effort ?? 'default',
        contextMode: node.context_mode ?? 'auto',
        roleIsolated,
        previousNodeId: previousNode?.id ?? null,
        sameRoleAnchor,
        generalEntries: listGeneralEntries(input.runId),
        allLatestDocs,
        archives,
        windowTokens: rsSelf?.windowTokens ?? node.token_input ?? 0,
        windowLimit: rsSelf?.windowLimit ?? 200_000,
      });
    },

    getPreferences() {
      const rows = db
        .prepare('select key, value_json from user_preferences')
        .all() as Array<{ key: string; value_json: string }>;
      const merged: WorkbenchPreferences = { ...DEFAULT_WORKBENCH_PREFERENCES };
      for (const row of rows) {
        try {
          const val = JSON.parse(row.value_json);
          if (row.key in merged) {
            (merged as unknown as Record<string, unknown>)[row.key] = val;
          }
        } catch {
          // ignore malformed preference entry
        }
      }
      return merged;
    },

    async updatePreferences(patch) {
      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        const stmt = db.prepare(
          `insert into user_preferences (key, value_json, updated_at)
           values (?, ?, ?)
           on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
        );
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined && k in DEFAULT_WORKBENCH_PREFERENCES) {
            stmt.run(k, JSON.stringify(v), now);
          }
        }
      });
      return this.getPreferences();
    },

    async recordFollowUpTurn(input) {
      const record: FollowUpTurnRecord = {
        id: `fu_${randomUUID()}`,
        runId: input.runId,
        roleId: input.roleId,
        driver: input.driver,
        model: input.model ?? null,
        userText: input.userText,
        assistantText: input.assistantText,
        createdAt: new Date().toISOString(),
      };
      await writeQueue.enqueue(() => {
        db.prepare(
          `insert into follow_up_turns (
             id, run_id, role_id, driver, model, user_text, assistant_text, created_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.id,
          record.runId,
          record.roleId,
          record.driver,
          record.model,
          record.userText,
          record.assistantText,
          record.createdAt,
        );
      });
      return record;
    },

    listFollowUpTurns(runId) {
      const rows = db
        .prepare(
          `select id, run_id, role_id, driver, model, user_text, assistant_text, created_at
           from follow_up_turns
           where run_id = ?
           order by created_at asc, id asc`,
        )
        .all(runId) as Array<{
        id: string;
        run_id: string;
        role_id: string;
        driver: string;
        model: string | null;
        user_text: string;
        assistant_text: string;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        roleId: r.role_id,
        driver: r.driver,
        model: r.model,
        userText: r.user_text,
        assistantText: r.assistant_text,
        createdAt: r.created_at,
      }));
    },
  };
}
