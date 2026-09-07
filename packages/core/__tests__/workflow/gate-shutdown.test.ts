import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger, createMockAgentAdapter, createRepositories, createWorkflowEngine,
  migrateDatabase, openTekonDatabase, type GateEngine, type WorkflowTemplate,
} from '../../src/index.js';
import { hasPendingFallbackGate } from '../../src/workflow/node-executor.js';
import { createGateEngine } from '../../src/gate/engine.js';
import { JOB_ABORT_REASON_OWNERSHIP_LOST, JOB_ABORT_REASON_SHUTDOWN } from '../../src/session/job-runner.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tekon-gate-shutdown-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' }); migrateDatabase(db);
  cleanups.push(() => db.close());
  const repositories = createRepositories(db); const audit = createAuditLogger({ repositories });
  const controller = new AbortController(); const adapter = createMockAgentAdapter();
  const realGate = createGateEngine({ repositories });
  const gateEngine: GateEngine = { ...realGate, runGate: vi.fn(async input => repositories.recordGateResult({
    id: `gate_${(await repositories.listGateResults(input.runId)).length}`,
    runId: input.runId, nodeId: input.nodeId, gateType: input.gate.type, gateKey: input.gate.gateKey,
    status: 'failed', durationMs: 0, retries: 0, createdAt: new Date().toISOString(),
  })) };
  const spec: WorkflowTemplate = { id: 'gate-stop', name: 'Gate stop', version: 1,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, strategy: 'fixed', onExhausted: 'fail' },
    phases: [{ id: 'phase', name: 'Phase', dependsOn: [], parallel: false, nodes: [{ id: 'node', role: 'rd',
      inputs: [], outputs: [], dependsOn: [], gates: [{ type: 'build', autoFix: true, maxRetries: 2, onExhausted: 'fail' }] }] }] };
  const start = () => createWorkflowEngine({ repoPath: root, dataDir: '.tekon', repositories, audit,
    adapter, gateEngine, signal: controller.signal }).startRun({ demandText: 'Gate stop', mode: 'template', workflowSpec: spec });
  return { repositories, audit, controller, adapter, gateEngine, spec, start };
}

