import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validateRunPlanV3 } from '../../src/workflow/run-plan.js';

// 用仓库内真实归档证据（R27 验收的冻结快照）验证 CD-24 兼容，
// 这些快照在 parallel 字段删除前冻结，恢复校验不得判 invalid。
describe('M1 real archived R27 plan snapshot', () => {
  it('accepts the frozen v3 snapshot from the R27 delivery evidence', () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const evidencePath = join(
      repoRoot,
      'docs/reviews/evidence/2026-09-06-r27/claude-delivery.json',
    );
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      final?: {
        workflow?: { planSnapshot?: string | Record<string, unknown> };
      };
    };
    const raw = evidence.final?.workflow?.planSnapshot;
    expect(raw).toBeTruthy();
    const snapshot =
      typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;

    const validated = validateRunPlanV3(snapshot);
    expect(validated.digestVersion).toBe(3);
  });
});
