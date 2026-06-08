import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

export const demandCategorySchema = z.enum([
  'feature',
  'bugfix',
  'test',
  'docs',
  'refactor',
  'other',
]);

const demandRiskLevelSchema = z.enum(['low', 'medium', 'high']);

export const controlledWorkflowTemplateIdSchema = z.enum([
  'standard-feature',
  'bugfix',
  'test-improvement',
  'docs-update',
  'plan-only',
]);
export type ControlledWorkflowTemplateId = z.infer<
  typeof controlledWorkflowTemplateIdSchema
>;

const shapedAcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  verification: z.string().min(1),
});

export const demandShapeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    rawText: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    category: demandCategorySchema,
    recommendedTemplate: controlledWorkflowTemplateIdSchema,
    risk: z.object({
      level: demandRiskLevelSchema,
      tags: z.array(z.string().min(1)),
      requiresHumanApproval: z.boolean(),
      reasons: z.array(z.string().min(1)),
    }),
    nonGoals: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    openQuestions: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(shapedAcceptanceCriterionSchema).min(1),
    readyForRun: z.boolean(),
    approved: z.boolean(),
    approvedBy: z.string().nullable().optional(),
    approvedAt: z.string().datetime().nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DemandShape = z.infer<typeof demandShapeSchema>;

export interface DemandShapeEvaluation {
  ready: boolean;
  score: number;
  checks: Array<{
    id: string;
    passed: boolean;
    severity: 'required' | 'recommended';
    evidence: string;
  }>;
}

export interface WorkflowTemplateSelection {
  category: DemandShape['category'];
  recommendedTemplate: ControlledWorkflowTemplateId;
  alternatives: ControlledWorkflowTemplateId[];
  reasons: string[];
}

export interface WorkflowSelectionEvaluation {
  ready: boolean;
  score: number;
  recommendedTemplate: ControlledWorkflowTemplateId;
  selectedTemplate: string;
  checks: Array<{
    id: string;
    passed: boolean;
    severity: 'required' | 'recommended';
    evidence: string;
  }>;
}

