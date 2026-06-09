import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveDemandShape,
  evaluateDemandShape,
  evaluateWorkflowSelection,
  readDemandShapeFile,
  renderDemandShapeForRun,
  selectWorkflowTemplateForDemand,
  shapeDemand,
  writeDemandShapeFile,
  writeDemandShapeFiles,
} from '../../src/index.js';

describe('demand shape', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('classifies risk, creates acceptance criteria, and blocks unresolved high-risk demand', () => {
    const shape = shapeDemand({
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
    expect(evaluateDemandShape(shape)).toMatchObject({
      ready: true,
    });
  });

  it('requires approval when open questions remain and renders run text', () => {
    const shape = shapeDemand({
      id: 'shape_bug',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '修复失败',
    });

    expect(shape.category).toBe('bugfix');
    expect(shape.recommendedTemplate).toBe('bugfix');
    expect(shape.readyForRun).toBe(false);
    expect(evaluateDemandShape(shape).ready).toBe(false);

    const approved = approveDemandShape(shape, {
      actor: 'tester',
      approvedAt: '2026-06-08T00:00:01.000Z',
    });
    expect(approved).toMatchObject({
      approved: true,
      approvedBy: 'tester',
    });
    expect(evaluateDemandShape(approved).ready).toBe(true);
    expect(renderDemandShapeForRun(approved)).toContain(
      'Recommended template: bugfix',
    );
    expect(renderDemandShapeForRun(approved)).toContain('Human approved: yes');
  });

  it('selects controlled workflow templates for test, docs, and plan-only demands', () => {
    expect(
      shapeDemand({
        id: 'shape_test',
        createdAt: '2026-06-08T00:00:00.000Z',
        text: '补齐 Web dashboard 的 Playwright 测试覆盖，要求本地 e2e 通过。',
      }),
    ).toMatchObject({
      category: 'test',
      recommendedTemplate: 'test-improvement',
    });
    expect(
      shapeDemand({
        id: 'shape_docs',
        createdAt: '2026-06-08T00:00:00.000Z',
        text: '更新 README 和用户手册，说明 workflow selection 的使用方式。',
      }),
    ).toMatchObject({
      category: 'docs',
      recommendedTemplate: 'docs-update',
    });
    expect(
      selectWorkflowTemplateForDemand({
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
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-demand-shape-'));
    tempDirs.push(repoPath);
    const shape = shapeDemand({
      id: 'shape_files',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
    });

    const paths = writeDemandShapeFiles({ repoPath, shape });
    expect(readDemandShapeFile(paths.jsonPath)).toMatchObject({
      id: 'shape_files',
      approved: false,
    });
    expect(readFileSync(paths.markdownPath, 'utf8')).toContain(
      '# 给 Web dashboard 增加需求塑形入口，要求 e2e 通过',
    );

    const approved = approveDemandShape(shape, {
      actor: 'cli',
      approvedAt: '2026-06-08T00:00:01.000Z',
    });
    writeDemandShapeFile(paths.jsonPath, approved);
    expect(readDemandShapeFile(paths.jsonPath).approved).toBe(true);
    expect(readFileSync(paths.markdownPath, 'utf8')).toContain(
      '- approved: true',
    );
  });
});
