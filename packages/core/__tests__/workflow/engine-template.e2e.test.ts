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
    expect(
      (await repositories.listArtifacts(result.runId))
        .map((artifact) => artifact.type)
        .sort(),
    ).toEqual([
      'code-changes',
      'delivery-package',
      'demand-card',
      'prd',
      'qa-release-signoff',
      'review-report',
      'tech-design',
      'test-report',
    ]);
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

  it('runs duplicate gate types independently when they target different artifacts', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-dup-gates-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          await input.artifactStore?.writeArtifact({
            runId: input.runContext.runId,
            nodeId: input.runContext.nodeId,
            type: 'demand-card',
            content: JSON.stringify({
              title: 'Demand',
              body: 'Valid demand card.',
              acceptanceCriteria: [
                { id: 'AC-1', description: 'Demand can be validated.' },
              ],
            }),
          });
          await input.artifactStore?.writeArtifact({
            runId: input.runContext.runId,
            nodeId: input.runContext.nodeId,
            type: 'prd',
            content: JSON.stringify({
              title: 'PRD',
              body: 'Invalid PRD without acceptance criteria.',
            }),
          });
          return {
            provider: 'mock',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
          };
        },
      },
    });

    const result = await engine.startRun({
      demandText: '验证重复 schema gate 不会被折叠',
      mode: 'template',
      workflowSpec: {
        id: 'duplicate-schema-gates',
        name: 'Duplicate Schema Gates',
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
            id: 'pm',
            name: 'PM',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'pm-node',
                role: 'pm',
                inputs: [],
                outputs: [
                  { id: 'demand', type: 'demand-card' },
                  { id: 'prd', type: 'prd' },
                ],
                gates: [
                  { type: 'schema', artifactType: 'demand-card' },
                  { type: 'schema', artifactType: 'prd' },
                ],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    const gates = await repositories.listGateResults(result.runId);
    expect(result.workflow.status).toBe('blocked');
    expect(gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateType: 'schema',
          gateKey: expect.stringContaining('artifact=demand-card'),
          status: 'passed',
        }),
        expect.objectContaining({
          gateType: 'schema',
          gateKey: expect.stringContaining('artifact=prd'),
          status: 'failed',
          failureClassification: 'invalid-artifact',
        }),
      ]),
    );
    expect(new Set(gates.map((gate) => gate.gateKey)).size).toBe(2);
    db.close();
  });

  it('rejects direct workflow specs with duplicate effective gate keys', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-dup-key-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent() {
          throw new Error('duplicate gate key spec must not run an agent');
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    await expect(
      engine.startRun({
        demandText: '直接传入 workflowSpec 时也要拒绝重复 gateKey',
        mode: 'template',
        workflowSpec: {
          id: 'duplicate-direct-gate-key',
          name: 'Duplicate Direct Gate Key',
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
              id: 'implementation',
              name: 'Implementation',
              dependsOn: [],
              parallel: false,
              nodes: [
                {
                  id: 'rd-node',
                  role: 'rd',
                  inputs: [],
                  outputs: [{ id: 'code', type: 'code-changes' }],
                  gates: [
                    { type: 'build', gateKey: 'validate' },
                    { type: 'lint', gateKey: 'validate' },
                  ],
                  dependsOn: [],
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow(/duplicate gateKey "validate" in node "rd-node"/u);
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
        gateKey: input.gate.gateKey,
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
