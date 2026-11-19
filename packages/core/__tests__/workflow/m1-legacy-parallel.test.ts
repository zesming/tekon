import { describe, expect, it } from 'vitest';

import {
  computeRunPlanDigest,
  projectRunPlanV2,
  projectRunPlanV3,
  validateRunPlanV2,
  validateRunPlanV3,
  type RunPlanV2,
  type RunPlanV3,
} from '../../src/workflow/run-plan.js';
import type { WorkflowTemplate } from '../../src/index.js';

// CD-24 兼容回归：本版本前冻结的 v2/v3 快照在 phase 对象上携带 parallel 键。
// 夹具用当前投影产出真实形状（键序一致）后注入遗留 parallel 并重算 digest，
// 模拟旧版本冻结的快照；恢复校验必须接受，且 digest 完整性不降级。
describe('legacy run plan snapshots carrying the removed parallel key', () => {
  const baseTemplate: WorkflowTemplate = {
    id: 'legacy',
    name: 'legacy',
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
        id: 'p1',
        name: 'P1',
        dependsOn: [],
        nodes: [
          {
            id: 'n1',
            role: 'goal',
            inputs: [],
            outputs: [],
            gates: [],
            dependsOn: [],
          },
        ],
      },
    ],
  };

  /** 模拟旧版本：在模板 phase 与顶层 phase 摘要上写回 parallel。 */
  function injectLegacyParallel<T extends RunPlanV2 | RunPlanV3>(plan: T): T {
    const copy = structuredClone(plan) as T;
    for (const phase of copy.template.phases) {
      (phase as { parallel?: boolean }).parallel = false;
    }
    for (const phase of copy.phases) {
      (phase as { parallel?: boolean }).parallel = false;
    }
    (copy as { digest: string }).digest = computeRunPlanDigest(copy);
    return copy;
  }

  it('validates a frozen v3 snapshot with parallel in template and phase summaries', () => {
    const projected = projectRunPlanV3(
      baseTemplate,
      { agent: 'mock', mode: 'workflow', templateId: 'legacy' },
      [],
    );
    const legacy = injectLegacyParallel(projected);

    const validated = validateRunPlanV3(legacy);
    expect(validated.digestVersion).toBe(3);
    expect(validated.phases[0]).not.toHaveProperty('parallel');
  });

  it('validates a frozen v2 snapshot with the legacy parallel key', () => {
    const projected = projectRunPlanV2(baseTemplate, {
      agent: 'mock',
      mode: 'goal',
      templateId: 'legacy',
    });
    const legacy = injectLegacyParallel(projected);

    const validated = validateRunPlanV2(legacy);
    expect(validated.digestVersion).toBe(2);
  });

  it('rejects a tampered legacy snapshot despite the parallel compat strip', () => {
    const legacy = injectLegacyParallel(
      projectRunPlanV3(
        baseTemplate,
        { agent: 'mock', mode: 'workflow', templateId: 'legacy' },
        [],
      ),
    );
    // 篡改角色链但保留原 digest：完整性校验在投影对比前失败。
    (legacy as { roleChain: string[] }).roleChain = ['rd'];

    expect(() => validateRunPlanV3(legacy)).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it('rejects projection drift unrelated to the parallel key', () => {
    const legacy = injectLegacyParallel(
      projectRunPlanV3(
        baseTemplate,
        { agent: 'mock', mode: 'workflow', templateId: 'legacy' },
        [],
      ),
    );
    // 非 parallel 漂移，重算 digest 绕过完整性后仍须被投影对比捕获。
    legacy.phases[0] = {
      ...legacy.phases[0],
      nodeIds: ['n1', 'forged-node'],
    } as (typeof legacy.phases)[number];
    legacy.digest = computeRunPlanDigest(legacy);

    expect(() => validateRunPlanV3(legacy)).toThrow(/projection/);
  });
});
