import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  openTekonDatabase,
  migrateDatabase,
  createRepositories,
  buildCodexCommand,
  defaultProviderConfig,
  resolveSafeTekonPath,
} from '../../src/index.js';
import { ingestGeneralNodeOutput } from '../../src/runtime/general-output.js';

const tempDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tekon-gen-out-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('general-output security & Codex path contract', () => {
  it('rejects symlinks in outputDir for both handoff.json and markdown artifacts', async () => {
    const repo = makeTmp();
    const secretFile = join(repo, 'outside.txt');
    writeFileSync(secretFile, 'host file content should never be read', 'utf8');

    const db = openTekonDatabase(join(repo, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const store = createArtifactStore({
      repoPath: repo,
      repositories,
    });

    const outDir = join(repo, '.tekon', 'runs', 'run_1', 'node_1');
    mkdirSync(outDir, { recursive: true });
    symlinkSync(secretFile, join(outDir, 'research.md'));

    await expect(
      ingestGeneralNodeOutput({
        runInput: {
          roleConfig: { role: 'explorer' },
          prompt: 'test',
          worktreeLease: {
            id: 'l1',
            runId: 'run_1',
            nodeId: 'node_1',
            role: 'explorer',
            repoPath: repo,
            worktreePath: repo,
            branchName: 'in-place',
            createdAt: new Date().toISOString(),
          },
          outputDir: outDir,
          commandPolicy: {
            allow: [],
            deny: [],
            requiresHumanApproval: [],
            cwdScope: [repo],
            network: 'disabled',
          },
          runContext: {
            runId: 'run_1',
            nodeId: 'node_1',
            projectId: 'p1',
            repoPath: repo,
            dataDir: join(repo, '.tekon'),
          },
          artifactStore: store,
          requiredArtifactTypes: ['research'],
        },
      }),
    ).rejects.toThrow(/UNSAFE_AGENT_OUTPUT_FILE/u);

    db.close();
  });

  it('redacts secrets in handoff.json summary before returning handoffBrief', async () => {
    const repo = makeTmp();
    const outDir = join(repo, '.tekon', 'runs', 'run_2', 'node_2');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'handoff.json'),
      JSON.stringify({
        summary: 'Found token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234 in sample',
      }),
      'utf8',
    );

    const res = await ingestGeneralNodeOutput({
      runInput: {
        roleConfig: { role: 'explorer' },
        prompt: 'test',
        worktreeLease: {
          id: 'l2',
          runId: 'run_2',
          nodeId: 'node_2',
          role: 'explorer',
          repoPath: repo,
          worktreePath: repo,
          branchName: 'in-place',
          createdAt: new Date().toISOString(),
        },
        outputDir: outDir,
        commandPolicy: {
          allow: [],
          deny: [],
          requiresHumanApproval: [],
          cwdScope: [repo],
          network: 'disabled',
        },
        runContext: {
          runId: 'run_2',
          nodeId: 'node_2',
          projectId: 'p1',
          repoPath: repo,
          dataDir: join(repo, '.tekon'),
        },
      },
    });

    expect(res.handoffBrief).not.toContain('ghp_1234567890');
    expect(res.handoffBrief).toContain('REDACTED');
  });

  it('satisfies Codex adapter 4-segment outputDir contract for nodes, planning, and follow-up', () => {
    const repo = realpathSync(makeTmp());
    const codexCfg = defaultProviderConfig('codex', repo);
    for (const nodeId of ['run_abc_explore', 'plan-attempt-1', 'followup-12345']) {
      const outputDir = resolveSafeTekonPath(repo, `.tekon/runs/run_abc/${nodeId}`);
      mkdirSync(outputDir, { recursive: true });
      const cmd = buildCodexCommand(codexCfg, {
        prompt: 'hello',
        artifactOutputDir: outputDir,
        runContext: { runId: 'run_abc', nodeId },
      });
      expect(cmd.tool).toBe('codex');
      expect(cmd.args).toContain('--add-dir');
    }
  });
});
