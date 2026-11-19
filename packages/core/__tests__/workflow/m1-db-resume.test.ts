import { afterEach, describe, expect, it } from 'vitest';

import { createAuditLogger } from '../../src/audit/logger.js';
import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { TekonRepositories } from '../../src/db/repositories.js';
import {
  canonicalJson,
  computeRunPlanDigest,
  projectRunPlanV2,
  projectRunPlanV3,
  classifyExecutionBinding,
  type RunPlanV2,
  type RunPlanV3,
} from '../../src/workflow/run-plan.js';
import {
  persistPlan,
  runPlanToExecutionPlan,
  templateToPlan,
  validateAndBuildExecutionPlan,
} from '../../src/workflow/execution-plan.js';
import { parseWorkflowTemplate } from '../../src/workflow/template.js';

// MF-1 回归：parallel 删除前冻结、存进 SQLite 的 v2/v3 计划，必须能通过
// validateAndBuildExecutionPlan 的 digest 复核并恢复，classifyExecutionBinding
// 不得判 invalid。validate 层测试只覆盖函数本身，这里覆盖 DB 级恢复链。
const openDbs: ReturnType<typeof openTekonDatabase>[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** 在投影产出的计划上注入旧版本遗留的 parallel 键并重算冻结 digest。 */
function freezeWithLegacyParallel<T extends RunPlanV2 | RunPlanV3>(plan: T): T {
  const legacy = structuredClone(plan) as T;
  for (const phase of legacy.template.phases) {
    (phase as { parallel?: boolean }).parallel = false;
  }
  for (const phase of legacy.phases) {
    (phase as { parallel?: boolean }).parallel = false;
  }
  (legacy as { digest: string }).digest = computeRunPlanDigest(legacy);
  return legacy;
}

const minimalTemplate = () =>
  parseWorkflowTemplate({
    id: 'legacy-min',
    phases: [
      {
        id: 'dev',
        nodes: [
          {
            id: 'source',
            role: 'goal',
            inputs: [],
            outputs: [],
            gates: [],
            dependsOn: [],
          },
        ],
      },
    ],
  });

async function seedWorkflow(
  snapshot: RunPlanV2 | RunPlanV3,
  persist: (repositories: TekonRepositories, runId: string) => Promise<void>,
) {
  const db = openTekonDatabase({ filename: ':memory:' });
  openDbs.push(db);
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const now = new Date().toISOString();
  const runId = 'legacy-parallel-run';
  await repositories.createProject({
    id: 'p',
    name: 'p',
    repoPath: '/tmp/legacy-parallel',
    createdAt: now,
  });
  await repositories.createDemand({
    id: 'd',
    title: 'd',
    body: 'd',
    createdAt: now,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: 'p',
    demandId: 'd',
    status: 'paused',
    planSnapshot: canonicalJson(snapshot),
    planDigest: snapshot.digest,
    createdAt: now,
    updatedAt: now,
  });
  await persist(repositories, runId);
  await audit.append({ runId, type: 'run.started', payload: {} });
  return { repositories, audit, runId };
}

describe('MF-1 DB-level resume of frozen plans carrying the removed parallel key', () => {
  it('recovers a frozen v3 snapshot through validateAndBuildExecutionPlan', async () => {
    const template = minimalTemplate();
    const legacy = freezeWithLegacyParallel(projectRunPlanV3(template, {}, []));

    const { repositories, audit, runId } = await seedWorkflow(
      legacy,
      async (repo, id) => {
        await persistPlan(
          id,
          runPlanToExecutionPlan(legacy as RunPlanV3, id),
          repo,
        );
      },
    );

    // 修复前在此抛 PLAN_VERIFICATION_FAILED: plan.digest。
    const rebuilt = await validateAndBuildExecutionPlan(
      runId,
      repositories,
      audit,
    );
    expect(rebuilt.phases).toHaveLength(1);

    const binding = classifyExecutionBinding({
      planSnapshot: canonicalJson(legacy),
      planDigest: legacy.digest,
      kind: legacy.mode,
      hasAdmission: true,
    });
    expect(binding).toBe('frozen');
  });

  it('recovers a frozen v2 snapshot and classifies it as legacy-unbound', async () => {
    const template = minimalTemplate();
    const legacy = freezeWithLegacyParallel(projectRunPlanV2(template));

    const { repositories, audit, runId } = await seedWorkflow(
      legacy,
      async (repo, id) => {
        await persistPlan(id, templateToPlan(template, id), repo);
      },
    );

    await expect(
      validateAndBuildExecutionPlan(runId, repositories, audit),
    ).resolves.toBeTruthy();
    const binding = classifyExecutionBinding({
      planSnapshot: canonicalJson(legacy),
      planDigest: legacy.digest,
      kind: legacy.mode,
      hasAdmission: true,
    });
    expect(binding).toBe('legacy-unbound');
  });
});
