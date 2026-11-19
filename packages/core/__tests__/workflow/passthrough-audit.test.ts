import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createAuditLogger } from '../../src/audit/logger.js';
import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createMockAgentAdapter } from '../../src/runtime/mock-agent-adapter.js';
import { createWorkflowEngine } from '../../src/workflow/engine.js';
import { parseWorkflowTemplate } from '../../src/workflow/template.js';

it('records passthrough variable names (not values) when a run starts and resumes', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-passthrough-audit-'));
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  let paused = true;
  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.tekon',
    repositories,
    audit,
    adapter: createMockAgentAdapter(),
    agentProvider: 'claude-code',
    agentConfigSummary: { provider: 'claude-code', passthroughEnv: ['AWS_PROFILE'] },
    isPauseRequested: () => paused,
  });
  try {
    const workflowSpec = parseWorkflowTemplate({
      id: 'one',
      name: 'One',
      phases: [{ id: 'review', nodes: [{ id: 'review-node', role: 'reviewer' }] }],
    });
    const started = await engine.startRun({
      demandText: 'record passthrough',
      mode: 'template',
      workflowSpec,
    });
    expect(started.workflow.status).toBe('paused');
    paused = false;
    await engine.resumeRun(started.runId);

    const events = await repositories.listAuditEvents(started.runId);
    const payloadOf = (type: string) => events.find((event) => event.type === type)?.payload;
    expect(payloadOf('run.started')).toMatchObject({ passthroughEnv: ['AWS_PROFILE'] });
    expect(payloadOf('run.resumed')).toMatchObject({ passthroughEnv: ['AWS_PROFILE'] });
  } finally {
    db.close();
    rmSync(repoPath, { recursive: true, force: true });
  }
});