describe('Gate execution abort boundaries', () => {
  it.each(['passed', 'failed', 'throw'] as const)('shutdown after initial Gate %s preserves the completed node', async status => {
    const f = fixture(); const runGate = f.gateEngine.runGate;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => {
      const result = await runGate(input);
      f.controller.abort(JOB_ABORT_REASON_SHUTDOWN);
      if (status === 'throw') throw new Error('Gate closed');
      return { ...result, status };
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('interrupted');
    expect((await f.repositories.listNodes(run.runId)).map(node => node.status)).toEqual(['awaiting-gate']);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.some(event => ['gate.failed', 'gate.passed', 'gate.repair.intent', 'node.passed'].includes(event.type))).toBe(false);
    expect(events.some(event => event.type === 'gate.execution.interrupted' && event.payload.reason === 'shutdown')).toBe(true);
    expect((await f.repositories.getLatestRoleRunForNode(run.runId, `${run.runId}_node`))?.status).toBe('passed');
  });

  it.each(['passed', 'failed', 'throw'] as const)('cancellation wins over late Gate %s', async status => {
    const f = fixture(); const runGate = f.gateEngine.runGate;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => {
      const result = await runGate(input);
      await f.repositories.updateWorkflowInstanceStatus(input.runId, 'cancelled', input.nodeId);
      f.controller.abort('user cancel');
      if (status === 'throw') throw new Error('Gate closed');
      return { ...result, status };
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('cancelled');
    expect((await f.repositories.listNodes(run.runId)).map(node => node.status)).toEqual(['awaiting-gate']);
    expect((await f.repositories.listAuditEvents(run.runId)).some(event => ['gate.failed', 'gate.passed', 'gate.repair.intent', 'node.passed'].includes(event.type))).toBe(false);
  });

  it.each(['passed', 'failed', 'throw'] as const)('ownership loss leaves new owner state untouched after Gate %s', async status => {
    const f = fixture(); const runGate = f.gateEngine.runGate;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => {
      const result = await runGate(input);
      await f.repositories.transitionNode(input.nodeId, 'passed');
      await f.repositories.updateWorkflowInstanceStatus(input.runId, 'passed', input.nodeId);
      f.controller.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
      if (status === 'throw') throw new Error('Gate closed');
      return { ...result, status };
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('passed');
    expect((await f.repositories.listNodes(run.runId)).map(node => node.status)).toEqual(['passed']);
    expect((await f.repositories.listAuditEvents(run.runId)).some(event => ['gate.failed', 'gate.passed', 'gate.repair.intent', 'node.passed'].includes(event.type))).toBe(false);
  });

  it.each(['return', 'throw'] as const)('shutdown during repair Agent %s keeps source needs-revision and stops retries', async outcome => {
    const f = fixture(); const runAgent = f.adapter.runAgent.bind(f.adapter);
    vi.spyOn(f.adapter, 'runAgent').mockImplementation(async input => {
      if (input.worktreeLease.nodeId.startsWith('repair_')) {
        f.controller.abort(JOB_ABORT_REASON_SHUTDOWN);
        if (outcome === 'throw') throw new Error('repair interrupted');
      }
      return runAgent(input);
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('needs-revision');
    expect(f.gateEngine.runGate).toHaveBeenCalledTimes(1);
    expect(f.adapter.runAgent).toHaveBeenCalledTimes(2);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.filter(event => event.type === 'gate.repair.intent')).toHaveLength(1);
    expect(events.some(event => ['gate.failed', 'gate.repair.failed', 'node.passed'].includes(event.type))).toBe(false);
  });

  it.each(['passed', 'failed'] as const)('shutdown after repair Gate %s cannot advance or exhaust', async status => {
    const f = fixture(); const runGate = f.gateEngine.runGate; let calls = 0;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => {
      const result = await runGate(input);
      if (++calls === 2) { f.controller.abort(JOB_ABORT_REASON_SHUTDOWN); return { ...result, status }; }
      return result;
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect(calls).toBe(2);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.some(event => ['gate.failed', 'gate.passed-after-repair', 'node.passed'].includes(event.type))).toBe(false);
    expect(events.filter(event => event.type === 'gate.execution.interrupted')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: 'shutdown', gateResultId: 'gate_1' }) }),
    ]);
  });

  it.each(['passed', 'failed'] as const)('shutdown after failed-repair fallback Gate %s cannot retry or exhaust', async status => {
    const f = fixture(); const runAgent = f.adapter.runAgent.bind(f.adapter);
    vi.spyOn(f.adapter, 'runAgent').mockImplementation(async input => {
      if (input.worktreeLease.nodeId.startsWith('repair_')) throw new Error('ordinary repair failure');
      return runAgent(input);
    });
    const runGate = f.gateEngine.runGate; let calls = 0;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => {
      const result = await runGate(input);
      if (++calls === 2) { f.controller.abort(JOB_ABORT_REASON_SHUTDOWN); return { ...result, status }; }
      return result;
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect(calls).toBe(2);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.filter(event => event.type === 'gate.repair.intent')).toHaveLength(1);
    expect(events.some(event => ['gate.failed', 'gate.passed-after-repair', 'node.passed'].includes(event.type))).toBe(false);
    expect(events.filter(event => event.type === 'gate.execution.interrupted')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: 'shutdown', gateResultId: 'gate_1' }) }),
    ]);
  });

  it('shutdown after Gate success audit stops Node finalize and passed transition', async () => {
    const f = fixture(); const append = f.audit.append.bind(f.audit);
    const runGate = f.gateEngine.runGate;
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(async input => ({ ...await runGate(input), status: 'passed' }));
    vi.spyOn(f.audit, 'append').mockImplementation(async event => {
      const result = await append(event);
      if (event.type === 'gate.passed') f.controller.abort(JOB_ABORT_REASON_SHUTDOWN);
      return result;
    });
    const run = await f.start();
    expect(run.workflow.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect((await f.repositories.listAuditEvents(run.runId)).some(event => event.type === 'node.passed')).toBe(false);
  });

  it('a command timeout without executor abort remains a quality failure', async () => {
    const f = fixture();
    const commandGate = createGateEngine({ repositories: f.repositories, gateway: {
      async run(input) {
        const stdoutPath = join(input.outputDir!, 'stdout'); const stderrPath = join(input.outputDir!, 'stderr');
        writeFileSync(stdoutPath, ''); writeFileSync(stderrPath, 'timeout');
        return { status: 'executed', exitCode: null, signal: 'SIGTERM', timedOut: true, durationMs: 1, stdoutPath, stderrPath };
      },
    } });
    vi.spyOn(f.gateEngine, 'runGate').mockImplementation(commandGate.runGate);
    f.spec.phases[0].nodes[0].gates = [{ type: 'build', command: { tool: 'npm', args: ['test'] }, autoFix: false, onExhausted: 'fail' }];
    const run = await f.start();
    expect(run.workflow.status).toBe('failed');
    expect((await f.repositories.listGateResults(run.runId))[0]).toMatchObject({ status: 'failed', failureClassification: 'timeout' });
    expect(f.controller.signal.aborted).toBe(false);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.filter(event => event.type === 'gate.failed')).toHaveLength(1);
    expect(events.some(event => event.type === 'gate.execution.interrupted')).toBe(false);
  });

  it('ordinary quality failure still exhausts the configured repair budget', async () => {
    const f = fixture(); const agent = vi.spyOn(f.adapter, 'runAgent');
    const run = await f.start();
    expect(run.workflow.status).toBe('failed');
    expect(f.gateEngine.runGate).toHaveBeenCalledTimes(3);
    expect(agent).toHaveBeenCalledTimes(3);
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.filter(event => event.type === 'gate.failed')).toHaveLength(1);
    expect(events.some(event => event.type === 'gate.execution.interrupted')).toBe(false);
  });
});

describe('durable fallback Gate checkpoint ordering', () => {
  const intent = { type: 'gate.repair.intent', payload: { sourceNodeId: 'source' } };
  const failed = { type: 'gate.repair.failed', payload: { nodeId: 'source' } };
  const created = { type: 'worktree.lease.created', payload: { nodeId: 'source', leaseId: 'replacement' } };
  it('requires the current source lease after a failed repair and rejects a later repair intent', () => {
    expect(hasPendingFallbackGate([intent, failed, created], 'source', 'replacement')).toBe(true);
    expect(hasPendingFallbackGate([intent, failed, created, intent], 'source', 'replacement')).toBe(false);
    expect(hasPendingFallbackGate([intent, created], 'source', 'replacement')).toBe(false);
    expect(hasPendingFallbackGate([intent, failed, created], 'source', 'stale')).toBe(false);
    expect(hasPendingFallbackGate([intent, failed, created], 'another-node', 'replacement')).toBe(false);
  });
});
