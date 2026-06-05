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

describe('workflow engine gate repair e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates a repair node when an auto-fix gate fails', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-engine-repair-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.donkey',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      gateEngine: createFailOnceGateEngine(repositories),
    });

    const result = await engine.startRun({
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

    db.close();
  });
});

function createFailOnceGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  let failed = false;

  return {
    async runGate(input) {
      const shouldFail = input.gate.type === 'build' && !failed;
      failed = failed || shouldFail;
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${failed ? 'seen' : 'new'}_${Date.now()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: shouldFail ? 'failed' : 'passed',
        durationMs: 0,
        retries: shouldFail ? 0 : 1,
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
