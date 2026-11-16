import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
} from '../../src/index.js';
import { normalizeExecutableTemplate } from '../../src/workflow/template.js';
import {
  deriveRepairNode,
  deriveReworkNode,
  runPlanToExecutionPlan,
  templateToPlan,
} from '../../src/workflow/execution-plan.js';
import {
  projectRunPlanV3,
  computeRunPlanDigest,
  validateRunPlanV3,
} from '../../src/workflow/run-plan.js';
import type { ExecutableNode } from '../../src/workflow/workflow-runtime.js';

// CD-09 8b-1：节点 workspace 声明（worktree 默认 | in-place | none）的
// schema、执行计划传播与落库。租约行为在 8b-2/8b-3 覆盖。
const openDbs: ReturnType<typeof openTekonDatabase>[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function templateYaml(workspace: string | null): string {
  return `
id: ws-decl
name: Workspace Declaration
phases:
  - id: dev
    name: Dev
    nodes:
      - id: n1
        role: goal
        ${workspace === null ? '' : `workspace: ${workspace}`}
`;
}

describe('CD-09 node workspace declaration', () => {
  it('defaults workspace to worktree when the template omits the field', () => {
    const template = parseWorkflowTemplate(templateYaml(null));
    expect(template.phases[0].nodes[0].workspace).toBe('worktree');
  });

  it.each(['worktree', 'in-place', 'none'] as const)(
    'accepts workspace=%s and keeps it through normalization',
    (workspace) => {
      const parsed = parseWorkflowTemplate(templateYaml(workspace));
      expect(parsed.phases[0].nodes[0].workspace).toBe(workspace);

      const normalized = normalizeExecutableTemplate(parsed);
      expect(normalized.phases[0].nodes[0].workspace).toBe(workspace);
    },
  );

  it('rejects an unknown workspace value at parse time', () => {
    expect(() => parseWorkflowTemplate(templateYaml('remote'))).toThrow(
      /INVALID_WORKFLOW_TEMPLATE|workspace/u,
    );
  });

  it('carries workspace onto executable nodes in both plan builders', () => {
    const inPlace = parseWorkflowTemplate(templateYaml('in-place'));
    const v2Plan = templateToPlan(inPlace, 'run_x');
    expect(v2Plan.phases[0].nodes[0].workspace).toBe('in-place');

    const none = parseWorkflowTemplate(templateYaml('none'));
    const canonical = projectRunPlanV3(none, {}, []);
    const v3Plan = runPlanToExecutionPlan(canonical, 'run_y');
    expect(v3Plan.phases[0].nodes[0].workspace).toBe('none');
  });

  it('persists workspace through the nodes table and reads it back', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    openDbs.push(db);
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const now = '2026-11-16T00:00:00.000Z';
    await repositories.createDemand({
      id: 'd',
      title: 'd',
      body: 'd',
      createdAt: now,
    });
    await repositories.createProject({
      id: 'p',
      name: 'p',
      repoPath: '/tmp/ws-persist',
      createdAt: now,
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'p',
      demandId: 'd',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });

    for (const workspace of ['worktree', 'in-place', 'none'] as const) {
      await repositories.createNode({
        id: `node_${workspace}`,
        runId: 'run_1',
        role: 'goal',
        workspace,
        status: 'pending',
        inputs: [],
        outputs: [],
        gates: [],
        dependencies: [],
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const read = await repositories.getNode(`node_${workspace}`);
      expect(read?.workspace).toBe(workspace);
    }
  });

  it('defaults legacy node input without workspace to worktree (old callers stay isolated)', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    openDbs.push(db);
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const now = '2026-11-16T00:00:00.000Z';
    await repositories.createDemand({
      id: 'd',
      title: 'd',
      body: 'd',
      createdAt: now,
    });
    await repositories.createProject({
      id: 'p',
      name: 'p',
      repoPath: '/tmp/ws-legacy',
      createdAt: now,
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'p',
      demandId: 'd',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.createNode({
      id: 'legacy_node',
      runId: 'run_1',
      role: 'rd',
      status: 'pending',
      inputs: [],
      outputs: [],
      gates: [],
      dependencies: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    expect((await repositories.getNode('legacy_node'))?.workspace).toBe(
      'worktree',
    );
  });

  it('rework nodes inherit the source workspace; repair nodes keep the worktree default', () => {
    const source: ExecutableNode = {
      id: 'run_1_source',
      role: 'rd',
      phaseId: 'run_1_dev',
      workspace: 'in-place',
      inputs: [],
      outputs: [],
      gates: [],
      dependsOn: [],
    };
    const rework = deriveReworkNode(source, 'run_1_review', 1, 'result_1');
    expect(rework.workspace).toBe('in-place');

    const repair = deriveRepairNode(source.id, 'result_1', source.role);
    expect(repair.workspace).toBe('worktree');
  });

  it('accepts a frozen legacy snapshot whose nodes omit workspace and defaults them to worktree', () => {
    const template = parseWorkflowTemplate(templateYaml(null));
    const frozen = projectRunPlanV3(template, {}, []);
    // 模拟 workspace 字段引入前冻结的快照：删掉节点上的键并重算 digest。
    for (const node of frozen.template.phases.flatMap((phase) => phase.nodes)) {
      delete (node as { workspace?: string }).workspace;
    }
    frozen.digest = computeRunPlanDigest(frozen);

    const validated = validateRunPlanV3(frozen);
    expect(validated.template.phases.flatMap((phase) => phase.nodes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspace: 'worktree' }),
      ]),
    );
  });

  it('rejects a snapshot whose explicit workspace was tampered while keeping the frozen digest', () => {
    const template = parseWorkflowTemplate(templateYaml('none'));
    const frozen = projectRunPlanV3(template, {}, []);
    const authenticatedDigest = frozen.digest;
    // 只改字节不重算 digest：兼容路径只补“缺失”键，显式值的篡改必须被
    // 冻结原字节哈希认证拦下（重算 digest 的自洽重写等同重写整份计划，
    // 与任何模板字段一样超出投影检查的威胁模型）。
    frozen.template.phases[0].nodes[0].workspace = 'in-place';
    frozen.digest = authenticatedDigest;

    expect(() => validateRunPlanV3(frozen)).toThrow(
      /PLAN_DIGEST_MISMATCH: digest/,
    );
  });
});
