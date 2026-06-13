/** @deprecated Backward-compat tests for deprecated demand shape APIs */
import { describe, expect, it } from 'vitest';

import {
  approveDemandShape,
  evaluateDemandShape,
  selectWorkflowTemplateForDemand,
  shapeDemand,
} from '../../src/index.js';

describe('demand shape (backward compat)', () => {
  it('backward compat: shapeDemand returns a valid shape', () => {
    const shape = shapeDemand({
      id: 'shape_compat_1',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '修复CI构建失败',
    });
    expect(shape.category).toBe('bugfix');
    expect(shape.recommendedTemplate).toBe('bugfix');
  });

  it('backward compat: selectWorkflowTemplateForDemand works', () => {
    const result = selectWorkflowTemplateForDemand({
      text: '只做技术方案评审，不改代码。',
    });
    expect(result.recommendedTemplate).toBe('plan-only');
  });

  it('backward compat: evaluateDemandShape and approveDemandShape work', () => {
    const shape = shapeDemand({
      id: 'shape_compat_2',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '修复失败',
    });
    expect(evaluateDemandShape(shape).ready).toBe(false);
    const approved = approveDemandShape(shape, { actor: 'tester' });
    expect(approved.approved).toBe(true);
  });
});
