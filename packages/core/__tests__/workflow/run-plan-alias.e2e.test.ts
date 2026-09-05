import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import { createMockAgentAdapter } from '../../src/runtime/mock-agent-adapter.js';
import { createWorkflowEngine } from '../../src/workflow/engine.js';
import { loadWorkflowTemplateFile } from '../../src/workflow/template.js';
import { canonicalJson, projectRunPlan, projectRunPlanPreview } from '../../src/workflow/run-plan.js';

it('alias.yaml 内 id 不同的模板可预览、准备、持久化并在磁盘模板变化后恢复原计划', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-plan-alias-'));
  const db = openTekonDatabase({ filename: ':memory:' }); migrateDatabase(db);
  const repositories = createRepositories(db); const audit = createAuditLogger({ repositories });
  const mock = createMockAgentAdapter(); const runAgent = vi.fn(mock.runAgent.bind(mock));
  const path = join(repoPath, 'alias.yaml');
  writeFileSync(path, 'id: inner\nname: Alias Template\nphases:\n  - id: review\n    nodes:\n      - id: review-node\n        role: reviewer\n', 'utf8');
  const template = loadWorkflowTemplateFile(path);
  const canonicalPlan = projectRunPlan(template, { templateId: 'alias' });
  const preview = projectRunPlanPreview(canonicalPlan);
  let paused = true;
  const engine = createWorkflowEngine({ repoPath, dataDir: '.tekon', repositories, audit, adapter: { runAgent }, isPauseRequested: () => paused });
  try {
    expect(preview.templateId).toBe('alias');
    expect(template.id).toBe('inner');
    const prepared = await engine.prepareRun({ demandText: '模板别名恢复', mode: 'template', templateName: 'alias', workflowSpec: template, canonicalPlan, planSnapshot: canonicalJson(canonicalPlan), planDigest: preview.digest });
    expect(runAgent).not.toHaveBeenCalled();
    const persisted = await repositories.getWorkflowInstance(prepared.runId);
    expect(persisted?.planDigest).toBe(preview.digest);
    expect(JSON.parse(persisted!.planSnapshot!)).toMatchObject({ templateId: 'alias', template: { id: 'inner' } });
    expect((await engine.executePreparedRun(prepared.runId)).status).toBe('paused');
    writeFileSync(path, 'id: changed-on-disk\nphases: []\n', 'utf8');
    paused = false;
    const resumed = await engine.resumeRun(prepared.runId);
    expect(resumed.workflow.status).toBe('passed');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect((await repositories.listNodes(prepared.runId)).map(node => node.id)).toEqual([`${prepared.runId}_review-node`]);
    expect((await repositories.getWorkflowInstance(prepared.runId))?.planDigest).toBe(preview.digest);
  } finally {
    db.close(); rmSync(repoPath, { recursive: true, force: true });
  }
});
