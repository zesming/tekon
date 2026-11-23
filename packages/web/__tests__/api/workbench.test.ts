import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderAdapterResolver,
  openTekonDatabase,
  type AgentAdapter,
  type AgentDiscoveryRegistry,
  type AgentDiscoverySnapshot,
  type ProviderAdapterResolver,
} from '@tekon/core';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer, type RunningWebServer } from '../../src/server/http.js';
import { workbenchProcedureSpecs } from '../../src/shared/workbench-contract.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function createStubDiscovery(ready = true): AgentDiscoveryRegistry {
  const snapshot: AgentDiscoverySnapshot = {
    probedAt: '2026-11-20T12:00:00.000Z',
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        iconKey: 'claude',
        status: ready ? 'ready' : 'unauthenticated',
        authKind: 'oauth-token',
        loginHint: 'claude auth login',
        models: ['sonnet', 'opus', 'haiku'],
        efforts: ['low', 'medium', 'high', 'max'],
        source: 'built-in',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        iconKey: 'codex',
        status: ready ? 'ready' : 'not_installed',
        authKind: 'oauth-token',
        installHint: 'npm i -g @openai/codex',
        models: ['gpt-5.4', 'o3'],
        efforts: ['medium', 'high', 'xhigh'],
        source: 'built-in',
      },
    ],
  };
  return {
    getSnapshot: async () => snapshot,
    refresh: async () => ({ ...snapshot, probedAt: new Date().toISOString() }),
    getAgent: async (id) => snapshot.agents.find((a) => a.id === id),
  };
}

function createStubResolver(): ProviderAdapterResolver {
  let seq = 0;
  const makeAdapter = (driver: string): AgentAdapter => ({
    async runAgent(input) {
      seq += 1;
      input.onOutputLine?.({
        stream: 'stdout',
        line: `step ${seq} executed by ${driver}`,
        timestamp: new Date().toISOString(),
      });
      const docType = input.requiredArtifactTypes?.[0];
      const artifacts = [];
      if (docType && input.artifactStore) {
        artifacts.push(
          await input.artifactStore.writeArtifact({
            runId: input.runContext.runId,
            nodeId: input.runContext.nodeId,
            type: docType,
            docKey: docType,
            content: `# Output ${seq}\n\nLine A\nLine B (${seq})\n`,
          }),
        );
      }
      return {
        provider: driver === 'codex' ? 'codex' : 'claude-code',
        exitCode: 0,
        durationMs: 20,
        outputFiles: [],
        artifacts,
        assistantText: `结论 #${seq} (${driver}/${input.providerOverrides?.model ?? 'default'})`,
        handoffBrief: `结论 #${seq} (${driver})`,
        providerThreadId: `thread-${driver}-${input.roleConfig.role}`,
        tokenUsage: { inputTokens: 500, cachedInputTokens: 250, outputTokens: 100 },
      };
    },
  });

  return createProviderAdapterResolver({
    repoPath: process.cwd(),
    defaultDriver: 'claude-code',
    adapters: {
      'claude-code': makeAdapter('claude-code'),
      codex: makeAdapter('codex'),
    },
  });
}

function readSessionToken(projectRoot: string): string {
  const raw = readFileSync(join(projectRoot, '.tekon', 'web-session.json'), 'utf8');
  return (JSON.parse(raw) as { token: string }).token;
}

async function rpcCall<T = unknown>(
  server: RunningWebServer,
  path: string,
  input?: unknown,
  token?: string,
): Promise<{ status: number; result?: T; error?: { code: string; message: string } }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['x-session-token'] = token;
  const res = await fetch(`${server.url}/api/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path, input }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: string; message: string } };
  return { status: res.status, ...body };
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let lastVal: T | undefined;
  while (Date.now() - start < timeoutMs) {
    lastVal = await fn();
    if (pred(lastVal)) return lastVal;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastVal)}`);
}

