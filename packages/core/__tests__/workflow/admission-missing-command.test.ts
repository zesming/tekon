import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
} from '../../src/index.js';

// PD-04：run 前发现 commandRef 缺失必须直接拒绝受理并给出修改示例，
// 不创建运行、不调用 agent；not-applicable 是合法跳过，不阻断。
describe('PD-04 admission blocks missing repo commands', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const release of cleanup.splice(0).reverse()) release();
  });

  function setup(profileEntry?: unknown) {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-missing-command-'));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    if (profileEntry !== undefined) {
      writeFileSync(
        join(repoPath, '.tekon', 'repo-profile.yaml'),
        JSON.stringify({ version: 1, commands: { build: profileEntry } }),
      );
    }
    const db = openTekonDatabase({ filename: ':memory:' });
    cleanup.push(() => db.close());
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const adapter = createMockAgentAdapter();
    const runAgent = vi.spyOn(adapter, 'runAgent');
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter,
      agentProvider: 'mock',
    });
    const template = parseWorkflowTemplate({
      id: 'missing-build',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build' }],
            },
          ],
        },
      ],
    });
    return { repoPath, db, engine, adapter, runAgent, template };
  }

  it('refuses admission when a required commandRef is missing and shows how to fix it', async () => {
    const { db, engine, runAgent, template } = setup(undefined);

    await expect(
      engine.prepareRun({
        demandText: '缺少构建命令',
        mode: 'template',
        workflowSpec: template,
      }),
    ).rejects.toThrow(/MISSING_REPO_COMMAND|repo-profile|commandRef/u);

    expect(runAgent).not.toHaveBeenCalled();
    expect(
      db.prepare('select count(*) as count from workflow_instances').get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('select count(*) as count from run_admissions').get(),
    ).toEqual({ count: 0 });
  });

  it('still admits when the commandRef is marked not-applicable', async () => {
    const { engine, template } = setup({
      notApplicable: true,
      reason: 'docs-only repository',
    });

    const prepared = await engine.prepareRun({
      demandText: '文档仓库无需构建',
      mode: 'template',
      workflowSpec: template,
    });
    expect(prepared.runId).toBeTruthy();
  });

  it('admits when the commandRef resolves to a user-written command', async () => {
    const { engine, template } = setup({
      tool: 'python3',
      args: ['build.py'],
    });

    const prepared = await engine.prepareRun({
      demandText: 'Python 仓库构建',
      mode: 'template',
      workflowSpec: template,
    });
    expect(prepared.runId).toBeTruthy();
  });

  it('does not block on a missing commandRef attached to a non-command semantic gate', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-missing-semantic-'));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    cleanup.push(() => db.close());
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      agentProvider: 'mock',
    });
    // human 语义门禁携带缺失的 commandRef，但运行期从不执行该命令。
    const semanticTemplate = parseWorkflowTemplate({
      id: 'semantic-ref',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          nodes: [
            {
              id: 'n1',
              role: 'goal',
              gates: [
                {
                  type: 'human',
                  commandRef: 'build',
                  requiresHumanApproval: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const prepared = await engine.prepareRun({
      demandText: '语义门禁的命令引用不阻断受理',
      mode: 'template',
      workflowSpec: semanticTemplate,
    });
    expect(prepared.runId).toBeTruthy();
  });

  it('does not block when only the security-scan commandRef is missing (builtin fallback)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-missing-security-'));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    const db = openTekonDatabase({ filename: ':memory:' });
    cleanup.push(() => db.close());
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      agentProvider: 'mock',
    });
    const securityTemplate = parseWorkflowTemplate({
      id: 'security-only',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          nodes: [
            {
              id: 'n1',
              role: 'goal',
              gates: [{ type: 'security-scan', commandRef: 'security' }],
            },
          ],
        },
      ],
    });

    const prepared = await engine.prepareRun({
      demandText: '安全扫描内置兜底',
      mode: 'template',
      workflowSpec: securityTemplate,
    });
    expect(prepared.runId).toBeTruthy();
  });
});
