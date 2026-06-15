import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

export const draftCategorySchema = z.enum([
  'feature',
  'bugfix',
  'test',
  'docs',
  'refactor',
  'other',
]);

const draftRiskLevelSchema = z.enum(['low', 'medium', 'high']);

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

export const draftShapeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    rawText: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    category: draftCategorySchema,
    recommendedTemplate: controlledWorkflowTemplateIdSchema,
    risk: z.object({
      level: draftRiskLevelSchema,
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

export type DraftShape = z.infer<typeof draftShapeSchema>;

export interface DraftShapeEvaluation {
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
  category: DraftShape['category'];
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

export function shapeDraft(input: {
  text: string;
  id?: string;
  createdAt?: string;
}): DraftShape {
  const rawText = normalizeText(input.text);
  if (!rawText) {
    throw new Error('draft text is required');
  }

  const category = classifyDraft(rawText);
  const risk = classifyRisk(rawText, category);
  const summary = summarizeDraft(rawText);
  const openQuestions = inferOpenQuestions(rawText, risk.level);
  const selection = selectWorkflowTemplateForDraft({
    text: rawText,
    category,
  });
  const acceptanceCriteria = buildAcceptanceCriteria({
    summary,
    category,
    riskLevel: risk.level,
  });

  return draftShapeSchema.parse({
    schemaVersion: 1,
    id: input.id ?? `draft_shape_${randomUUID()}`,
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

export function selectWorkflowTemplateForDraft(input: {
  text: string;
  category?: DraftShape['category'];
}): WorkflowTemplateSelection {
  const rawText = normalizeText(input.text);
  if (!rawText) {
    throw new Error('draft text is required');
  }
  const category = input.category ?? classifyDraft(rawText);
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
  category?: DraftShape['category'];
}): WorkflowSelectionEvaluation {
  const selection = selectWorkflowTemplateForDraft(input);
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
      id: 'selected-template-fits-draft',
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

export function approveDraftShape(
  shape: DraftShape,
  input: { actor: string; approvedAt?: string },
): DraftShape {
  return draftShapeSchema.parse({
    ...shape,
    approved: true,
    approvedBy: input.actor,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
  });
}

export function evaluateDraftShape(shape: DraftShape): DraftShapeEvaluation {
  const checks: DraftShapeEvaluation['checks'] = [
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

export function renderDraftShapeForRun(shape: DraftShape): string {
  return [
    `Title: ${shape.title}`,
    '',
    `Original draft: ${shape.rawText}`,
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

export function renderDraftShapeMarkdown(shape: DraftShape): string {
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
    '## Raw Draft',
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

export function writeDraftShapeFiles(input: {
  repoPath: string;
  shape: DraftShape;
}): { jsonPath: string; markdownPath: string } {
  assertSafeDraftShapeId(input.shape.id);
  const dir = join(input.repoPath, '.tekon', 'drafts');
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${input.shape.id}.json`);
  const markdownPath = join(dir, `${input.shape.id}.md`);
  writeFileSync(jsonPath, JSON.stringify(input.shape, null, 2), 'utf8');
  writeFileSync(markdownPath, renderDraftShapeMarkdown(input.shape), 'utf8');
  return { jsonPath, markdownPath };
}

export function readDraftShapeFile(path: string): DraftShape {
  return draftShapeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeDraftShapeFile(path: string, shape: DraftShape): void {
  assertSafeDraftShapeId(shape.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(shape, null, 2), 'utf8');
  const markdownPath = path.replace(/\.json$/u, '.md');
  if (markdownPath !== path) {
    writeFileSync(markdownPath, renderDraftShapeMarkdown(shape), 'utf8');
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function summarizeDraft(text: string): string {
  const firstSentence =
    /(.+?[。.!?？])/u.exec(text)?.[1] ?? text.split(/\n/u)[0] ?? text;
  return truncate(firstSentence.replace(/[。.!?？]+$/u, '').trim(), 80);
}

function classifyDraft(text: string): DraftShape['category'] {
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
  category: DraftShape['category'],
): ControlledWorkflowTemplateId {
  if (isPlanOnlyDraft(text)) {
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

function isPlanOnlyDraft(text: string): boolean {
  return /只做方案|仅方案|仅设计|不改代码|不实现|方案评审|技术方案|调研报告|plan[- ]?only|design[- ]?only|research only/iu.test(
    text,
  );
}

function buildTemplateSelectionReasons(
  _text: string,
  category: DraftShape['category'],
  recommendedTemplate: ControlledWorkflowTemplateId,
): string[] {
  if (recommendedTemplate === 'plan-only') {
    return [
      'Draft explicitly asks for planning, design, research, or no code changes.',
    ];
  }
  if (category === 'bugfix') {
    return ['Bugfix draft should keep regression evidence and reviewer gate.'];
  }
  if (category === 'test') {
    return ['Test coverage draft should emphasize test evidence and mapping.'];
  }
  if (category === 'docs') {
    return ['Documentation draft should keep implementation scope narrow.'];
  }
  if (category === 'refactor') {
    return [
      'Refactor draft needs normal build, lint, security, and review gates.',
    ];
  }
  return [`${category} draft defaults to the standard feature workflow.`];
}

function classifyRisk(
  text: string,
  category: DraftShape['category'],
): DraftShape['risk'] {
  const rules: Array<{ tag: string; pattern: RegExp; reason: string }> = [
    {
      tag: 'security',
      pattern:
        /安全|密钥|token|secret|auth|oauth|登录|认证|鉴权|权限|permission/iu,
      reason: 'Security, auth, secret, or permission related draft.',
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
  const level: DraftShape['risk']['level'] =
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
      ...(explicitHighRisk ? ['Draft explicitly mentions high risk.'] : []),
      ...matches.map((match) => match.reason),
      ...(level === 'medium'
        ? ['Feature or refactor work needs normal reviewer attention.']
        : []),
    ],
  };
}

function buildAcceptanceCriteria(input: {
  summary: string;
  category: DraftShape['category'];
  riskLevel: DraftShape['risk']['level'];
}): DraftShape['acceptanceCriteria'] {
  const criteria: DraftShape['acceptanceCriteria'] = [
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
      verification: 'tekon review 显示 readiness 和 gate evidence。',
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

function buildNonGoals(riskLevel: DraftShape['risk']['level']): string[] {
  return [
    '不自动 merge、不自动上线、不执行生产写操作。',
    '不扩大需求范围之外的重构、权限或外部系统改动。',
    ...(riskLevel === 'high'
      ? ['不在缺少人工审批和回滚说明时推进高风险副作用。']
      : []),
  ];
}

function buildAssumptions(category: DraftShape['category']): string[] {
  return [
    '目标仓库已通过 tekon init 初始化，并维护 repo profile gate 命令。',
    category === 'docs'
      ? '文档类变更仍需要 review surface 证明范围和 diff 可审阅。'
      : '实现类变更需要通过仓库现有验证命令或显式 notApplicable 说明。',
  ];
}

function inferOpenQuestions(
  text: string,
  riskLevel: DraftShape['risk']['level'],
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

// ---------------------------------------------------------------------------
// Interactive clarification
// ---------------------------------------------------------------------------

export interface ClarifyingAnswer {
  question: string;
  answer: string;
}

export function generateClarifyingQuestions(
  draft: DraftShape,
): string[] {
  const questions: string[] = [];

  // 1. Check for user/scenario context
  const hasUserContext =
    /用户|使用者|角色|场景|用户故事|persona|stakeholder|谁|目标用户/iu.test(
      draft.rawText,
    );
  if (!hasUserContext && draft.category !== 'test' && draft.category !== 'refactor') {
    questions.push('这个功能的目标用户是谁？主要使用场景是什么？');
  }

  // 2. Check for scope/module clarity
  const hasScope =
    /模块|页面|接口|命令|文件|仓库|路径|component|route|package|函数|方法/iu.test(
      draft.rawText,
    );
  if (!hasScope) {
    questions.push('受影响的具体模块或代码路径有哪些？');
  }

  // 3. Check for explicit acceptance criteria beyond defaults
  if (draft.acceptanceCriteria.length <= 3) {
    questions.push('最重要的验收标准是什么？如何判断功能已完成？');
  }

  // 4. Check for explicit non-goals beyond defaults
  const hasExplicitNonGoals =
    draft.rawText.includes('不做') ||
    draft.rawText.includes('不包含') ||
    draft.rawText.includes('不涉及') ||
    draft.rawText.includes('不包括');
  if (!hasExplicitNonGoals && draft.nonGoals.length <= 2) {
    questions.push('有哪些明确不做的事情或边界？');
  }

  // 5. Check for risk/constraints detail
  if (draft.risk.level !== 'low') {
    const hasRiskDetail =
      /风险|依赖|约束|限制|前提|前置|条件|rely on|depends on/iu.test(
        draft.rawText,
      );
    if (!hasRiskDetail) {
      questions.push('有没有已知的风险、依赖或约束需要注意？');
    }
  }

  // 6. If we still have fewer than 3 questions, add fallback
  if (questions.length < 3) {
    if (questions.every((q) => !q.includes('验收标准'))) {
      questions.push('最重要的验收标准是什么？如何判断功能已完成？');
    }
  }

  // Limit to 5 questions
  return questions.slice(0, 5);
}

export function updateDraftWithAnswers(
  draft: DraftShape,
  answers: ClarifyingAnswer[],
): DraftShape {
  const meaningfulAnswers = answers.filter(
    (a) => a.answer.trim().length > 0,
  );
  if (meaningfulAnswers.length === 0) {
    return draft;
  }

  const answersText = meaningfulAnswers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  const enrichedText = `${draft.rawText}

补充澄清信息:
${answersText}`;

  return shapeDraft({
    text: enrichedText,
    id: draft.id,
    createdAt: draft.createdAt,
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function assertSafeDraftShapeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id) || basename(id) !== id) {
    throw new Error(`unsafe draft shape id: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Backward compatibility aliases
// ---------------------------------------------------------------------------

/** @deprecated Use DraftShape instead */
export type DemandShape = DraftShape;

/** @deprecated Use DraftShapeEvaluation instead */
export type DemandShapeEvaluation = DraftShapeEvaluation;

/** @deprecated Use draftShapeSchema instead */
export const demandShapeSchema = draftShapeSchema;

/** @deprecated Use draftCategorySchema instead */
export const demandCategorySchema = draftCategorySchema;

/** @deprecated Use shapeDraft instead */
export const shapeDemand = shapeDraft;

/** @deprecated Use selectWorkflowTemplateForDraft instead */
export const selectWorkflowTemplateForDemand = selectWorkflowTemplateForDraft;

/** @deprecated Use approveDraftShape instead */
export const approveDemandShape = approveDraftShape;

/** @deprecated Use evaluateDraftShape instead */
export const evaluateDemandShape = evaluateDraftShape;

/** @deprecated Use renderDraftShapeForRun instead */
export const renderDemandShapeForRun = renderDraftShapeForRun;

/** @deprecated Use renderDraftShapeMarkdown instead */
export const renderDemandShapeMarkdown = renderDraftShapeMarkdown;

/** @deprecated Use writeDraftShapeFiles instead */
export const writeDemandShapeFiles = writeDraftShapeFiles;

/** @deprecated Use readDraftShapeFile instead */
export const readDemandShapeFile = readDraftShapeFile;

/** @deprecated Use writeDraftShapeFile instead */
export const writeDemandShapeFile = writeDraftShapeFile;
