import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveDraftShape,
  evaluateDraftShape,
  evaluateWorkflowSelection,
  markDraftPlanGenerated,
  planApproveDraftShape,
  readDraftShapeFile,
  renderDraftShapeForRun,
  selectWorkflowTemplateForDraft,
  shapeDraft,
  writeDraftShapeFile,
  writeDraftShapeFiles,
} from '../../src/index.js';

describe('draft shape', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('classifies risk, creates acceptance criteria, and blocks unresolved high-risk draft', () => {
    const shape = shapeDraft({
      id: 'shape_1',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '给支付模块增加退款数据迁移能力，要求人工审批和回滚，测试通过。',
    });

    expect(shape).toMatchObject({
      id: 'shape_1',
      category: 'feature',
      recommendedTemplate: 'standard-feature',
      risk: expect.objectContaining({
        level: 'high',
        requiresHumanApproval: true,
        tags: expect.arrayContaining(['data', 'payment']),
      }),
      readyForRun: true,
      approved: false,
    });
    expect(shape.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'AC-4',
          description: expect.stringContaining('高风险影响'),
        }),
      ]),
    );
    expect(evaluateDraftShape(shape)).toMatchObject({
      ready: true,
    });
  });

  it('requires approval when open questions remain and renders run text', () => {
    const shape = shapeDraft({
      id: 'shape_bug',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '修复失败',
    });

    expect(shape.category).toBe('bugfix');
    expect(shape.recommendedTemplate).toBe('bugfix');
    expect(shape.readyForRun).toBe(false);
    expect(evaluateDraftShape(shape).ready).toBe(false);

    const approved = approveDraftShape(shape, {
      actor: 'tester',
      approvedAt: '2026-06-08T00:00:01.000Z',
    });
    expect(approved).toMatchObject({
      approved: true,
      approvedBy: 'tester',
    });
    expect(evaluateDraftShape(approved).ready).toBe(true);
    expect(renderDraftShapeForRun(approved)).toContain(
      'Recommended template: bugfix',
    );
    expect(renderDraftShapeForRun(approved)).toContain('Human approved: yes');
  });

  // 4f-2: plan generation + plan approval are distinct from demand approval.
  it('generates a plan then requires a separate plan approval', () => {
    const shape = shapeDraft({
      id: 'shape_plan',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '修复失败',
    });
    // A fresh shape has no plan → run gate is not engaged (backward compatible).
    expect(shape.hasPlan).toBeUndefined();

    const planned = markDraftPlanGenerated(shape);
    expect(planned.hasPlan).toBe(true);
    // Generating a plan does NOT approve it, and does NOT touch demand approval.
    expect(planned.planApproved).toBe(false);
    expect(planned.approved).toBe(false);

    // Cannot plan-approve without a generated plan.
    expect(() =>
      planApproveDraftShape(shape, { actor: 'tester' }),
    ).toThrow(/no generated plan/u);

    const planApproved = planApproveDraftShape(planned, {
      actor: 'tester',
      approvedAt: '2026-06-08T00:00:02.000Z',
    });
    expect(planApproved).toMatchObject({
      hasPlan: true,
      planApproved: true,
      planApprovedBy: 'tester',
    });
    // Plan approval is orthogonal — demand `approved` is still whatever it was.
    expect(planApproved.approved).toBe(false);
  });

  it('regenerating a plan invalidates a prior plan approval', () => {
    const planned = planApproveDraftShape(
      markDraftPlanGenerated(
        shapeDraft({
          id: 'shape_replan',
          createdAt: '2026-06-08T00:00:00.000Z',
          text: '修复失败',
        }),
      ),
      { actor: 'tester' },
    );
    expect(planned.planApproved).toBe(true);

    const replanned = markDraftPlanGenerated(planned);
    expect(replanned.hasPlan).toBe(true);
    expect(replanned.planApproved).toBe(false);
    expect(replanned.planApprovedBy).toBeNull();
  });

  it('selects controlled workflow templates for test, docs, and plan-only drafts', () => {
    expect(
      shapeDraft({
        id: 'shape_test',
        createdAt: '2026-06-08T00:00:00.000Z',
        text: '补齐 Web dashboard 的 Playwright 测试覆盖，要求本地 e2e 通过。',
      }),
    ).toMatchObject({
      category: 'test',
      recommendedTemplate: 'test-improvement',
    });
    expect(
      shapeDraft({
        id: 'shape_docs',
        createdAt: '2026-06-08T00:00:00.000Z',
        text: '更新 README 和用户手册，说明 workflow selection 的使用方式。',
      }),
    ).toMatchObject({
      category: 'docs',
      recommendedTemplate: 'docs-update',
    });
    expect(
      selectWorkflowTemplateForDraft({
        text: '只做技术方案评审，不改代码，输出风险和验收标准。',
      }),
    ).toMatchObject({
      recommendedTemplate: 'plan-only',
      alternatives: expect.arrayContaining(['standard-feature', 'bugfix']),
    });

    expect(
      evaluateWorkflowSelection({
        text: '补齐 CLI 的单元测试覆盖。',
        selectedTemplate: 'standard-feature',
      }),
    ).toMatchObject({
      ready: false,
      recommendedTemplate: 'test-improvement',
    });
    expect(
      evaluateWorkflowSelection({
        text: '补齐 CLI 的单元测试覆盖。',
        selectedTemplate: 'test-improvement',
      }),
    ).toMatchObject({
      ready: true,
      recommendedTemplate: 'test-improvement',
    });
  });

  it('writes, reads, approves, and mirrors markdown review files', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-draft-shape-'));
    tempDirs.push(repoPath);
    const shape = shapeDraft({
      id: 'shape_files',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
    });

    const paths = writeDraftShapeFiles({ repoPath, shape });
    expect(readDraftShapeFile(paths.jsonPath)).toMatchObject({
      id: 'shape_files',
      approved: false,
    });
    expect(readFileSync(paths.markdownPath, 'utf8')).toContain(
      '# 给 Web dashboard 增加需求塑形入口，要求 e2e 通过',
    );

    const approved = approveDraftShape(shape, {
      actor: 'cli',
      approvedAt: '2026-06-08T00:00:01.000Z',
    });
    writeDraftShapeFile(paths.jsonPath, approved);
    expect(readDraftShapeFile(paths.jsonPath).approved).toBe(true);
    expect(readFileSync(paths.markdownPath, 'utf8')).toContain(
      '- approved: true',
    );
  });

});
