import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openTekonDatabase,
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
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-template-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const observedNodesAtFirstAgentCall: number[] = [];
    const adapter = createMockAgentAdapter();

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
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

  it('skips commandRef gates explicitly marked notApplicable in the repo profile', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-na-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      [
        'version: 1',
        'commands:',
        '  build:',
        '    notApplicable: true',
        '    reason: "documentation-only repo"',
        'pr:',
        '  baseBranch: main',
        '  titlePrefix: ""',
        'risks:',
        '  highRiskPaths: []',
        '  requiresHumanApproval: []',
      ].join('\n'),
      'utf8',
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
    });

    const result = await engine.startRun({
      demandText: '文档仓库无需 build gate',
      mode: 'template',
      workflowSpec: {
        id: 'not-applicable-gate',
        name: 'Not Applicable Gate',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'rd',
            name: 'RD',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'rd-node',
                role: 'rd',
                inputs: [],
                outputs: [],
                gates: [{ type: 'build', commandRef: 'build' }],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(result.workflow.status).toBe('passed');
    expect(await repositories.listGateResults(result.runId)).toMatchObject([
      {
        gateType: 'build',
        status: 'skipped',
        failureClassification: 'not-applicable',
      },
    ]);
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
