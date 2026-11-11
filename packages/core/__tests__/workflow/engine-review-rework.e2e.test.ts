import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
  type AgentAdapter,
} from '../../src/index.js';

describe('standard delivery review rework e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-rework-'));
    tempDirs.push(repoPath);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'tekon@example.com');
    git('config', 'user.name', 'Tekon Test');
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    // Give the repo checks a trivial command so the run reaches the PMO
    // checkpoint with real gate results.
    mkdirSync(join(repoPath, '.tekon'));
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify({
        commands: Object.fromEntries(
          ['build', 'lint', 'test'].map((ref) => [
            ref,
            { tool: 'git', args: ['--version'], description: `fixture ${ref}` },
          ]),
        ),
      }),
    );
    git('add', '.');
    git('commit', '-m', 'init');
    return repoPath;
  }

  /**
   * Mock adapter whose listed review nodes request changes on their first run.
   * `targetNodeId` names the reviewed node the way a real reviewer does
   * (reviewProcess.targetNodeId); without it the target is inferred.
   */
  function changesRequestedOnce(reviewNodeIds: string[], targetNodeId?: string) {
    const mock = createMockAgentAdapter();
    const requested = new Set<string>();
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input) {
        const reviewNodeId = reviewNodeIds.find((id) =>
          input.runContext.nodeId.endsWith(`_${id}`),
        );
        if (!reviewNodeId || requested.has(reviewNodeId)) {
          return mock.runAgent(input);
        }
        const store = input.artifactStore!;
        return mock.runAgent({
          ...input,
          artifactStore: {
            ...store,
            async writeArtifact(artifact) {
              const payload = JSON.parse(artifact.content);
              payload.decision = 'changes-requested';
              if (targetNodeId) {
                payload.reviewProcess = {
                  ...payload.reviewProcess,
                  targetNodeId: `${input.runContext.runId}_${targetNodeId}`,
                };
              }
              payload.findings = [
                { severity: 'important', message: 'Plan misses the empty-input boundary.' },
              ];
              requested.add(reviewNodeId);
              return store.writeArtifact({
                ...artifact,
                content: JSON.stringify(payload),
              });
            },
          },
        });
      },
    };
    return { adapter, requested };
  }

  /**
   * Runs standard-delivery to a terminal state. `pauseAfter` lists review
   * nodes whose checkpoint (reached after their rework passed) pauses the run;
   * each pause is resumed, so rework ids must survive the plan rebuild.
   */
  async function runStandardDelivery(
    adapter: AgentAdapter,
    options: { pauseAfter?: string[] } = {},
  ) {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    let pauseRequested = false;
    let resumes = 0;
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter,
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
      isPauseRequested: () => pauseRequested,
      onNodeCheckpoint: async (nodeId: string) => {
        if (options.pauseAfter?.some((id) => nodeId.endsWith(`_${id}`))) {
          pauseRequested = true;
        }
      },
    });
    try {
      let result = await engine.startRun({
        demandText: 'Add an empty-input guard',
        mode: 'template',
        templateName: 'standard-delivery',
      });
      while (result.workflow.status === 'paused' && resumes < 5) {
        pauseRequested = false;
        resumes++;
        result = await engine.resumeRun(result.runId);
      }
      return {
        result,
        resumes,
        events: await repositories.listAuditEvents(result.runId),
        nodes: await repositories.listNodes(result.runId),
        gates: await repositories.listGateResults(result.runId),
      };
    } finally {
      db.close();
    }
  }

  it.each(['rd-technical-review', 'reviewer-change-review'])(
    'finishes the default workflow after %s requests changes once',
    async (reviewNodeId) => {
      const { adapter, requested } = changesRequestedOnce([reviewNodeId]);
      const { result, events, nodes, gates } = await runStandardDelivery(adapter);

      expect([...requested]).toEqual([reviewNodeId]);
      expect(events.map((event) => event.type)).toContain('gate.passed-after-rework');
      const reworkNodes = nodes.filter((node) => node.id.includes('_rework_'));
      expect(reworkNodes).toHaveLength(1);
      expect(reworkNodes[0].status).toBe('passed');
      const pmoGates = gates.filter((gate) => gate.nodeId.endsWith('_pmo-checkpoint'));
      expect(pmoGates.map((gate) => `${gate.gateType}:${gate.status}`)).toContain(
        'process-completeness:passed',
      );
      expect(result.workflow.status).toBe('passed');
    },
    120_000,
  );

  it.each([
    { name: 'in one pass', pause: false },
    { name: 'with a pause and resume after each rework', pause: true },
  ])('keeps one rework node per review when two reviews of the same target request changes ($name)', async ({ pause }) => {
    const reviewers = ['pm-requirement-intent-review', 'rd-requirement-interface-review'];
    const { adapter, requested } = changesRequestedOnce(reviewers, 'pm-demand-card');
    const { result, nodes, resumes } = await runStandardDelivery(adapter, {
      pauseAfter: pause ? reviewers : [],
    });

    expect(resumes).toBe(pause ? 2 : 0);
    expect([...requested].sort()).toEqual([...reviewers].sort());
    const reworkNodes = nodes.filter((node) => node.id.includes('_rework_'));
    expect(reworkNodes).toHaveLength(2);
    expect(new Set(reworkNodes.map((node) => node.id)).size).toBe(2);
    expect(reworkNodes.every((node) => node.id.includes('_pm-demand-card_rework_1_'))).toBe(true);
    expect(reworkNodes.map((node) => node.status)).toEqual(['passed', 'passed']);
    expect(result.workflow.status).toBe('passed');
  }, 120_000);
});
