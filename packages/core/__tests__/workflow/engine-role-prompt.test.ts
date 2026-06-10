import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openTekonDatabase,
  type AgentRunResult,
  type GateEngine,
} from '../../src/index.js';

describe('workflow engine role prompt integration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('injects role system prompt, skills, tools, knowledge, and project context into agent input', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-prompt-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-engine-prompt-roles-'));
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: string[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push(input.prompt);
          return {
            provider: 'custom',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    await engine.startRun({
      demandText: '修改任务重试逻辑',
      mode: 'template',
      workflowSpec: {
        id: 'role-prompt',
        name: 'Role Prompt',
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
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(prompts[0]).toContain('# Role: Test RD');
    expect(prompts[0]).toContain('RD system instructions');
    expect(prompts[0]).toContain('skill body');
    expect(prompts[0]).toContain('knowledge body');
    expect(prompts[0]).toContain('repoPath:');
    expect(prompts[0]).toContain('修改任务重试逻辑');
    expect(prompts[0]).toContain('Execute workflow node');
    db.close();
  });

  it('adds artifact boundary and exit instructions for nodes with required artifacts', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-artifact-prompt-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-artifact-prompt-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: string[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push(input.prompt);
          return {
            provider: 'custom',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    await engine.startRun({
      demandText: '补充 smoke 文档',
      mode: 'template',
      workflowSpec: {
        id: 'artifact-prompt-boundary',
        name: 'Artifact Prompt Boundary',
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
                id: 'pm-scope',
                role: 'pm',
                inputs: [],
                outputs: [{ id: 'demand', type: 'demand-card' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(prompts[0]).toContain('Tekon artifact protocol');
    expect(prompts[0]).toContain(
      "Complete only this workflow node's responsibilities.",
    );
    expect(prompts[0]).toContain(
      'do not modify the repository working tree; write only node artifacts under TEKON_OUTPUT_DIR.',
    );
    expect(prompts[0]).toContain(
      'After the $TEKON_ARTIFACT_MANIFEST file is written, stop work and exit immediately.',
    );
    expect(prompts[0]).toContain(
      'Write required artifact files and the $TEKON_ARTIFACT_MANIFEST file before optional checks or reviews.',
    );
    expect(prompts[0]).toContain(
      'TEKON_ARTIFACT_MANIFEST is an environment variable containing the manifest file path; write the manifest JSON to $TEKON_ARTIFACT_MANIFEST.',
    );
    expect(prompts[0]).toContain(
      'Do not spawn subagents, delegate review, or wait for external agents inside this node.',
    );
    expect(prompts[0]).toContain(
      'Do not continue editing, formatting, running checks, printing diffs, or explaining',
    );
    db.close();
  });

  it('keeps repository edit scope for code-changes nodes while preserving exit instructions', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-code-changes-prompt-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-code-changes-prompt-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: string[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push(input.prompt);
          return {
            provider: 'custom',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    await engine.startRun({
      demandText: '实现 smoke 文档更新',
      mode: 'template',
      workflowSpec: {
        id: 'code-changes-prompt-boundary',
        name: 'Code Changes Prompt Boundary',
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
                id: 'rd-change',
                role: 'rd',
                inputs: [],
                outputs: [{ id: 'code', type: 'code-changes' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(prompts[0]).toContain('Tekon artifact protocol');
    expect(prompts[0]).toContain(
      'Keep repository edits scoped to the requested code-changes artifact and this workflow node.',
    );
    expect(prompts[0]).toContain(
      'Do not run git add, git commit, git push, or create PRs inside this node.',
    );
    expect(prompts[0]).toContain(
      'Leave repository edits in the worktree; Tekon Engine promotes and commits passed node changes after gates.',
    );
    expect(prompts[0]).not.toContain(
      'Required artifact types do not include code-changes; do not modify the repository working tree;',
    );
    expect(prompts[0]).toContain(
      'After the $TEKON_ARTIFACT_MANIFEST file is written, stop work and exit immediately.',
    );
    expect(prompts[0]).toContain(
      'Structured JSON artifacts must include non-empty title and body fields.',
    );
    expect(prompts[0]).toContain(
      'TEKON_ARTIFACT_MANIFEST is an environment variable containing the manifest file path; write the manifest JSON to $TEKON_ARTIFACT_MANIFEST.',
    );
    expect(prompts[0]).toContain(
      'Do not create a file literally named TEKON_ARTIFACT_MANIFEST.',
    );
    expect(prompts[0]).toContain(
      'Do not spawn subagents, delegate review, or wait for external agents inside this node.',
    );
    db.close();
  });

  it('interrupts the workflow when an agent returns a non-zero exit code', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-agent-fail-'));
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-agent-fail-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(): Promise<AgentRunResult> {
          return {
            provider: 'custom',
            exitCode: 1,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const result = await engine.startRun({
      demandText: '失败时不要继续推进',
      mode: 'template',
      workflowSpec: minimalWorkflowSpec('agent-failure'),
    });

    expect(result.workflow.status).toBe('interrupted');
    expect(await repositories.listNodes(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'interrupted' }),
      ]),
    );
    expect(await repositories.listAuditEvents(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'node.interrupted',
          payload: expect.objectContaining({
            error: expect.stringContaining('agent failed'),
          }),
        }),
      ]),
    );
    db.close();
  });

  it('blocks the workflow when an auto-fix repair agent fails', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-repair-fail-'));
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-repair-fail-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          return {
            provider: 'custom',
            exitCode: input.runContext.nodeId.startsWith('repair_') ? 1 : 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: createFailingBuildGateEngine(repositories),
    });

    const result = await engine.startRun({
      demandText: '修复失败时必须阻断',
      mode: 'template',
      workflowSpec: repairWorkflowSpec(),
    });

    expect(result.workflow.status).toBe('blocked');
    expect(await repositories.listNodes(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^repair_/u),
          status: 'interrupted',
        }),
      ]),
    );
    expect(await repositories.listAuditEvents(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'gate.repair.failed' }),
      ]),
    );
    db.close();
  });
});

