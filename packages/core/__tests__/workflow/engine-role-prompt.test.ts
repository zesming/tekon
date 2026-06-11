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
  type AgentRunInput,
  type ArtifactType,
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
      'For demand-card and prd JSON artifacts, include acceptanceCriteria with id and description fields.',
    );
    expect(prompts[0]).toContain(
      'Do not spawn subagents, delegate review, or wait for external agents inside this node.',
    );
    expect(prompts[0]).toContain(
      'Do not continue editing, formatting, running checks, printing diffs, or explaining',
    );
    db.close();
  });

  it('adds strict role-scoped review artifact instructions with target context', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-review-artifact-prompt-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-review-artifact-prompt-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: Array<{ nodeId: string; prompt: string }> = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push({
            nodeId: input.runContext.nodeId,
            prompt: input.prompt,
          });
          const artifacts = [];
          for (const type of input.requiredArtifactTypes ?? []) {
            artifacts.push(
              await input.artifactStore!.writeArtifact({
                runId: input.runContext.runId,
                nodeId: input.runContext.nodeId,
                type,
                content: validArtifactContentForPromptTest(type, input),
              }),
            );
          }
          return {
            provider: 'custom',
            exitCode: 0,
            durationMs: 1,
            outputFiles: artifacts.map((artifact) => artifact.path),
            artifacts,
            timedOut: false,
          };
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    await engine.startRun({
      demandText: '评审类 artifact 必须严格符合 schema',
      mode: 'template',
      workflowSpec: {
        id: 'review-artifact-prompt',
        name: 'Review Artifact Prompt',
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
            id: 'pm-scope',
            name: 'PM Scope',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'pm-demand-card',
                role: 'pm',
                inputs: [],
                outputs: [
                  { id: 'demand', type: 'demand-card' },
                  { id: 'prd', type: 'prd' },
                ],
                gates: [],
                dependsOn: [],
              },
            ],
          },
          {
            id: 'pm-review',
            name: 'PM Review',
            dependsOn: ['pm-scope'],
            parallel: false,
            nodes: [
              {
                id: 'pm-demand-review',
                role: 'pm',
                inputs: [
                  {
                    id: 'demand',
                    type: 'demand-card',
                    fromNodeId: 'pm-demand-card',
                  },
                  { id: 'prd', type: 'prd', fromNodeId: 'pm-demand-card' },
                ],
                outputs: [{ id: 'review', type: 'demand-review' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    const targetNodeId = prompts.find((item) =>
      item.nodeId.endsWith('_pm-demand-card'),
    )?.nodeId;
    const reviewPrompt = prompts.find((item) =>
      item.nodeId.endsWith('_pm-demand-review'),
    )?.prompt;
    expect(targetNodeId).toBeDefined();
    expect(reviewPrompt).toBeDefined();
    expect(reviewPrompt!).toContain(
      'For role-scoped review JSON artifacts, include reviewScope, reviewProcess, decision, and findings using the exact schema fields.',
    );
    expect(reviewPrompt!).toContain('"reviewScope": "demand-quality"');
    expect(reviewPrompt!).toContain('"reviewerRole": "pm"');
    expect(reviewPrompt!).toContain(`"targetNodeId": "${targetNodeId}"`);
    expect(reviewPrompt!).toContain('"targetRole": "pm"');
    expect(reviewPrompt!).toContain(
      'findings[].severity must be one of: critical, important, minor.',
    );
    expect(reviewPrompt!).toContain(
      'findings[].ownerRole is optional; if present, it must be one of: pm, rd, qa, reviewer, pmo.',
    );
    expect(reviewPrompt!).toContain(
      'Do not use reviewRole, reviewedArtifacts, or reviewScope as an array/object as substitutes for these schema fields.',
    );
    db.close();
  });

  it('adds strict QA test-plan artifact instructions', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-test-plan-prompt-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-test-plan-prompt-roles-'),
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
      demandText: '测试方案必须符合 schema',
      mode: 'template',
      workflowSpec: {
        id: 'test-plan-prompt',
        name: 'Test Plan Prompt',
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
            id: 'qa',
            name: 'QA',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'qa-test-plan',
                role: 'qa',
                inputs: [],
                outputs: [{ id: 'test-plan', type: 'test-plan' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    expect(prompts[0]).toContain(
      'For test-plan JSON artifacts, include testBasis and testCases using the exact schema fields.',
    );
    expect(prompts[0]).toContain(
      'testCases[].id and testCases[].description are required.',
    );
    expect(prompts[0]).toContain(
      'Do not use testScenarios, gatePlan, or acceptanceCoverage as substitutes for testCases.',
    );
    db.close();
  });

  it('includes prior node status context for process checkpoints', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-process-prompt-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-process-prompt-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: Array<{ nodeId: string; prompt: string }> = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push({
            nodeId: input.runContext.nodeId,
            prompt: input.prompt,
          });
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
      demandText: '补充流程检查点',
      mode: 'template',
      workflowSpec: {
        id: 'process-prompt-context',
        name: 'Process Prompt Context',
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
                id: 'pm-review',
                role: 'pm',
                inputs: [],
                outputs: [],
                gates: [],
                dependsOn: [],
              },
            ],
          },
          {
            id: 'pmo',
            name: 'PMO',
            dependsOn: ['pm'],
            parallel: false,
            nodes: [
              {
                id: 'pmo-checkpoint',
                role: 'pmo',
                inputs: [],
                outputs: [
                  { id: 'process-checkpoint', type: 'process-checkpoint' },
                ],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    const pmNodeId = prompts.find((item) =>
      item.nodeId.endsWith('_pm-review'),
    )?.nodeId;
    const pmoPrompt = prompts.find((item) =>
      item.nodeId.endsWith('_pmo-checkpoint'),
    )?.prompt;
    expect(pmNodeId).toBeDefined();
    expect(pmoPrompt).toBeDefined();
    expect(pmoPrompt!).toContain('Prior workflow nodes:');
    expect(pmoPrompt!).toContain(`${pmNodeId} role=pm status=passed`);
    expect(pmoPrompt!).toContain(
      'For process-checkpoint.requiredNodes, include every prior workflow node listed above with the exact nodeId and status',
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
    expect(prompts[0]).toContain(
      'For RD code-changes nodes, this artifact protocol overrides role skills or local instructions that would otherwise require tests, nested or delegated reviews, dependency installation, or extra diagnostics before manifest creation.',
    );
    expect(prompts[0]).toContain(
      'Do not run dependency installation, test, lint, typecheck, build, or package-manager commands before writing required code-changes artifacts and the manifest; Tekon gates run validation after artifact ingestion.',
    );
    db.close();
  });

  it('does not apply RD pre-manifest command bans to QA and reviewer artifact prompts', async () => {
    const repoPath = mkdtempSync(
      join(tmpdir(), 'tekon-engine-artifact-role-scope-'),
    );
    const rolesDir = mkdtempSync(
      join(tmpdir(), 'tekon-engine-artifact-role-scope-roles-'),
    );
    tempDirs.push(repoPath, rolesDir);
    writeRoleFixture(rolesDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: Array<{ role: string; prompt: string }> = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      adapter: {
        async runAgent(input): Promise<AgentRunResult> {
          prompts.push({
            role: input.roleConfig.role,
            prompt: input.prompt,
          });
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
      demandText: '验证 artifact prompt 作用域',
      mode: 'template',
      workflowSpec: {
        id: 'artifact-role-scope',
        name: 'Artifact Role Scope',
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
            id: 'qa',
            name: 'QA',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'qa-test',
                role: 'qa',
                inputs: [],
                outputs: [
                  { id: 'test', type: 'test-report' },
                  { id: 'evidence', type: 'ac-evidence' },
                ],
                gates: [],
                dependsOn: [],
              },
            ],
          },
          {
            id: 'review',
            name: 'Review',
            dependsOn: ['qa'],
            parallel: false,
            nodes: [
              {
                id: 'reviewer-check',
                role: 'reviewer',
                inputs: [],
                outputs: [{ id: 'review', type: 'review-report' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });

    for (const role of ['qa', 'reviewer']) {
      const prompt = prompts.find((item) => item.role === role)?.prompt;
      expect(prompt).toContain('Tekon artifact protocol');
      expect(prompt).not.toContain(
        'For RD code-changes nodes, this artifact protocol overrides role skills or local instructions that would otherwise require tests, nested or delegated reviews, dependency installation, or extra diagnostics before manifest creation.',
      );
      expect(prompt).not.toContain(
        'Do not run dependency installation, test, lint, typecheck, build, or package-manager commands before writing required code-changes artifacts and the manifest; Tekon gates run validation after artifact ingestion.',
      );
    }
    expect(prompts.find((item) => item.role === 'qa')?.prompt).toContain(
      'For test-report and ac-evidence JSON artifacts, criteriaEvidence[] must use exact fields criterionId, status, and evidence.',
    );
    expect(prompts.find((item) => item.role === 'qa')?.prompt).toContain(
      'criteriaEvidence[].evidence must be a non-empty string; put anchors in top-level outputPaths, gateResultIds, or artifactIds.',
    );
    expect(prompts.find((item) => item.role === 'qa')?.prompt).toContain(
      'criteriaEvidence[].status must be one of passed, failed, blocked, or unknown; do not use id, evidenceSummary, coverage, or extended status labels as substitutes.',
    );
    expect(prompts.find((item) => item.role === 'qa')?.prompt).toContain(
      'For test-report JSON artifacts, summary is optional but must be a string when present; do not write summary as an object.',
    );
    expect(prompts.find((item) => item.role === 'qa')?.prompt).toContain(
      'For ac-evidence and qa-release-signoff JSON artifacts, each criteriaEvidence item must include at least one evidence anchor',
    );
    expect(
      prompts.find((item) => item.role === 'reviewer')?.prompt,
    ).not.toContain(
      'For test-report and ac-evidence JSON artifacts, criteriaEvidence[] must use exact fields criterionId, status, and evidence.',
    );
    expect(
      prompts.find((item) => item.role === 'reviewer')?.prompt,
    ).not.toContain(
      'For test-report JSON artifacts, summary is optional but must be a string when present; do not write summary as an object.',
    );
    expect(
      prompts.find((item) => item.role === 'reviewer')?.prompt,
    ).not.toContain(
      'For ac-evidence and qa-release-signoff JSON artifacts, each criteriaEvidence item must include at least one evidence anchor',
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

  const qaDir = join(rolesDir, 'qa');
  mkdirSync(qaDir, { recursive: true });
  writeFileSync(
    join(qaDir, 'agent.yaml'),
    ['role: qa', 'name: Test QA', 'description: Test QA role'].join('\n'),
    'utf8',
  );
  writeFileSync(join(qaDir, 'system.md'), 'QA system instructions', 'utf8');

  const reviewerDir = join(rolesDir, 'reviewer');
  mkdirSync(reviewerDir, { recursive: true });
  writeFileSync(
    join(reviewerDir, 'agent.yaml'),
    [
      'role: reviewer',
      'name: Test Reviewer',
      'description: Test Reviewer role',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(reviewerDir, 'system.md'),
    'Reviewer system instructions',
    'utf8',
  );

  const pmoDir = join(rolesDir, 'pmo');
  mkdirSync(pmoDir, { recursive: true });
  writeFileSync(
    join(pmoDir, 'agent.yaml'),
    ['role: pmo', 'name: Test PMO', 'description: Test PMO role'].join('\n'),
    'utf8',
  );
  writeFileSync(join(pmoDir, 'system.md'), 'PMO system instructions', 'utf8');
}

function validArtifactContentForPromptTest(
  type: ArtifactType,
  input: AgentRunInput,
): string {
  const base = {
    title: type,
    body: `Prompt test artifact for ${type}.`,
  };
  if (type === 'demand-card' || type === 'prd') {
    return JSON.stringify(
      {
        ...base,
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Artifact prompt instructions are present.',
          },
        ],
      },
      null,
      2,
    );
  }
  if (type === 'demand-review') {
    const targetNodeId =
      input.nodeInputs?.find((item) => item.type === 'demand-card')
        ?.fromNodeId ?? input.runContext.nodeId;
    const targetRole =
      input.priorNodes?.find((item) => item.id === targetNodeId)?.role ?? 'pm';
    return JSON.stringify(
      {
        ...base,
        reviewScope: 'demand-quality',
        reviewProcess: {
          mode: 'independent-process',
          reviewerId: 'prompt-test-pm-reviewer',
          reviewerRole: 'pm',
          targetNodeId,
          targetRole,
        },
        decision: 'approved',
        findings: [],
      },
      null,
      2,
    );
  }
  return JSON.stringify(base, null, 2);
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
