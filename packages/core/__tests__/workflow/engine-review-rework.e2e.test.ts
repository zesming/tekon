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

  it.each(['rd-technical-review', 'reviewer-change-review'])(
    'finishes the default workflow after %s requests changes once',
    async (reviewNodeId) => {
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

      const db = openTekonDatabase({ filename: ':memory:' });
      migrateDatabase(db);
      try {
        const repositories = createRepositories(db);
        const audit = createAuditLogger({ repositories });
        const gateway = createCommandGateway({ repositories });
        const mock = createMockAgentAdapter();
        let requestedChanges = 0;
        const adapter: AgentAdapter = {
          ...mock,
          async runAgent(input) {
            const isTarget =
              input.runContext.nodeId.endsWith(`_${reviewNodeId}`) &&
              requestedChanges === 0;
            if (!isTarget) {
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
                  payload.findings = [
                    { severity: 'important', message: 'Plan misses the empty-input boundary.' },
                  ];
                  requestedChanges++;
                  return store.writeArtifact({
                    ...artifact,
                    content: JSON.stringify(payload),
                  });
                },
              },
            });
          },
        };
        const engine = createWorkflowEngine({
          repoPath,
          dataDir: '.tekon',
          repositories,
          audit,
          adapter,
          gateEngine: createGateEngine({ repositories, gateway }),
          worktreeManager: createWorktreeManager({ repositories, gateway }),
        });

        const result = await engine.startRun({
          demandText: 'Add an empty-input guard',
          mode: 'template',
          templateName: 'standard-delivery',
        });

        expect(requestedChanges).toBe(1);
        const events = await repositories.listAuditEvents(result.runId);
        expect(events.map((event) => event.type)).toContain('gate.passed-after-rework');
        const reworkNodes = (await repositories.listNodes(result.runId)).filter((node) =>
          node.id.includes('_rework_'),
        );
        expect(reworkNodes).toHaveLength(1);
        expect(reworkNodes[0].status).toBe('passed');
        const pmoGates = (await repositories.listGateResults(result.runId)).filter(
          (gate) => gate.nodeId.endsWith('_pmo-checkpoint'),
        );
        expect(pmoGates.map((gate) => `${gate.gateType}:${gate.status}`)).toContain(
          'process-completeness:passed',
        );
        expect(result.workflow.status).toBe('passed');
      } finally {
        db.close();
      }
    },
    120_000,
  );
});