function writeRoleFixture(rolesDir: string) {
  const pmDir = join(rolesDir, 'pm');
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(
    join(pmDir, 'agent.yaml'),
    ['role: pm', 'name: Test PM', 'description: Test PM role'].join('\n'),
    'utf8',
  );
  writeFileSync(join(pmDir, 'system.md'), 'PM system instructions', 'utf8');
  writeFileSync(
    join(pmDir, 'tools.yaml'),
    ['network: disabled', 'allow: []', 'deny: []'].join('\n'),
    'utf8',
  );

  const rdDir = join(rolesDir, 'rd');
  mkdirSync(join(rdDir, 'skills'), { recursive: true });
  mkdirSync(join(rdDir, 'knowledge'), { recursive: true });
  writeFileSync(
    join(rdDir, 'agent.yaml'),
    [
      'role: rd',
      'name: Test RD',
      'description: Test role',
      'knowledgeFiles:',
      '  - knowledge/engineering.md',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(rdDir, 'system.md'), 'RD system instructions', 'utf8');
  writeFileSync(
    join(rdDir, 'tools.yaml'),
    ['network: disabled', 'allow:', '  - tool: pnpm', '    args: [test]'].join(
      '\n',
    ),
    'utf8',
  );
  writeFileSync(
    join(rdDir, 'skills', 'test.md'),
    ['---', 'id: test-skill', 'priority: 10', '---', 'skill body'].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(rdDir, 'knowledge', 'engineering.md'),
    'knowledge body',
    'utf8',
  );
}

function minimalWorkflowSpec(name: string) {
  return {
    id: name,
    name,
    version: 1,
    retryPolicy: {
      maxAttempts: 1,
      maxRetries: 0,
      backoffMs: 0,
      strategy: 'fixed' as const,
      onExhausted: 'block' as const,
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
            role: 'rd' as const,
            inputs: [],
            outputs: [],
            gates: [],
            dependsOn: [],
          },
        ],
      },
    ],
  };
}

function repairWorkflowSpec() {
  const workflow = minimalWorkflowSpec('repair-failure');
  workflow.phases[0]!.nodes[0]!.gates = [
    {
      type: 'build' as const,
      requiresHumanApproval: false,
      maxRetries: 1,
      autoFix: true,
      retryPolicy: {
        maxAttempts: 2,
        maxRetries: 1,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'block' as const,
      },
    },
  ];
  return workflow;
}

function createFailingBuildGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  return {
    async runGate(input) {
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${Date.now()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: 'failed',
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

function createPassingGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  return {
    async runGate(input) {
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}`,
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
