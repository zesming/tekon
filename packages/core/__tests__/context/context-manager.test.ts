import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  resolveSafeTekonPath,
} from '../../src/artifact/store.js';
import {
  createContextManager,
  sanitizeExportFilename,
} from '../../src/context/context-manager.js';
import {
  buildNodeContextPackage,
  renderNodeContextPrompt,
} from '../../src/context/context-package.js';
import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createWriteQueue } from '../../src/db/write-queue.js';

const tempDirs: string[] = [];
function makeRepo(): { repoPath: string; db: ReturnType<typeof openTekonDatabase>; writeQueue: ReturnType<typeof createWriteQueue> } {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ctx-'));
  tempDirs.push(repoPath);
  const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  return { repoPath, db, writeQueue };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('context-manager and artifact-store security invariants', () => {
  it('enforces single-source-of-truth context package, private trace isolation, cross-node docKey versioning, diff, pin, compaction, and archive mount', async () => {
    const { repoPath, db, writeQueue } = makeRepo();
    try {
      const repos = createRepositories(db, writeQueue);
      const store = createArtifactStore({ repoPath, repositories: repos });
      const ctx = createContextManager({ db, writeQueue, repoPath });
      const now = new Date().toISOString();

      // Seed a 3-node workflow run
      db.prepare(`insert into demands (id, title, body, created_at) values ('d1', 'T', 'Build KG', ?)`).run(now);
      db.prepare(`insert into projects (id, name, repo_path, created_at) values ('p1', 'repo', ?, ?)`).run(repoPath, now);
      db.prepare(`insert into workflow_instances (id, project_id, demand_id, status, created_at, updated_at) values ('r1', 'p1', 'd1', 'running', ?, ?)`).run(now, now);
      db.prepare(`insert into phases (id, run_id, name, status, phase_order, created_at, updated_at) values ('ph1', 'r1', 'main', 'running', 0, ?, ?)`).run(now, now);
      const insertNode = db.prepare(
        `insert into nodes (id, run_id, phase_id, role, status, workspace, inputs, outputs, gates, dependencies, node_order, name, resolved_driver, resolved_model, resolved_effort, context_mode, created_at, updated_at)
         values (?, 'r1', 'ph1', ?, 'passed', 'none', '[]', '[]', '[]', '[]', ?, ?, 'claude-code', 'claude-sonnet-4-6', 'default', ?, ?, ?)`,
      );
      insertNode.run('n1', 'explorer', 0, '调研汇总', 'auto', now, now);
      insertNode.run('n2', 'designer', 1, '方案初稿', 'full', now, now);
      insertNode.run('n3', 'designer', 2, '方案详情', 'reuse', now, now);

      await ctx.appendGeneralEntry({ runId: 'r1', kind: 'goal', content: '研究知识图谱架构' });
      await ctx.appendGeneralEntry({ runId: 'r1', nodeId: 'n1', kind: 'handoff', content: '调研完成：推荐 SCIP + 分层摘要' });
      await ctx.addTaskAttachments('r1', [{ name: 'internal-infra.md', content: '内部已有千万级图数据库' }]);

      // Cross-node docKey versioning: n2 writes proposal v1, n3 writes proposal v2
      const a1 = await store.writeArtifact({
        runId: 'r1',
        nodeId: 'n1',
        type: 'research-report',
        docKey: 'research-report',
        title: '调研报告',
        content: '# 调研\nSCIP 方案',
      });
      const p1 = await store.writeArtifact({
        runId: 'r1',
        nodeId: 'n2',
        type: 'proposal',
        docKey: 'proposal',
        title: '架构方案初稿',
        content: '单仓夜间全量重建\n基础查询层',
      });
      expect(p1.version).toBe(1);

      const privateArc = await ctx.recordArchive({
        runId: 'r1',
        nodeId: 'n1',
        kind: 'private_trace',
        title: '节点 1 检索日志',
        summary: '18 条检索',
        content: 'PRIVATE_RAW_TRACE_LINE_NEVER_LEAK',
      });

      // Inspect node 3 before running: private trace must NOT be in prompt; n1 doc is index, n2 doc + attachment are full
      const pkgBeforeMount = ctx.inspectNodeContext({ runId: 'r1', nodeId: 'n3' });
      expect(pkgBeforeMount.isolatedArchives.map((a) => a.id)).toContain(privateArc.id);
      expect(pkgBeforeMount.mountedArchives).toHaveLength(0);
      expect(pkgBeforeMount.documents.find((d) => d.docKey === 'research-report')?.delivery).toBe('index');
      expect(pkgBeforeMount.documents.find((d) => d.docKey === 'proposal')?.delivery).toBe('full');
      expect(pkgBeforeMount.documents.find((d) => d.docKey === 'ref-internal-infra')?.delivery).toBe('full');

      const promptBefore = renderNodeContextPrompt({ pkg: pkgBeforeMount, systemPrompt: '设计架构' });
      expect(promptBefore).not.toContain('PRIVATE_RAW_TRACE_LINE_NEVER_LEAK');
      expect(promptBefore).toContain('内部已有千万级图数据库');

      // Pin research-report -> now delivered in full!
      const pinnedDoc = await ctx.toggleDocumentPin('r1', a1.id);
      expect(pinnedDoc.pinned).toBe(true);
      const pkgAfterPin = ctx.inspectNodeContext({ runId: 'r1', nodeId: 'n3' });
      expect(pkgAfterPin.documents.find((d) => d.docKey === 'research-report')?.delivery).toBe('full');

      // Mount private archive -> now explicitly included in prompt
      await ctx.toggleArchiveMount('r1', privateArc.id);
      const pkgMounted = ctx.inspectNodeContext({ runId: 'r1', nodeId: 'n3' });
      const promptMounted = renderNodeContextPrompt({ pkg: pkgMounted, systemPrompt: '设计架构' });
      expect(promptMounted).toContain('PRIVATE_RAW_TRACE_LINE_NEVER_LEAK');

      // n3 writes proposal v2 (cross-node version increment!) and diff works
      const p2 = await store.writeArtifact({
        runId: 'r1',
        nodeId: 'n3',
        type: 'proposal',
        docKey: 'proposal',
        title: '方案详情',
        content: '跨仓增量 SCIP 管道\n基础查询层\nAgent 子图契约',
      });
      expect(p2.version).toBe(2);
      const diff = ctx.diffDocuments('r1', 'proposal', 1, 2);
      expect(diff.removedCount).toBe(1);
      expect(diff.addedCount).toBe(2);

      // Promote handoff to solidified doc + safe export filename
      const promoted = await ctx.promoteHandoffToDocument({ runId: 'r1', nodeId: 'n1', title: '../evil/调研结论:v1' });
      expect(promoted.docKey).toBe('handoff-n1');
      const exported = ctx.exportDocument('r1', promoted.id);
      expect(exported.filename).not.toContain('/');
      expect(exported.filename).not.toContain('..');
      expect(sanitizeExportFilename('../a/b:c', 2)).toBe('-a-b-c-v2.md');
      expect(sanitizeExportFilename('evil\r\nheader', 1)).not.toMatch(/[\r\n]/u);

      // Explicit reset override wins even when template declares contextMode='reuse'
      const reusedNode = buildNodeContextPackage({
        runId: 'r1',
        nodeId: 'n4',
        nodeName: '终稿',
        nodeIndex: 3,
        previousNodeId: 'n3',
        roleId: 'designer',
        driver: 'claude-code',
        model: 'claude-sonnet-4-6',
        effort: 'default',
        contextMode: 'reuse',
        roleIsolated: false,
        sameRoleAnchor: {
          nodeId: 'n2',
          nodeOrder: 2,
          providerThreadId: 'th_old',
          reuseMode: 'reset',
          windowTokens: 5000,
          windowLimit: 200_000,
        },
        generalEntries: [],
        allLatestDocs: [],
        archives: [],
      });
      expect(reusedNode.session.mode).toBe('reset');
      expect(reusedNode.session.providerThreadId).toBeUndefined();

      // Anchored compaction preserves goal & recent 2 non-goal entries & computes real windowPercent
      await ctx.appendGeneralEntry({ runId: 'r1', kind: 'constraint', content: '约束 A' });
      await ctx.appendGeneralEntry({ runId: 'r1', kind: 'constraint', content: '约束 B' });
      await ctx.appendGeneralEntry({ runId: 'r1', kind: 'constraint', content: '约束 C' });
      const compacted = await ctx.compactContext('r1');
      expect(compacted.compactedCount).toBeGreaterThan(0);
      expect(ctx.getArchiveContent('r1', compacted.archive.id).content).toContain('调研完成');
      expect(ctx.listGeneralEntries('r1').some((e) => e.kind === 'goal' && e.status === 'active')).toBe(true);
      // When <= 2 active non-goal entries remain, compacting again preserves them (compactedCount === 0)
      const secondCompact = await ctx.compactContext('r1');
      expect(secondCompact.compactedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects path traversal, out-of-repo symlinks, and secret-bearing attachments', async () => {
    const { repoPath, db, writeQueue } = makeRepo();
    const outsideDir = mkdtempSync(join(tmpdir(), 'tekon-outside-'));
    tempDirs.push(outsideDir);
    const outsideFile = join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'TOP_SECRET', 'utf8');
    mkdirSync(join(repoPath, '.tekon', 'runs', 'r1', 'archives'), { recursive: true });
    symlinkSync(outsideFile, join(repoPath, '.tekon', 'runs', 'r1', 'archives', 'escape.md'));

    try {
      expect(() => resolveSafeTekonPath(repoPath, '../outside.md')).toThrow(/escapes/u);
      expect(() =>
        resolveSafeTekonPath(repoPath, '.tekon/runs/r1/archives/escape.md'),
      ).toThrow(/symlink/u);

      const ctx = createContextManager({ db, writeQueue, repoPath });
      const now = new Date().toISOString();
      db.prepare(`insert into demands (id, title, body, created_at) values ('d1', 'T', 'B', ?)`).run(now);
      db.prepare(`insert into projects (id, name, repo_path, created_at) values ('p1', 'repo', ?, ?)`).run(repoPath, now);
      db.prepare(`insert into workflow_instances (id, project_id, demand_id, status, created_at, updated_at) values ('r1', 'p1', 'd1', 'running', ?, ?)`).run(now, now);

      await expect(
        ctx.addTaskAttachments('r1', [
          { name: 'creds.env', content: 'GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef1234' },
        ]),
      ).rejects.toThrow(/ATTACHMENT_SECRET_DETECTED/u);
    } finally {
      db.close();
    }
  });
});