export function shapeDemand(input: {
  text: string;
  id?: string;
  createdAt?: string;
}): DemandShape {
  const rawText = normalizeText(input.text);
  if (!rawText) {
    throw new Error('demand text is required');
  }

  const category = classifyDemand(rawText);
  const risk = classifyRisk(rawText, category);
  const summary = summarizeDemand(rawText);
  const openQuestions = inferOpenQuestions(rawText, risk.level);
  const selection = selectWorkflowTemplateForDemand({
    text: rawText,
    category,
  });
  const acceptanceCriteria = buildAcceptanceCriteria({
    summary,
    category,
    riskLevel: risk.level,
  });

  return demandShapeSchema.parse({
    schemaVersion: 1,
    id: input.id ?? `demand_shape_${randomUUID()}`,
    rawText,
    title: summary,
    summary,
    category,
    recommendedTemplate: selection.recommendedTemplate,
    risk,
    nonGoals: buildNonGoals(risk.level),
    assumptions: buildAssumptions(category),
    openQuestions,
    acceptanceCriteria,
    readyForRun: openQuestions.length === 0,
    approved: false,
    approvedBy: null,
    approvedAt: null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function selectWorkflowTemplateForDemand(input: {
  text: string;
  category?: DemandShape['category'];
}): WorkflowTemplateSelection {
  const rawText = normalizeText(input.text);
  if (!rawText) {
    throw new Error('demand text is required');
  }
  const category = input.category ?? classifyDemand(rawText);
  const recommendedTemplate = recommendTemplate(rawText, category);
  return {
    category,
    recommendedTemplate,
    alternatives: controlledWorkflowTemplateIdSchema.options.filter(
      (template) => template !== recommendedTemplate,
    ),
    reasons: buildTemplateSelectionReasons(
      rawText,
      category,
      recommendedTemplate,
    ),
  };
}

export function evaluateWorkflowSelection(input: {
  text: string;
  selectedTemplate?: string;
  category?: DemandShape['category'];
}): WorkflowSelectionEvaluation {
  const selection = selectWorkflowTemplateForDemand(input);
  const selectedTemplate =
    input.selectedTemplate ?? selection.recommendedTemplate;
  const knownSelectedTemplate =
    controlledWorkflowTemplateIdSchema.safeParse(selectedTemplate).success;
  const checks: WorkflowSelectionEvaluation['checks'] = [
    {
      id: 'selected-template-known',
      severity: 'required',
      passed: knownSelectedTemplate,
      evidence: selectedTemplate,
    },
    {
      id: 'selected-template-fits-demand',
      severity: 'required',
      passed:
        knownSelectedTemplate &&
        selectedTemplate === selection.recommendedTemplate,
      evidence: `selected=${selectedTemplate} recommended=${selection.recommendedTemplate} category=${selection.category}`,
    },
    {
      id: 'controlled-alternatives-present',
      severity: 'recommended',
      passed: selection.alternatives.length >= 2,
      evidence: selection.alternatives.join(','),
    },
    {
      id: 'selection-reasons-present',
      severity: 'recommended',
      passed: selection.reasons.length > 0,
      evidence: selection.reasons.join(' | '),
    },
  ];
  const required = checks.filter((check) => check.severity === 'required');
  return {
    ready: required.every((check) => check.passed),
    score: checks.filter((check) => check.passed).length / checks.length,
    recommendedTemplate: selection.recommendedTemplate,
    selectedTemplate,
    checks,
  };
}

export function approveDemandShape(
  shape: DemandShape,
  input: { actor: string; approvedAt?: string },
): DemandShape {
  return demandShapeSchema.parse({
    ...shape,
    approved: true,
    approvedBy: input.actor,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
  });
}

export function evaluateDemandShape(shape: DemandShape): DemandShapeEvaluation {
  const checks: DemandShapeEvaluation['checks'] = [
    {
      id: 'title-present',
      severity: 'required',
      passed: shape.title.trim().length > 0,
      evidence: shape.title,
    },
    {
      id: 'acceptance-criteria-present',
      severity: 'required',
      passed: shape.acceptanceCriteria.length >= 2,
      evidence: `${shape.acceptanceCriteria.length} acceptance criteria`,
    },
    {
      id: 'non-goals-present',
      severity: 'required',
      passed: shape.nonGoals.length > 0,
      evidence: `${shape.nonGoals.length} non-goals`,
    },
    {
      id: 'risk-boundary-present',
      severity: 'required',
      passed:
        shape.risk.level !== 'high' ||
        (shape.risk.requiresHumanApproval && shape.risk.reasons.length > 0),
      evidence: `risk=${shape.risk.level} approval=${shape.risk.requiresHumanApproval}`,
    },
    {
      id: 'questions-resolved-or-approved',
      severity: 'required',
      passed: shape.readyForRun || shape.approved,
      evidence: shape.readyForRun
        ? 'no open questions'
        : `openQuestions=${shape.openQuestions.length} approved=${shape.approved}`,
    },
    {
      id: 'template-recommended',
      severity: 'recommended',
      passed: Boolean(shape.recommendedTemplate),
      evidence: shape.recommendedTemplate,
    },
  ];
  const required = checks.filter((check) => check.severity === 'required');
  const passedRequired = required.filter((check) => check.passed).length;
  return {
    ready: passedRequired === required.length,
    score: checks.filter((check) => check.passed).length / checks.length,
    checks,
  };
}

export function renderDemandShapeForRun(shape: DemandShape): string {
  return [
    `Title: ${shape.title}`,
    '',
    `Original demand: ${shape.rawText}`,
    '',
    `Category: ${shape.category}`,
    `Recommended template: ${shape.recommendedTemplate}`,
    `Risk: ${shape.risk.level}${
      shape.risk.tags.length ? ` (${shape.risk.tags.join(', ')})` : ''
    }`,
    `Human approved: ${shape.approved ? 'yes' : 'no'}`,
    '',
    'Acceptance criteria:',
    ...shape.acceptanceCriteria.map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.description} Verification: ${criterion.verification}`,
    ),
    '',
    'Non-goals:',
    ...shape.nonGoals.map((item) => `- ${item}`),
    '',
    'Assumptions:',
    ...shape.assumptions.map((item) => `- ${item}`),
    '',
    'Open questions:',
    ...(shape.openQuestions.length
      ? shape.openQuestions.map((item) => `- ${item}`)
      : ['- none']),
  ].join('\n');
}

export function renderDemandShapeMarkdown(shape: DemandShape): string {
  return [
    `# ${shape.title}`,
    '',
    `- id: ${shape.id}`,
    `- category: ${shape.category}`,
    `- recommendedTemplate: ${shape.recommendedTemplate}`,
    `- readyForRun: ${shape.readyForRun}`,
    `- approved: ${shape.approved}`,
    `- risk: ${shape.risk.level}`,
    `- riskTags: ${shape.risk.tags.join(',') || 'none'}`,
    '',
    '## Raw Demand',
    '',
    shape.rawText,
    '',
    '## Acceptance Criteria',
    '',
    ...shape.acceptanceCriteria.map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.description}\n  - verification: ${criterion.verification}`,
    ),
    '',
    '## Non-Goals',
    '',
    ...shape.nonGoals.map((item) => `- ${item}`),
    '',
    '## Assumptions',
    '',
    ...shape.assumptions.map((item) => `- ${item}`),
    '',
    '## Open Questions',
    '',
    ...(shape.openQuestions.length
      ? shape.openQuestions.map((item) => `- ${item}`)
      : ['- none']),
    '',
    '## Risk Reasons',
    '',
    ...(shape.risk.reasons.length
      ? shape.risk.reasons.map((item) => `- ${item}`)
      : ['- none']),
    '',
  ].join('\n');
}

export function writeDemandShapeFiles(input: {
  repoPath: string;
  shape: DemandShape;
}): { jsonPath: string; markdownPath: string } {
  assertSafeDemandShapeId(input.shape.id);
  const dir = join(input.repoPath, '.donkey', 'demands');
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${input.shape.id}.json`);
  const markdownPath = join(dir, `${input.shape.id}.md`);
  writeFileSync(jsonPath, JSON.stringify(input.shape, null, 2), 'utf8');
  writeFileSync(markdownPath, renderDemandShapeMarkdown(input.shape), 'utf8');
  return { jsonPath, markdownPath };
}

export function readDemandShapeFile(path: string): DemandShape {
  return demandShapeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeDemandShapeFile(path: string, shape: DemandShape): void {
  assertSafeDemandShapeId(shape.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(shape, null, 2), 'utf8');
  const markdownPath = path.replace(/\.json$/u, '.md');
  if (markdownPath !== path) {
    writeFileSync(markdownPath, renderDemandShapeMarkdown(shape), 'utf8');
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function summarizeDemand(text: string): string {
  const firstSentence =
    /(.+?[。.!?？])/u.exec(text)?.[1] ?? text.split(/\n/u)[0] ?? text;
  return truncate(firstSentence.replace(/[。.!?？]+$/u, '').trim(), 80);
}

function classifyDemand(text: string): DemandShape['category'] {
  if (
    /修复|缺陷|错误|异常|失败|回归|bug|fix|regression|broken|crash/iu.test(text)
  ) {
    return 'bugfix';
  }
  if (/文档|说明|手册|README|docs?|manual/iu.test(text)) {
    return 'docs';
  }
  if (/重构|整理|清理|refactor|cleanup/iu.test(text)) {
    return 'refactor';
  }
  if (
    /(补齐|新增|增加|完善|改进)(单元|集成|端到端|e2e|playwright|vitest)?(测试|用例|覆盖)|测试(补齐|覆盖|用例)|test coverage/iu.test(
      text,
    )
  ) {
    return 'test';
  }
  if (
    /新增|增加|支持|实现|接入|生成|创建|feature|add|create|support/iu.test(text)
  ) {
    return 'feature';
  }
  if (/测试|用例|覆盖|test|e2e|playwright|vitest/iu.test(text)) {
    return 'test';
  }
  return 'other';
}

function recommendTemplate(
  text: string,
  category: DemandShape['category'],
): ControlledWorkflowTemplateId {
  if (isPlanOnlyDemand(text)) {
    return 'plan-only';
  }
  if (category === 'bugfix') {
    return 'bugfix';
  }
  if (category === 'test') {
    return 'test-improvement';
  }
  if (category === 'docs') {
    return 'docs-update';
  }
  return 'standard-feature';
}

function isPlanOnlyDemand(text: string): boolean {
  return /只做方案|仅方案|仅设计|不改代码|不实现|方案评审|技术方案|调研报告|plan[- ]?only|design[- ]?only|research only/iu.test(
    text,
  );
}

function buildTemplateSelectionReasons(
  text: string,
  category: DemandShape['category'],
  recommendedTemplate: ControlledWorkflowTemplateId,
): string[] {
  if (recommendedTemplate === 'plan-only') {
    return [
      'Demand explicitly asks for planning, design, research, or no code changes.',
    ];
  }
  if (category === 'bugfix') {
    return ['Bugfix demand should keep regression evidence and reviewer gate.'];
  }
  if (category === 'test') {
    return ['Test coverage demand should emphasize test evidence and mapping.'];
  }
  if (category === 'docs') {
    return ['Documentation demand should keep implementation scope narrow.'];
  }
  if (category === 'refactor') {
    return [
      'Refactor demand needs normal build, lint, security, and review gates.',
    ];
  }
  return [`${category} demand defaults to the standard feature workflow.`];
}

function classifyRisk(
  text: string,
  category: DemandShape['category'],
): DemandShape['risk'] {
  const rules: Array<{ tag: string; pattern: RegExp; reason: string }> = [
    {
      tag: 'security',
      pattern:
        /安全|密钥|token|secret|auth|oauth|登录|认证|鉴权|权限|permission/iu,
      reason: 'Security, auth, secret, or permission related demand.',
    },
    {
      tag: 'data',
      pattern:
        /数据|数据库|迁移|删除|清理|导入|导出|data|database|migration|delete/iu,
      reason: 'Data or database impact is mentioned.',
    },
    {
      tag: 'payment',
      pattern: /支付|退款|计费|订单|账单|payment|refund|billing|order/iu,
      reason: 'Payment or billing impact is mentioned.',
    },
    {
      tag: 'production',
      pattern: /生产|线上|发布|上线|prod|production|release|deploy/iu,
      reason: 'Production, release, or deployment impact is mentioned.',
    },
    {
      tag: 'external-api',
      pattern: /外部|第三方|webhook|api|callback|integration/iu,
      reason: 'External integration impact is mentioned.',
    },
  ];
  const matches = rules.filter((rule) => rule.pattern.test(text));
  const explicitHighRisk = /高风险|high[- ]?risk|critical/iu.test(text);
  const level: DemandShape['risk']['level'] =
    explicitHighRisk || matches.length > 0
      ? 'high'
      : category === 'feature' || category === 'refactor'
        ? 'medium'
        : 'low';
  return {
    level,
    tags: matches.map((match) => match.tag),
    requiresHumanApproval: level !== 'low',
    reasons: [
      ...(explicitHighRisk ? ['Demand explicitly mentions high risk.'] : []),
      ...matches.map((match) => match.reason),
      ...(level === 'medium'
        ? ['Feature or refactor work needs normal reviewer attention.']
        : []),
    ],
  };
}

function buildAcceptanceCriteria(input: {
  summary: string;
  category: DemandShape['category'];
  riskLevel: DemandShape['risk']['level'];
}): DemandShape['acceptanceCriteria'] {
  const criteria: DemandShape['acceptanceCriteria'] = [
    {
      id: 'AC-1',
      description: `用户可审阅到需求结果：${input.summary}`,
      verification:
        'PR package 中包含变更摘要、diff、artifact 正文和 gate 结果。',
    },
    {
      id: 'AC-2',
      description:
        '仓库画像中的 build/lint/test/security gate 通过，或普通命令被显式标记不适用。',
      verification:
        'donkey review --run-id <runId> 显示 readiness 和 gate evidence。',
    },
  ];
  if (input.category === 'bugfix') {
    criteria.push({
      id: 'AC-3',
      description: '缺陷有回归验证，失败场景不会被静默吞掉。',
      verification: 'test-report 或 gate log 中能看到对应回归验证结果。',
    });
  } else if (input.category === 'test') {
    criteria.push({
      id: 'AC-3',
      description: '新增测试能在本地命令中稳定运行，并映射到验收标准。',
      verification: 'test-report 中包含 criteriaEvidence。',
    });
  } else {
    criteria.push({
      id: 'AC-3',
      description: '实现范围保持在本需求内，不引入无关重构或额外产品行为。',
      verification: 'PR diff 与 Non-goals 对照审阅。',
    });
  }
  if (input.riskLevel === 'high') {
    criteria.push({
      id: `AC-${criteria.length + 1}`,
      description: '高风险影响有人工审批、回滚或风险说明，不自动合入或上线。',
      verification: 'review surface 中 human gate、rollback/risk 证据可见。',
    });
  }
  return criteria;
}

function buildNonGoals(riskLevel: DemandShape['risk']['level']): string[] {
  return [
    '不自动 merge、不自动上线、不执行生产写操作。',
    '不扩大需求范围之外的重构、权限或外部系统改动。',
    ...(riskLevel === 'high'
      ? ['不在缺少人工审批和回滚说明时推进高风险副作用。']
      : []),
  ];
}

function buildAssumptions(category: DemandShape['category']): string[] {
  return [
    '目标仓库已通过 donkey init 初始化，并维护 repo profile gate 命令。',
    category === 'docs'
      ? '文档类变更仍需要 review surface 证明范围和 diff 可审阅。'
      : '实现类变更需要通过仓库现有验证命令或显式 notApplicable 说明。',
  ];
}

function inferOpenQuestions(
  text: string,
  riskLevel: DemandShape['risk']['level'],
): string[] {
  const questions: string[] = [];
  if (text.length < 12) {
    questions.push('需求描述过短，需要补充用户场景、目标模块和期望结果。');
  }
  if (
    !/模块|页面|接口|命令|CLI|Web|README|文档|文件|仓库|API|dashboard|workflow|gate|PR|CI|数据库|配置|component|route|package/iu.test(
      text,
    )
  ) {
    questions.push('影响范围或目标模块未明确。');
  }
  if (
    !/验收|验证|测试|用例|截图|CI|通过|失败|check|test|assert|expect/iu.test(
      text,
    )
  ) {
    questions.push('验收方式未明确。');
  }
  if (
    riskLevel === 'high' &&
    !/回滚|审批|人工|风险|rollback|approve|approval/iu.test(text)
  ) {
    questions.push('高风险变更缺少回滚或人工审批说明。');
  }
  return questions;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function assertSafeDemandShapeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id) || basename(id) !== id) {
    throw new Error(`unsafe demand shape id: ${id}`);
  }
}
