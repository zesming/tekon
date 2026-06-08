import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openDonkeyDatabase,
  type GateEngine,
} from '../../src/index.js';

describe('workflow engine template e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates durable run state before agent execution and completes the standard-feature template with mock agent', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-engine-template-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const observedNodesAtFirstAgentCall: number[] = [];
    const adapter = createMockAgentAdapter();

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.donkey',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          observedNodesAtFirstAgentCall.push(
            (await repositories.listNodes(input.runContext.runId)).length,
          );
          return adapter.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const result = await engine.startRun({
      demandText: '给示例模块加批量重试',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(observedNodesAtFirstAgentCall[0]).toBeGreaterThan(0);
    expect(result.workflow.status).toBe('passed');
    expect(await repositories.listPhases(result.runId)).toHaveLength(5);
    expect(await repositories.listNodes(result.runId)).toHaveLength(5);
    expect(await repositories.listArtifacts(result.runId)).toHaveLength(7);
    expect(
      await repositories.listArtifacts(
        result.runId,
        undefined,
        'delivery-package',
      ),
    ).toHaveLength(1);
    expect(await audit.verify(result.runId)).toEqual({ valid: true });

    db.close();
  });
});

export function createPassingGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  let gateCounter = 0;
  return {
    async runGate(input) {
      gateCounter += 1;
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: 'passed',
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
}
