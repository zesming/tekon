import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  loadWorkflowTemplate,
  migrateDatabase,
  openTekonDatabase,
  type AgentAdapter,
  type AgentRunInput,
} from '../../src/index.js';

// PD-08 §4.4：轻量模板内置 YAML 在引擎层的完整人工确认环——无产物输出的
// human-confirm 节点必须能：暂停待批 → 驳回触发 rd-implement 返工 → 再暂停
// 生成新决策 → 批准后跑到 passed。验证无输出 reviewer 节点不破坏引擎。
describe('PD-08 lightweight-delivery engine human confirmation e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-lightweight-engine-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    return repoPath;
  }

  function buildEngine(
    repoPath: string,
    repositories: ReturnType<typeof createRepositories>,
    adapter: AgentAdapter,
  ) {
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    return createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter,
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });
  }

  it('pauses at the output-less human gate, reworks rd-implement on rejection, then passes on approval', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);

    const mock = createMockAgentAdapter();
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      ...mock,
      async runAgent(input: AgentRunInput) {
        prompts.push(input.prompt);
        return mock.runAgent(input);
      },
    };
    const engine = buildEngine(repoPath, repositories, adapter);

    // 直接加载交付的内置模板（而非手写 spec），证明真实 YAML 可在引擎跑通。
    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });

    // 1) 首跑：pm-plan、rd-implement 完成后在 human-confirm 人工 gate 暂停。
    const first = await engine.startRun({
      demandText: '给小工具加一个减法函数',
      mode: 'template',
      workflowSpec: template,
    });
    expect(first.workflow.status).toBe('paused');
    const initialDecisions = await repositories.listHumanDecisions(first.runId);
    expect(initialDecisions).toHaveLength(1);
    expect(initialDecisions[0]!.status).toBe('pending');

    // 确认三个节点都已参与，且 human-confirm 是无产物输出节点。
    const nodesBefore = await repositories.listNodes(first.runId);
    const nodeIds = nodesBefore.map((node) => node.id);
    expect(nodeIds.some((id) => id.endsWith('pm-plan'))).toBe(true);
    expect(nodeIds.some((id) => id.endsWith('rd-implement'))).toBe(true);
    expect(nodeIds.some((id) => id.endsWith('human-confirm'))).toBe(true);

    // 2) 人工驳回（带备注）→ run blocked。
    await createHumanGate({ repositories }).rejectHumanGate(
      initialDecisions[0]!.id,
      'lightweight-reviewer',
      'LIGHTWEIGHT-REJECT-MARKER: 边界没处理好',
    );
    expect((await repositories.getWorkflowInstance(first.runId))?.status).toBe(
      'blocked',
    );

    // 3) resume：对 rd-implement 发起返工，评审节点重跑后再次暂停待批。
    const reworked = await engine.resumeRun(first.runId);
    expect(reworked.workflow.status).toBe('paused');

    const nodesAfterRework = await repositories.listNodes(first.runId);
    const reworkNodes = nodesAfterRework.filter((node) =>
      node.id.includes('rd-implement_rework_'),
    );
    expect(reworkNodes).toHaveLength(1);
    expect(
      prompts.some((prompt) => prompt.includes('LIGHTWEIGHT-REJECT-MARKER')),
    ).toBe(true);

    // 旧决策保持 rejected，产生一个新的 pending 决策。
    const decisionsAfterRework = await repositories.listHumanDecisions(
      first.runId,
    );
    expect(
      decisionsAfterRework.filter((d) => d.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      decisionsAfterRework.filter((d) => d.status === 'pending'),
    ).toHaveLength(1);

    // 返工有完整审计轨迹。
    const events = await repositories.listAuditEvents(first.runId);
    expect(events.some((e) => e.type === 'node.human-rework.started')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'gate.rework.completed')).toBe(true);

    // 4) 批准新决策后再次 resume：无输出 human 节点不阻断，run 收敛 passed。
    const freshDecision = decisionsAfterRework.find(
      (d) => d.status === 'pending',
    )!;
    await createHumanGate({ repositories }).approveHumanGate(
      freshDecision.id,
      'lightweight-reviewer',
    );
    const approved = await engine.resumeRun(first.runId);
    expect(approved.workflow.status).toBe('passed');

    db.close();
  }, 120_000);

  it('passes straight through when the human gate is approved on the first pause', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const engine = buildEngine(
      repoPath,
      repositories,
      createMockAgentAdapter(),
    );

    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });
    const first = await engine.startRun({
      demandText: '一次通过的小改动',
      mode: 'template',
      workflowSpec: template,
    });
    expect(first.workflow.status).toBe('paused');

    const decision = (await repositories.listHumanDecisions(first.runId))[0]!;
    await createHumanGate({ repositories }).approveHumanGate(
      decision.id,
      'lightweight-reviewer',
    );
    const done = await engine.resumeRun(first.runId);
    expect(done.workflow.status).toBe('passed');

    db.close();
  }, 120_000);
});
