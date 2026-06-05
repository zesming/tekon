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

describe('workflow engine recovery e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('resumes an interrupted run from the interrupted node while preserving previous artifacts and audit chain', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-engine-recovery-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();
    let interrupted = false;

    const firstEngine = createWorkflowEngine({
      repoPath,
      dataDir: '.donkey',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          if (
            input.runContext.nodeId.endsWith('_rd-implementation') &&
            !interrupted
          ) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const interruptedRun = await firstEngine.startRun({
      demandText: '恢复中断的运行',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(interruptedRun.workflow.status).toBe('interrupted');
    expect(await repositories.listArtifacts(interruptedRun.runId)).not.toEqual(
      [],
    );

    const secondEngine = createWorkflowEngine({
      repoPath,
      dataDir: '.donkey',
      repositories,
      audit,
      adapter: mock,
      gateEngine: createPassingGateEngine(repositories),
    });

    const resumed = await secondEngine.resumeRun(interruptedRun.runId);

    expect(resumed.workflow.status).toBe('passed');
    expect(
      await repositories.listArtifacts(
        resumed.runId,
        undefined,
        'delivery-package',
      ),
    ).not.toEqual([]);
    expect(await audit.verify(resumed.runId)).toEqual({ valid: true });

    db.close();
  });
});

function createPassingGateEngine(
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
