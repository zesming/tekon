import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderAdapterResolver,
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
});
