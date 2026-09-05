import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  JOB_ABORT_REASON_OWNERSHIP_LOST,
  migrateDatabase,
  openTekonDatabase,
  type GateEngine,
} from '../../src/index.js';
import { validateAndBuildExecutionPlan } from '../../src/workflow/execution-plan.js';
import { createGateEngine } from '../../src/gate/engine.js';

describe('workflow engine gate repair e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates a repair node when an auto-fix gate fails', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-repair-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    let pauseRequested = false;

    // Phase 2 S3 (review S1): capture agent-loop events so we can prove the
    // gate-repair agent execution also emits step events (not just node/rework).
    const stepEvents: Array<{ type: string; nodeId: unknown }> = [];
    const agentEventSink = {
      async recordFromRun(input: {
        type: string;
        payload?: Record<string, unknown>;
      }) {
        stepEvents.push({ type: input.type, nodeId: input.payload?.nodeId });
      },
    };

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      gateEngine: createFailOnceGateEngine(repositories),
      agentEventSink,
      isPauseRequested: () => pauseRequested,
      onNodeCheckpoint: async nodeId => { if (nodeId.endsWith('_rd-code')) pauseRequested = true; },
    });

    let result = await engine.startRun({
      demandText: '触发 gate repair',
      mode: 'template',
      workflowSpec: {
        id: 'repair-template',
        name: 'Repair Template',
        version: 1,
        retryPolicy: {
          maxRetries: 1,
          maxAttempts: 2,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'implementation',
            name: 'Implementation',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'rd-code',
                role: 'rd',
                inputs: [],
                outputs: [{ id: 'code-changes', type: 'code-changes' }],
                dependsOn: [],
                gates: [
                  {
                    type: 'build',
                    requiresHumanApproval: false,
                    maxRetries: 1,
                    retryPolicy: {
                      maxRetries: 1,
                      maxAttempts: 2,
                      backoffMs: 0,
                      strategy: 'fixed',
                      onExhausted: 'block',
                    },
                    autoFix: true,
                  },
                  {
                    type: 'lint',
                    requiresHumanApproval: false,
                    maxRetries: 0,
                    retryPolicy: {
                      maxRetries: 0,
                      maxAttempts: 1,
                      backoffMs: 0,
                      strategy: 'fixed',
                      onExhausted: 'block',
                    },
                  },
                ],
              },
            ],
          },
          {
            id: 'validation',
            name: 'Validation',
            dependsOn: ['implementation'],
            parallel: false,
            nodes: [
              {
                id: 'qa',
                role: 'qa',
                inputs: [],
                outputs: [],
                gates: [],
                dependsOn: [],
              },
            ],
          },
          {
            id: 'review',
            name: 'Review',
            dependsOn: ['validation'],
            parallel: false,
            nodes: [
              {
                id: 'reviewer',
                role: 'reviewer',
                inputs: [],
                outputs: [],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(result.workflow.status).toBe('paused');
    const verified = await validateAndBuildExecutionPlan(result.runId, repositories, audit);
    expect(verified.phases.flatMap(phase => phase.nodes).some(node => node.id.startsWith('repair_'))).toBe(false);
    const events = await repositories.listAuditEvents(result.runId);
    expect(events.filter(event => event.type === 'gate.repair.intent')).toHaveLength(1);
    expect(events.filter(event => event.type === 'gate.repair.created')).toHaveLength(1);
    expect(events.findIndex(event => event.type === 'gate.repair.intent')).toBeLessThan(events.findIndex(event => event.type === 'gate.repair.created'));
    pauseRequested = false;
    result = await engine.resumeRun(result.runId);
    const nodes = await repositories.listNodes(result.runId);
    expect(nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^repair_gate_/u)]),
    );
    expect(await repositories.listGateResults(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateType: 'build', status: 'failed' }),
        expect.objectContaining({ gateType: 'build', status: 'passed' }),
      ]),
    );
    expect(result.workflow.status).toBe('passed');

    // review S1: the gate-repair agent run emitted step events too (so a run
    // that went through repair has a complete model-visible replay, §13.6).
    const repairStepStarts = stepEvents.filter(
      (e) => e.type === 'step/start' && String(e.nodeId).startsWith('repair_gate_'),
    );
    expect(repairStepStarts.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('a fence during gate repair does not revert a terminal run via the repair/exhausted path (M3 (b)/(c))', async () => {
    // Regression (fix-review S9 gap): the repair-loop-top fence check
    // (gate-runner.ts) and the exhausted-settle fence check must prevent a
    // fenced executor from reverting a run the recovering owner already settled
    // `passed`. The prior gates-fence e2e only drove the post-runGate check (a);
    // this drives (b)/(c) by keeping an autoFix gate failing so the repair loop
    // runs, then fencing during it.
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-repair-fence-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const fence = new AbortController();
    let buildGateCalls = 0;
    let fencedDuringRepair = false;

    // build gate ALWAYS fails (so the autoFix repair loop runs and then
    // exhausts). On the post-repair re-run of the build gate, simulate the
    // recovering owner having settled `passed`, then fence this executor. The
    // repair-loop-top (b) / exhausted-settle (c) guards must stand down without
    // reverting `passed`.
    const fencingRepairGateEngine: GateEngine = {
      async runGate(input) {
        const isBuild = input.gate.type === 'build';
        if (isBuild) {
          buildGateCalls += 1;
          // 1st call = initial gate; 2nd call = post-repair re-run. Fence on the
          // re-run so the loop then exits (maxRetries exhausted) into the
          // exhausted-settle guard.
          if (buildGateCalls === 2 && !fencedDuringRepair) {
            fencedDuringRepair = true;
            await repositories.updateWorkflowInstanceStatus(
              input.runId,
              'passed',
              null,
            );
            fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
          }
        }
        return repositories.recordGateResult({
          id: `gate_${input.nodeId}_${input.gate.type}_${buildGateCalls}_${Date.now()}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          status: isBuild ? 'failed' : 'passed',
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
      async createAutoFixRepairNode(input) {
        return repositories.createNode({
          id: `repair_${input.failedGateResult.id}`,
          runId: input.failedGateResult.runId,
          role: input.fixerRole,
          status: 'pending',
          gates: [],
          dependencies: [input.failedGateResult.nodeId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };

    const run = await engineWithBuildGate(
      repoPath,
      repositories,
      audit,
      fencingRepairGateEngine,
      fence.signal,
    ).startRun({
      demandText: 'repair 阶段被 fence 不得回退终态',
      mode: 'template',
      workflowSpec: buildGateWorkflowSpec(),
    });

    expect(fencedDuringRepair).toBe(true);
    // The recovering owner's terminal `passed` MUST survive the fenced
    // executor's repair-loop / exhausted-settle bookkeeping.
    const persisted = await repositories.getWorkflowInstance(run.runId);
    expect(persisted?.status).toBe('passed');

    db.close();
  });

  it.each(['intent', 'node', 'created'] as const)('repair %s 边界失败仍保留可验证记录，intent 先于 source 状态和节点创建', async boundary => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-repair-intent-')); tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' }); migrateDatabase(db);
    const repositories = createRepositories(db); const audit = createAuditLogger({ repositories });
    const append = audit.append.bind(audit); const createNode = repositories.createNode.bind(repositories);
    const sourceStatusAtIntent: string[] = [];
    vi.spyOn(audit, 'append').mockImplementation(async event => {
      if (event.type === 'gate.repair.intent') {
        const source = await repositories.getNode(String(event.payload.sourceNodeId));
        sourceStatusAtIntent.push(source!.status);
        if (boundary === 'intent') throw new Error('injected intent failure');
      }
      if (event.type === 'gate.repair.created' && boundary === 'created') throw new Error('injected created failure');
      return append(event);
    });
    vi.spyOn(repositories, 'createNode').mockImplementation(async node => {
      if (node.id.startsWith('repair_')) {
        const events = await repositories.listAuditEvents(node.runId);
        expect(events.filter(event => event.type === 'gate.repair.intent')).toHaveLength(1);
        if (boundary === 'node') throw new Error('injected node failure');
      }
      return createNode(node);
    });
    try {
      const engine = engineWithBuildGate(repoPath, repositories, audit, createFailOnceGateEngine(repositories), new AbortController().signal);
      const run = await engine.startRun({ demandText: 'repair 中断验证', mode: 'template', workflowSpec: buildGateWorkflowSpec() });
      expect(run.workflow.status).toBe('interrupted');
      expect(sourceStatusAtIntent).toEqual(['awaiting-gate']);
      const events = await repositories.listAuditEvents(run.runId);
      expect(events.filter(event => event.type === 'gate.repair.intent')).toHaveLength(boundary === 'intent' ? 0 : 1);
      expect(events.filter(event => event.type === 'gate.repair.created')).toHaveLength(0);
      const nodes = await repositories.listNodes(run.runId);
      expect(nodes.filter(node => node.id.startsWith('repair_'))).toHaveLength(boundary === 'created' ? 1 : 0);
      const verified = await validateAndBuildExecutionPlan(run.runId, repositories, audit);
      expect(verified.phases.flatMap(phase => phase.nodes).map(node => node.id)).toEqual([`${run.runId}_rd-code`]);
    } finally { db.close(); }
  });
});

function buildGateWorkflowSpec() {
  return {
    id: 'repair-fence-template',
    name: 'Repair Fence Template',
    version: 1,
    retryPolicy: {
      maxRetries: 1,
      maxAttempts: 2,
      backoffMs: 0,
      strategy: 'fixed' as const,
      onExhausted: 'block' as const,
    },
    phases: [
      {
        id: 'implementation',
        name: 'Implementation',
        dependsOn: [],
        parallel: false,
        nodes: [
          {
            id: 'rd-code',
            role: 'rd',
            inputs: [],
            outputs: [{ id: 'code-changes', type: 'code-changes' as const }],
            dependsOn: [],
            gates: [
              {
                type: 'build' as const,
                requiresHumanApproval: false,
                maxRetries: 1,
                retryPolicy: {
                  maxRetries: 1,
                  maxAttempts: 2,
                  backoffMs: 0,
                  strategy: 'fixed' as const,
                  onExhausted: 'block' as const,
                },
                autoFix: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

function engineWithBuildGate(
  repoPath: string,
  repositories: ReturnType<typeof createRepositories>,
  audit: ReturnType<typeof createAuditLogger>,
  gateEngine: GateEngine,
  signal: AbortSignal,
) {
  return createWorkflowEngine({
    repoPath,
    dataDir: '.tekon',
    repositories,
    audit,
    adapter: createMockAgentAdapter(),
    gateEngine,
    signal,
  });
}


function createFailOnceGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  let failed = false;
  const realGateEngine = createGateEngine({ repositories });

  return {
    async runGate(input) {
      const shouldFail = input.gate.type === 'build' && !failed;
      failed = failed || shouldFail;
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${failed ? 'seen' : 'new'}_${Date.now()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        gateKey: input.gate.gateKey,
        status: shouldFail ? 'failed' : 'passed',
        durationMs: 0,
        retries: shouldFail ? 0 : 1,
        createdAt: new Date().toISOString(),
      });
    },
    async createAutoFixRepairNode(input) {
      return realGateEngine.createAutoFixRepairNode(input);
    },
  };
}