describe('workbench v2 RPC API', () => {
  it('enforces session token auth (401) on all workbench procedures', async () => {
    const fixture = await createWebFixtureProject();
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
      workbenchDiscovery: createStubDiscovery(true),
      workbenchResolver: createStubResolver(),
    });
    cleanups.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    await server.listen();
    const token = readSessionToken(fixture.projectRoot);

    const allProcs = Object.entries(workbenchProcedureSpecs);
    expect(allProcs.length).toBeGreaterThanOrEqual(40);
    for (const [proc, spec] of allProcs) {
      expect(spec.auth, `${proc} must require session auth`).toBe('session');
      const res = await rpcCall(server, proc, undefined);
      expect(res.status, `${proc} without token must return 401`).toBe(401);
    }

    const ok = await rpcCall<{ agents: unknown[] }>(server, 'agent.list', undefined, token);
    expect(ok.status).toBe(200);
    expect(ok.result?.agents.length).toBe(2);
  });

  it('supports preferences persistence, role CRUD with cross-provider cleanup, and workflow CRUD', async () => {
    const fixture = await createWebFixtureProject();
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
      workbenchDiscovery: createStubDiscovery(true),
      workbenchResolver: createStubResolver(),
    });
    cleanups.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    await server.listen();
    const token = readSessionToken(fixture.projectRoot);

    // Update theme, width, railMode and verify persistence
    const updated = await rpcCall<{ prefs: { theme: string; contentWidth: string; railMode: string } }>(
      server,
      'prefs.update',
      { theme: 'dark', contentWidth: 'wide', railMode: 'right' },
      token,
    );
    expect(updated.status).toBe(200);
    expect(updated.result?.prefs.theme).toBe('dark');
    expect(updated.result?.prefs.contentWidth).toBe('wide');
    expect(updated.result?.prefs.railMode).toBe('right');

    // Create custom role and workflow referencing it with an overrideModel
    const roleSave = await rpcCall(server, 'role.save', {
      id: 'researcher-x',
      name: 'Researcher X',
      driver: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      systemPrompt: 'Research deeply',
    }, token);
    expect(roleSave.status).toBe(200);

    const wfSave = await rpcCall(server, 'workflow.save', {
      id: 'wf-x',
      name: 'Custom Flow',
      nodes: [
        { id: 'n1', name: 'Step 1', role: 'researcher-x', overrideModel: 'opus', expectedDoc: 'out.md' },
      ],
    }, token);
    expect(wfSave.status).toBe(200);

    // Deleting referenced role must fail with reference protection
    const delBlocked = await rpcCall(server, 'role.delete', { id: 'researcher-x' }, token);
    expect(delBlocked.status).toBeGreaterThanOrEqual(400);
    expect(delBlocked.error?.message).toContain('Custom Flow');

    // Switching role driver cleans incompatible overrideModel in wf-x
    const switched = await rpcCall<{ cleanedWorkflows: string[] }>(server, 'role.save', {
      id: 'researcher-x',
      name: 'Researcher X',
      driver: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      systemPrompt: 'Research deeply',
    }, token);
    expect(switched.status).toBe(200);
    expect(switched.result?.cleanedWorkflows).toContain('wf-x');
  });

  it('runs a static task with checkpoint, doc pin/export, context inspect, compaction, and archive mount', async () => {
    const fixture = await createWebFixtureProject();
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
      workbenchDiscovery: createStubDiscovery(true),
      workbenchResolver: createStubResolver(),
    });
    cleanups.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    await server.listen();
    const token = readSessionToken(fixture.projectRoot);

    // Save a 2-step template with confirmAfter on step 1
    await rpcCall(server, 'workflow.save', {
      id: 'two-step',
      name: 'Two Step',
      nodes: [
        { id: 'explore', name: '调研', role: 'explorer', expectedDoc: 'research.md', confirmAfter: true },
        { id: 'design', name: '方案', role: 'designer', expectedDoc: 'proposal.md' },
      ],
    }, token);

    const created = await rpcCall<{ runId: string }>(server, 'task.create', {
      mode: 'static',
      templateId: 'two-step',
      prompt: '研究知识图谱方案',
    }, token);
    expect(created.status).toBe(200);
    const runId = created.result!.runId;

    // Wait for confirm checkpoint
    const paused = await waitFor(
      () => rpcCall<{ task: { status: string; pauseReason: string | null; documents: Array<{ id: string; docKey: string }> } }>(server, 'task.get', { runId }, token),
      (r) => r.result?.task.status === 'paused' && r.result?.task.pauseReason === 'confirm_checkpoint',
    );
    expect(paused.result!.task.documents.length).toBeGreaterThanOrEqual(1);
    const firstDoc = paused.result!.task.documents[0]!;

    // Pin & export doc (verifies sanitized filename)
    const pinned = await rpcCall<{ document: { pinned: boolean } }>(server, 'doc.togglePin', {
      runId,
      docId: firstDoc.id,
    }, token);
    expect(pinned.result?.document.pinned).toBe(true);

    const exported = await rpcCall<{ filename: string; content: string }>(server, 'doc.export', {
      runId,
      docId: firstDoc.id,
    }, token);
    expect(exported.result?.filename).toMatch(/\.md$/);
    expect(exported.result?.filename).not.toContain('..');

    // Approve checkpoint and wait for completion
    await rpcCall(server, 'task.approveCheckpoint', { runId }, token);
    const done = await waitFor(
      () => rpcCall<{ task: { status: string; nodes: Array<{ id: string }> } }>(server, 'task.get', { runId }, token),
      (r) => r.result?.task.status === 'passed',
    );
    expect(done.result!.task.status).toBe('passed');

    // Inspect node 2 context + compact + list & mount archive
    const secondNodeId = done.result!.task.nodes[1]!.id;
    const ctxRes = await rpcCall<{ context: { documents: unknown[]; session: { windowPercent: number } } }>(
      server,
      'context.inspectNode',
      { runId, nodeId: secondNodeId },
      token,
    );
    expect(ctxRes.status).toBe(200);
    expect(ctxRes.result!.context.documents.length).toBeGreaterThanOrEqual(1);

    const compacted = await rpcCall<{ archive: { id: string } }>(server, 'context.compact', { runId }, token);
    expect(compacted.status).toBe(200);

    const mounted = await rpcCall<{ archive: { mounted: boolean } }>(
      server,
      'context.toggleArchiveMount',
      { runId, archiveId: compacted.result!.archive.id },
      token,
    );
    expect(mounted.result?.archive.mounted).toBe(true);
  });

  it('marks unregistered custom agents unsupported, routes legacy cancel through sessionService/JobRunner, and blocks cancelled dynamic blueprint confirmation', async () => {
    const fixture = await createWebFixtureProject();
    const discoveryWithCustom: AgentDiscoveryRegistry = {
      async getSnapshot() {
        return {
          probedAt: '2026-11-20T12:00:00.000Z',
          agents: [
            ...(await createStubDiscovery(true).getSnapshot()).agents,
            {
              id: 'custom-unregistered',
              name: 'Custom Unregistered',
              iconKey: 'generic',
              status: 'ready',
              models: ['custom-1'],
              efforts: ['default'],
              source: 'user-config',
            },
          ],
        };
      },
      async refresh() {
        return this.getSnapshot();
      },
      async getAgent(id) {
        return (await this.getSnapshot()).agents.find((a) => a.id === id);
      },
    };

    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: false,
      workbenchDiscovery: discoveryWithCustom,
      workbenchResolver: createStubResolver(),
    });
    cleanups.push(async () => {
      await server.close();
      fixture.cleanup();
    });
    await server.listen();
    const token = readSessionToken(fixture.projectRoot);

    // 1. Custom unregistered agent must show as unsupported / non-executable in agent.list
    const agentsRes = await rpcCall<{
      agents: Array<{ id: string; status: string; executable?: boolean }>;
    }>(server, 'agent.list', undefined, token);
    expect(agentsRes.status).toBe(200);
    const customAgent = agentsRes.result?.agents.find((a) => a.id === 'custom-unregistered');
    expect(customAgent?.status).toBe('unsupported');
    expect(customAgent?.executable).toBe(false);

    // 2. Seed a legacy CLI-owned task with a running job in SQLite; task.cancel must delegate to SessionService -> JobRunner!
    const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
    const now = new Date().toISOString();
    try {
      db.prepare(`insert into demands (id, title, body, source, created_at) values ('dem_leg_web', 'Legacy Job Task', 'body', 'cli', ?)`).run(now);
      db.prepare(`insert into projects (id, name, repo_path, created_at) values ('proj_leg_web', 'repo', ?, ?)`).run(fixture.projectRoot, now);
      db.prepare(`insert into workflow_instances (id, project_id, demand_id, status, kind, mode, plan_snapshot, created_at, updated_at) values ('run_leg_web', 'proj_leg_web', 'dem_leg_web', 'running', 'workflow', 'static', ?, ?, ?)`).run(
        JSON.stringify({ version: 2, template: { id: 'bugfix', name: 'Bugfix' } }),
        now,
        now,
      );
      const ws = db.prepare(`select id from workspaces limit 1`).get() as { id: string } | undefined;
      const wsId = ws?.id ?? 'ws_leg_web';
      if (!ws) {
        db.prepare(`insert into workspaces (id, root, created_at) values (?, ?, ?)`).run(wsId, fixture.projectRoot, now);
      }
      db.prepare(`insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at) values ('sess_leg_web', ?, 'Legacy Job Task', 'delivery', 'active', 'run_leg_web', ?, ?)`).run(wsId, now, now);
      db.prepare(`insert into jobs (id, session_id, kind, status, owner, abort_state, payload, created_at, updated_at) values ('job_leg_web', 'sess_leg_web', 'workflow-run', 'running', 'cli-worker-1', 'none', '{}', ?, ?)`).run(now, now);
    } finally {
      db.close();
    }

    const legDetail = await rpcCall<{ task: { executor: string; canControl: boolean } }>(
      server,
      'task.get',
      { runId: 'run_leg_web' },
      token,
    );
    expect(legDetail.status).toBe(200);
    expect(legDetail.result?.task.executor).toBe('legacy');
    expect(legDetail.result?.task.canControl).toBe(true);

    // Workbench-only mutations on legacy task (including doc.* & context.*) rejected with 409
    const legResume = await rpcCall(server, 'task.resume', { runId: 'run_leg_web' }, token);
    expect(legResume.status).toBe(409);
    expect(legResume.error?.message).toContain('LEGACY_TASK_READONLY');
    for (const [proc, input] of [
      ['doc.togglePin', { runId: 'run_leg_web', docId: 'doc_1' }],
      ['doc.promoteFromHandoff', { runId: 'run_leg_web', nodeId: 'n1' }],
      ['context.setNodeReuseMode', { runId: 'run_leg_web', roleId: 'explorer', reuseMode: 'reset' }],
      ['context.compact', { runId: 'run_leg_web' }],
      ['context.toggleArchiveMount', { runId: 'run_leg_web', archiveId: 'arc_1' }],
    ] as const) {
      const res = await rpcCall(server, proc, input, token);
      expect(res.status, `${proc} on legacy task must return 409`).toBe(409);
      expect(res.error?.message).toContain('LEGACY_TASK_READONLY');
    }

    // task.cancel delegates through SessionService -> JobRunner (job transitions to cancelling/requested!)
    const legCancel = await rpcCall<{ task: { status: string } }>(
      server,
      'task.cancel',
      { runId: 'run_leg_web' },
      token,
    );
    expect(legCancel.status).toBe(200);
    expect(legCancel.result?.task.status).toBe('cancelled');

    const dbCheck = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
    try {
      const jobRow = dbCheck
        .prepare(`select status, abort_state from jobs where id = 'job_leg_web'`)
        .get() as { status: string; abort_state: string };
      expect(jobRow.status).toBe('cancelling');
      expect(jobRow.abort_state).toBe('requested');

      // 3. Seed a cancelled dynamic task still holding blueprint_status = 'review' -> confirmBlueprint must reject with 409!
      dbCheck.prepare(`insert into demands (id, title, body, source, created_at) values ('dem_dyn_cancel', 'Cancelled Dynamic', 'body', 'workbench', ?)`).run(now);
      dbCheck.prepare(`insert into projects (id, name, repo_path, created_at) values ('proj_dyn_cancel', 'repo', ?, ?)`).run(fixture.projectRoot, now);
      dbCheck.prepare(
        `insert into workflow_instances (id, project_id, demand_id, status, kind, mode, blueprint_status, blueprint_json, plan_snapshot, created_at, updated_at)
         values ('run_dyn_cancel', 'proj_dyn_cancel', 'dem_dyn_cancel', 'cancelled', 'workflow', 'dynamic', 'review', ?, ?, ?, ?)`,
      ).run(
        JSON.stringify({ summary: 's', nodes: [{ id: 'n1', name: '步骤一', roleId: 'explorer' }] }),
        JSON.stringify({ version: 4, templateName: '动态编排' }),
        now,
        now,
      );
    } finally {
      dbCheck.close();
    }

    const confirmRes = await rpcCall(server, 'task.confirmBlueprint', { runId: 'run_dyn_cancel' }, token);
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.error?.message).toMatch(/TASK_TERMINAL|BLUEPRINT_NOT_READY/u);
  });
});
