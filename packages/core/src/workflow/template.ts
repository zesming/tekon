import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  artifactTypeSchema,
  commandInvocationSchema,
  gateTypeSchema,
  nodeWorkspaceSchema,
  RESERVED_ARTIFACT_TYPES,
  roleSchema,
  type ArtifactType,
  type CommandInvocation,
  type GateType,
  type NodeWorkspace,
  type Role,
} from '../types/domain.js';

const commandRefSchema = z.enum([
  'build',
  'typecheck',
  'lint',
  'test',
  'e2e',
  'security',
]);

export const workflowRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  maxRetries: z.number().int().min(0).max(9).optional(),
  backoffMs: z.number().int().min(0).default(0),
  strategy: z.enum(['fixed', 'exponential']).default('fixed'),
  onExhausted: z.enum(['block', 'pause', 'fail']).default('block'),
});
export type WorkflowRetryPolicy = z.infer<typeof workflowRetryPolicySchema>;

export interface WorkflowArtifactOutputRef {
  id: string;
  type: ArtifactType;
}

export interface WorkflowArtifactInputRef extends WorkflowArtifactOutputRef {
  fromNodeId: string;
}

export interface WorkflowGateConfig {
  type: GateType;
  gateKey?: string;
  command?: CommandInvocation;
  commandRef?: z.infer<typeof commandRefSchema>;
  skipReason?: string;
  artifactType?: ArtifactType;
  requiresHumanApproval: boolean;
  /**
   * PD-18：人工驳回后的返工目标节点（模板节点 id）。仅 human gate 携带；
   * 驳回恢复时据此对目标节点发起返工，决策备注作为返工反馈。
   */
  reworkTargetNodeId?: string;
  maxRetries: number;
  timeoutMs?: number;
  retryPolicy: WorkflowRetryPolicy;
  autoFix?: boolean;
  onExhausted?: 'block' | 'pause' | 'fail';
}

export interface WorkflowTemplateNode {
  id: string;
  role: Role;
  // PD-06：节点级提示词，可选；存在时随计划落库并注入 agent 提示词。
  prompt?: string;
  // CD-09：工作区隔离模式，缺省 worktree（历史行为）。
  workspace: NodeWorkspace;
  inputs: WorkflowArtifactInputRef[];
  outputs: WorkflowArtifactOutputRef[];
  gates: WorkflowGateConfig[];
  dependsOn: string[];
}

export interface WorkflowTemplatePhase {
  id: string;
  name: string;
  dependsOn: string[];
  nodes: WorkflowTemplateNode[];
}


export interface WorkflowCatalogEntry {
  id: string;
  name: string;
  builtin: boolean;
  path?: string;
  /**
   * PD-07：可选的模板有效性探针。仅当调用方请求校验（或 path 可读）时
   * 出现；未探测时缺省，保持既有目录扫描的零副作用行为。
   */
  valid?: boolean;
  /** valid=false 时的可读解析错误。 */
  validationError?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: number;
  retryPolicy: WorkflowRetryPolicy;
  phases: WorkflowTemplatePhase[];
}

export type BuiltInWorkflowTemplateId =
  | 'standard-feature'
  | 'bugfix'
  | 'test-improvement'
  | 'docs-update'
  | 'plan-only'
  | 'standard-delivery';

const rawArtifactRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      type: artifactTypeSchema.optional(),
      artifactType: artifactTypeSchema.optional(),
    })
    .strict(),
  z
    .object({
      from: z.string().min(1),
      id: z.string().min(1).optional(),
      type: artifactTypeSchema,
      artifactType: artifactTypeSchema.optional(),
    })
    .strict(),
]);

const rawGateSchema = z
  .object({
    type: gateTypeSchema,
    gateKey: z.string().min(1).optional(),
    command: commandInvocationSchema.optional(),
    commandRef: commandRefSchema.optional(),
    artifactType: artifactTypeSchema.optional(),
    requiresHumanApproval: z.boolean().optional(),
    // PD-18：人工驳回后要返工的目标节点（模板节点 id）。仅 human gate 有效；
    // 节点存在性与上游连通性在整模板校验期裁决。
    reworkTargetNodeId: z.string().min(1).optional(),
    maxRetries: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().optional(),
    autoFix: z.boolean().optional(),
    onExhausted: z.enum(['block', 'pause', 'fail']).optional(),
    retry: workflowRetryPolicySchema.optional(),
    retryPolicy: workflowRetryPolicySchema.optional(),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if (gate.type === 'schema' && !gate.artifactType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactType'],
        message: 'schema gate requires artifactType',
      });
    }

    if (gate.type === 'human' && gate.requiresHumanApproval === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresHumanApproval'],
        message: 'human gate requires human approval',
      });
    }

    if (gate.reworkTargetNodeId && gate.type !== 'human') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reworkTargetNodeId'],
        message: 'reworkTargetNodeId is only valid on human gates',
      });
    }
  });

const rawNodeSchema = z
  .object({
    id: z.string().min(1),
    role: roleSchema,
    prompt: z.string().min(1).optional(),
    // CD-09：缺省 worktree，旧模板不带该字段时归一化为隔离工作树。
    workspace: nodeWorkspaceSchema.optional(),
    inputs: z.array(rawArtifactRefSchema).default([]),
    outputs: z.array(rawArtifactRefSchema).default([]),
    gates: z.array(rawGateSchema).default([]),
    dependsOn: z.array(z.string().min(1)).default([]),
  })
  .strict();

const rawPhaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    // CD-24：parallel 从未实现（实际始终串行），字段已删除。保留为可选输入
    // 仅为兼容旧模板/YAML，解析时忽略，不会出现在 WorkflowTemplate 上。
    parallel: z.boolean().optional(),
    dependsOn: z.array(z.string().min(1)).default([]),
    nodes: z.array(rawNodeSchema).min(1),
  })
  .strict();

const rawWorkflowTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    version: z.number().int().positive().default(1),
    // PD-06 子项 4：reviewer/Gate 已全部可选，治理只由模板自身的节点和门禁
    // 表达。该字段保留仅为兼容旧模板（goal.yaml 等），解析后不产生任何效果。
    governance: z.enum(['standard', 'none']).optional(),
    retry: workflowRetryPolicySchema.optional(),
    retryPolicy: workflowRetryPolicySchema.optional(),
    phases: z.array(rawPhaseSchema).min(1),
  })
  .strict();

type RawArtifactRef = z.infer<typeof rawArtifactRefSchema>;
type RawGate = z.infer<typeof rawGateSchema>;
type RawWorkflowTemplate = z.infer<typeof rawWorkflowTemplateSchema>;

export function parseWorkflowTemplate(
  input: string | unknown,
): WorkflowTemplate {
  const rawInput = typeof input === 'string' ? parseYaml(input) : input;
  const rawTemplate = rawWorkflowTemplateSchema.parse(rawInput);
  return normalizeWorkflowTemplate(rawTemplate);
}

export function loadWorkflowTemplateFile(path: string): WorkflowTemplate {
  return parseWorkflowTemplate(readFileSync(path, 'utf8'));
}

export type WorkflowTemplateValidation =
  | { valid: true; template: WorkflowTemplate }
  | { valid: false; error: string };

/**
 * 把 zod issues 压成「字段路径: 中文原因」的可读单行（CD-20），
 * 不向 CLI/Web 用户暴露裸校验器 JSON 或英文内部句。
 */
export function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((issue) => describeZodIssue(issue)).join('；');
}

function describeZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.map(String).join('.');
  const where = path ? `字段 ${path}` : '模板根对象';
  switch (issue.code) {
    case 'invalid_type': {
      // zod v4 类型声明不含 received，且两阶段解析的部分 issue 运行期也
      // 不携带；做结构访问，缺失时用完整中文句而不是输出 undefined。
      if ('received' in issue && issue.received !== undefined) {
        return `${where} 类型错误：应为 ${issue.expected}，实际为 ${String(issue.received)}`;
      }
      return `${where} 类型错误：应为 ${issue.expected}，当前值缺失或类型不符`;
    }
    case 'too_small':
      return `${where} 长度或数量不足：至少 ${issue.minimum}`;
    case 'too_big':
      return `${where} 长度或数量超限：至多 ${issue.maximum}`;
    case 'unrecognized_keys':
      return `${where} 存在未知字段：${issue.keys.join('、')}`;
    case 'invalid_value': {
      // zod v4 枚举校验失败：values 是允许值列表，过长时截断保住单行。
      const allowed =
        'values' in issue && Array.isArray(issue.values)
          ? issue.values.slice(0, 8).map(String).join('、') +
            (issue.values.length > 8 ? ' 等' : '')
          : '预定义取值';
      return `${where} 取值非法，应为可选值之一：${allowed}`;
    }
    case 'invalid_union':
      // v4 的嵌套 errors 含英文细节，不向下展开，给字段级中文结论即可。
      return `${where} 不符合任一允许的类型或结构`;
    case 'invalid_format':
      // 当前模板 schema 里该 code 仅来自 kebab-case 标识符正则。
      if (issue.message.includes('kebab-case')) {
        return `${where} 格式非法：标识符必须是 kebab-case 形式（小写字母开头，仅含小写字母、数字与连字符）`;
      }
      return `${where} 格式非法：${collapseToSingleLine(issue.message)}`;
    case 'custom':
      return `${where} ${describeCustomGateIssue(issue.message)}`;
    default:
      return `${where}：${issue.message}`;
  }
}

/** rawGateSchema superRefine 的固定英文消息中文化（消息集合可枚举）。 */
function describeCustomGateIssue(message: string): string {
  if (message === 'schema gate requires artifactType') {
    return 'schema 门禁必须声明 artifactType（产物类型）';
  }
  if (message === 'human gate requires human approval') {
    return 'human 门禁必须要求人工审批，不能显式关闭';
  }
  if (message === 'reworkTargetNodeId is only valid on human gates') {
    return 'reworkTargetNodeId 只能用于 human 门禁';
  }
  return collapseToSingleLine(message);
}

/**
 * normalize 层语义校验抛出的英文 Error 翻译表（CD-20）。内部消息被既有
 * 测试钉为稳定标识，不在 throw 点改文案，而在展示层按已知族翻译；
 * 未命中的消息返回 null，由调用方回退折叠后的原文。
 */
function describeSemanticTemplateError(message: string): string | null {
  const rules: Array<[RegExp, (...args: string[]) => string]> = [
    [
      /^invalid workflow template name: (.+)$/u,
      (name) => `模板名非法：${name}`,
    ],
    [
      /^INVALID_WORKFLOW_TEMPLATE: (.+)$/u,
      (path) => `模板结构不合法：${path}`,
    ],
    [
      /^Invalid phase dependency "(.+?)" in phase "(.+?)"$/u,
      (dep, phase) => `阶段 "${phase}" 的阶段依赖 "${dep}" 非法`,
    ],
    [
      /^unknown dependency "(.+?)" for artifact "(.+?)" in node "(.+?)"$/u,
      (dep, artifact, node) =>
        `节点 "${node}" 的产物 "${artifact}" 引用了未知依赖 "${dep}"`,
    ],
    [
      /^unknown dependency "(.+?)" in node "(.+?)"$/u,
      (dep, node) => `节点 "${node}" 引用了未知依赖 "${dep}"`,
    ],
    [
      /^Phase "(.+?)" has conflicting output id "(.+?)" from "(.+?)" and "(.+?)"$/u,
      (phase, output, a, b) =>
        `阶段 "${phase}" 中产物 ID "${output}" 在节点 "${a}" 与 "${b}" 之间冲突`,
    ],
    [
      /^duplicate gateKey "(.+?)" in node "(.+?)"$/u,
      (key, node) => `节点 "${node}" 的门禁标识 gateKey "${key}" 重复`,
    ],
    [
      /^reworkTargetNodeId is only valid on human gates \(node "(.+?)", gate "(.+?)"\)$/u,
      (node, gate) =>
        `reworkTargetNodeId 只能用于 human 门禁（节点 "${node}"，门禁 "${gate}"）`,
    ],
    [
      /^human gate reworkTargetNodeId cannot target its own node "(.+?)"$/u,
      (node) =>
        `human 门禁的 reworkTargetNodeId 不能指向所在节点自身 "${node}"`,
    ],
    [
      /^human gate reworkTargetNodeId "(.+?)" in node "(.+?)" must reference .+$/u,
      (target, node) =>
        `节点 "${node}" 的 reworkTargetNodeId "${target}" 必须引用 dependsOn 或 inputs 中声明的直接上游节点`,
    ],
    [
      /^Invalid artifact ref "(.+?)"; expected .+$/u,
      (ref) =>
        `产物引用 "${ref}" 格式非法，应为 "artifact-type" 或 "id:artifact-type"`,
    ],
    [
      /^Invalid artifact ref "(.+?)"; missing type$/u,
      (ref) => `产物引用 "${ref}" 缺少 type 字段`,
    ],
    [/^Duplicate phase id "(.+?)"$/u, (id) => `阶段 ID "${id}" 重复`],
    [/^Duplicate node id "(.+?)"$/u, (id) => `节点 ID "${id}" 重复`],
    [
      /^Node "(.+?)" has duplicate output id "(.+?)"$/u,
      (node, output) => `节点 "${node}" 的产物 ID "${output}" 重复`,
    ],
    [
      /^Node "(.+?)" cannot declare reserved artifact type "(.+?)":.*$/u,
      (node, type) =>
        `节点 "${node}" 不能声明交付保留产物类型 "${type}"：该类型由 Tekon 交付机制自产`,
    ],
  ];
  for (const [pattern, render] of rules) {
    const match = message.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return null;
}

/** 把错误消息里的换行与连续空白折叠为单行，并截断超长片段。 */
function collapseToSingleLine(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength)}…`
    : collapsed;
}

function isNodeErrorCodeError(
  error: unknown,
): error is NodeJS.ErrnoException & { path?: string } {
  return error instanceof Error && 'code' in error;
}

/**
 * 把模板加载/解析链路上的各类异常统一翻译为可读中文单行：
 * zod 校验错误走 formatZodIssues，YAML 语法错误折叠代码片段，
 * ENOENT 明确为文件不存在；其余错误沿用原生 message 的折叠形态。
 */
export function readableWorkflowTemplateError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return formatZodIssues(error.issues);
  }
  if (error instanceof Error && error.name.startsWith('YAML')) {
    return `YAML 语法错误：${collapseToSingleLine(error.message)}`;
  }
  if (isNodeErrorCodeError(error) && error.code === 'ENOENT') {
    return `模板文件不存在：${error.path ?? collapseToSingleLine(error.message)}`;
  }
  if (isNodeErrorCodeError(error) && error.code === 'EISDIR') {
    return '模板路径是一个目录而不是文件';
  }
  if (isNodeErrorCodeError(error) && error.code === 'EACCES') {
    return '模板文件无读取权限';
  }
  if (isNodeErrorCodeError(error) && error.code === 'ELOOP') {
    return '符号链接循环或层级过深，无法解析目标';
  }
  if (error instanceof Error) {
    // 先尝试 normalize 层已知语义错误的中文化，未命中再折叠原文。
    return (
      describeSemanticTemplateError(error.message) ??
      collapseToSingleLine(error.message)
    );
  }
  return collapseToSingleLine(String(error));
}

/**
 * PD-07：非抛出的模板文件校验。供 `workflow list` 标记无效项与
 * `workflow validate` 使用——读取或解析失败时返回可读错误而不是抛异常，
 * 让目录扫描不会被单个坏文件中断。所有错误经
 * readableWorkflowTemplateError 翻译为中文单行。
 */
export function validateWorkflowTemplateFile(
  path: string,
): WorkflowTemplateValidation {
  try {
    return { valid: true, template: loadWorkflowTemplateFile(path) };
  } catch (error) {
    return { valid: false, error: readableWorkflowTemplateError(error) };
  }
}

/**
 * 符号链接安全检查（统一信任边界，list 探针与按名加载共用）：模板目录里
 * 的软链只能指向该目录内的目标，防止经软链读取仓库外文件、再把外部内容
 * 经 YAML 错误片段回显（供应链向量：软链可随 git 提交进入仓库）。非软链
 * 直接放行；断链/越界/无法解析时返回中文原因，调用方不得再读取目标。
 *
 * 已知残留：lstat/realpath 与后续 readFileSync 之间存在 TOCTOU 窗口，
 * 理论上软链可在检查后被替换。本地单用户威胁模型下，攻击者替换软链所需
 * 的写权限已足以直接改模板，残余风险可接受。
 */
export function inspectTemplateSymlink(
  entryPath: string,
  baseDir: string,
): { ok: true } | { ok: false; reason: string } {
  let stats: Awaited<ReturnType<typeof lstatSync>>;
  try {
    stats = lstatSync(entryPath);
  } catch (error) {
    return {
      ok: false,
      reason: `符号链接无法访问：${readableWorkflowTemplateError(error)}`,
    };
  }
  if (!stats.isSymbolicLink()) return { ok: true };

  let targetReal: string;
  try {
    targetReal = realpathSync(entryPath);
  } catch (error) {
    if (isNodeErrorCodeError(error) && error.code === 'ENOENT') {
      return { ok: false, reason: '符号链接已断开，目标文件不存在' };
    }
    return {
      ok: false,
      reason: `符号链接无法解析：${readableWorkflowTemplateError(error)}`,
    };
  }

  let baseReal: string;
  try {
    baseReal = realpathSync(baseDir);
  } catch {
    baseReal = baseDir;
  }
  const rel = relative(baseReal, targetReal);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { ok: true };
  }
  return { ok: false, reason: '符号链接目标超出模板目录，已拒绝读取' };
}

function parseWorkflowFileEntry(entryName: string): { id: string; ext: string } | null {
  if (entryName.endsWith('.yaml')) {
    return { id: entryName.slice(0, -'.yaml'.length), ext: '.yaml' };
  }
  if (entryName.endsWith('.yml')) {
    return { id: entryName.slice(0, -'.yml'.length), ext: '.yml' };
  }
  return null;
}

export function loadWorkflowTemplate(options: {
  name: string;
  workflowsDir?: string;
}): WorkflowTemplate {
  if (!/^[a-zA-Z0-9_-]+$/u.test(options.name)) {
    throw new Error(`invalid workflow template name: ${options.name}`);
  }
  const dir = getWorkflowsDir(options.workflowsDir);
  // 统一软链信任边界（B 方案）：按名加载与 list 探针共用同一 containment，
  // 越界/断链软链在读取前以中文错误拒绝，show/validate/run/doctor/Web 一致。
  // 仅对实际存在的文件做闸门；不存在的后缀直接跳过，not-found 完全保留
  // 下方原有的显式抛错路径，不改变其 ENOENT 语义。
  for (const ext of ['.yaml', '.yml']) {
    const filePath = join(dir, `${options.name}${ext}`);
    if (!existsSync(filePath)) continue;
    const linkCheck = inspectTemplateSymlink(filePath, dir);
    if (!linkCheck.ok) throw new Error(linkCheck.reason);
    return loadWorkflowTemplateFile(filePath);
  }
  return loadWorkflowTemplateFile(join(dir, `${options.name}.yaml`));
}

export function listWorkflowCatalog(options?: {
  projectWorkflowsDir?: string;
  /** PD-07：为每个条目附加非抛出的解析有效性探针。 */
  validate?: boolean;
}): WorkflowCatalogEntry[] {
  const catalogMap = new Map<string, WorkflowCatalogEntry>();

  const attachValidation = (entry: WorkflowCatalogEntry): void => {
    if (!options?.validate || !entry.path) return;
    // 调用方（目录扫描循环）已先做软链 containment 并拦截越界/断链，
    // 这里只对放行条目做解析探针。
    const result = validateWorkflowTemplateFile(entry.path);
    entry.valid = result.valid;
    if (!result.valid) entry.validationError = result.error;
  };

  /**
   * 软链闸门：在任何 readFileSync 之前拦截越界/断链。返回的条目标记仅在
   * validate 模式挂载，保持非探针调用方的返回形状零变化；无论是否探针，
   * 被拦截的软链都不会被读取。
   */
  const applyLinkGate = (
    entry: WorkflowCatalogEntry,
    entryPath: string,
    baseDir: string,
  ): boolean => {
    const linkCheck = inspectTemplateSymlink(entryPath, baseDir);
    if (linkCheck.ok) return true;
    if (options?.validate) {
      entry.valid = false;
      entry.validationError = linkCheck.reason;
    }
    return false;
  };

  const builtinDir = getWorkflowsDir();
  if (existsSync(builtinDir)) {
    try {
      const entries = readdirSync(builtinDir, { withFileTypes: true });
      for (const entry of entries) {
        // 接受符号链接：项目可能用链接共享同一份模板（S3），Dirent.isFile
        // 对链接本身返回 false，需显式放行；后缀校验仍由 parseWorkflowFileEntry 把关。
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const parsed = parseWorkflowFileEntry(entry.name);
        if (!parsed) continue;
        const { id, ext } = parsed;
        if (catalogMap.has(id) && ext === '.yml') {
          continue;
        }
        const fullPath = join(builtinDir, entry.name);
        const builtinEntry: WorkflowCatalogEntry = {
          id,
          name: id,
          builtin: true,
          path: fullPath,
        };
        // 读取闸门：越界/断链软链在名称读取与解析探针之前拦截。
        if (!applyLinkGate(builtinEntry, fullPath, builtinDir)) {
          catalogMap.set(id, builtinEntry);
          continue;
        }
        try {
          const raw = parseYaml(readFileSync(fullPath, 'utf8')) as {
            name?: unknown;
          } | null;
          if (raw && typeof raw.name === 'string' && raw.name.trim().length > 0) {
            builtinEntry.name = raw.name.trim();
          }
        } catch {
          // fallback to id
        }
        attachValidation(builtinEntry);
        catalogMap.set(id, builtinEntry);
      }
    } catch {
      // directory read failure ignored
    }
  }

  if (options?.projectWorkflowsDir && existsSync(options.projectWorkflowsDir)) {
    try {
      const entries = readdirSync(options.projectWorkflowsDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        // 接受符号链接：项目可能用链接共享同一份模板（S3），Dirent.isFile
        // 对链接本身返回 false，需显式放行；后缀校验仍由 parseWorkflowFileEntry 把关。
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const parsed = parseWorkflowFileEntry(entry.name);
        if (!parsed) continue;
        const { id, ext } = parsed;
        const existing = catalogMap.get(id);
        if (existing && !existing.builtin && ext === '.yml') {
          continue;
        }
        const fullPath = join(options.projectWorkflowsDir, entry.name);
        const projectEntry: WorkflowCatalogEntry = {
          id,
          name: id,
          builtin: false,
          path: fullPath,
        };
        // 读取闸门：越界/断链软链在名称读取与解析探针之前拦截。
        if (!applyLinkGate(projectEntry, fullPath, options.projectWorkflowsDir)) {
          catalogMap.set(id, projectEntry);
          continue;
        }
        try {
          const raw = parseYaml(readFileSync(fullPath, 'utf8')) as {
            name?: unknown;
          } | null;
          if (raw && typeof raw.name === 'string' && raw.name.trim().length > 0) {
            projectEntry.name = raw.name.trim();
          }
        } catch {
          // fallback to id
        }
        attachValidation(projectEntry);
        catalogMap.set(id, projectEntry);
      }
    } catch {
      // directory read failure ignored
    }
  }

  return [...catalogMap.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function loadBuiltInWorkflowTemplate(
  id: BuiltInWorkflowTemplateId,
  options: { workflowsDir?: string } = {},
): WorkflowTemplate {
  return loadWorkflowTemplate({ name: id, workflowsDir: options.workflowsDir });
}

const normalizedOutputSchema = z.object({
  id: z.string().min(1),
  type: artifactTypeSchema,
}).strict();
const normalizedGateSchema = z.object({
  type: gateTypeSchema,
  gateKey: z.string().min(1).optional(),
  command: commandInvocationSchema.strict().optional(),
  commandRef: commandRefSchema.optional(),
  skipReason: z.string().min(1).optional(),
  artifactType: artifactTypeSchema.optional(),
  requiresHumanApproval: z.boolean().default(false),
  reworkTargetNodeId: z.string().min(1).optional(),
  maxRetries: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().positive().optional(),
  retryPolicy: workflowRetryPolicySchema.strict().default(defaultRetryPolicy),
  autoFix: z.boolean().optional(),
  onExhausted: z.enum(['block', 'pause', 'fail']).optional(),
}).strict();
const normalizedTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  retryPolicy: workflowRetryPolicySchema.strict(),
  phases: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    dependsOn: z.array(z.string().min(1)),
    // CD-24：旧快照里可能残留 parallel，接受但不读（输出类型不含该字段）。
    parallel: z.boolean().optional(),
    nodes: z.array(z.object({
      id: z.string().min(1),
      role: roleSchema,
      prompt: z.string().min(1).optional(),
      // 归一化入口同样补 worktree 默认：程序化构造的模板（测试/内部调用）
      // 省略该字段时与 YAML 解析路径得到完全一致的输出形状。
      workspace: nodeWorkspaceSchema.default('worktree'),
      inputs: z.array(normalizedOutputSchema.extend({ fromNodeId: z.string().min(1) })),
      outputs: z.array(normalizedOutputSchema),
      gates: z.array(normalizedGateSchema),
      dependsOn: z.array(z.string().min(1)),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict();

/** 校验已经解析的执行结构，不重新解释 YAML 的 from/artifact 简写。 */
export function normalizeExecutableTemplate(input: unknown): WorkflowTemplate {
  const result = normalizedTemplateSchema.safeParse(input);
  if (!result.success) {
    const path = result.error.issues[0]?.path.map(String).join('.') ?? 'template';
    throw new Error(`INVALID_WORKFLOW_TEMPLATE: template.${path}`);
  }
  const template = result.data;
  const phaseIds = new Set<string>();
  const nodeIds = new Set<string>();
  const outputs = new Map<string, WorkflowArtifactOutputRef[]>();
  for (const [phaseIndex, phase] of template.phases.entries()) {
    if (phaseIds.has(phase.id) || phase.dependsOn.some(id => !phaseIds.has(id))) {
      throw new Error(`INVALID_WORKFLOW_TEMPLATE: template.phases.${phaseIndex}.dependsOn`);
    }
    for (const [nodeIndex, node] of phase.nodes.entries()) {
      const path = `template.phases.${phaseIndex}.nodes.${nodeIndex}`;
      if (nodeIds.has(node.id) || node.dependsOn.some(id => !nodeIds.has(id))) {
        throw new Error(`INVALID_WORKFLOW_TEMPLATE: ${path}.dependsOn`);
      }
      if (node.inputs.some(input => !outputs.get(input.fromNodeId)?.some(output => output.type === input.type))) {
        throw new Error(`INVALID_WORKFLOW_TEMPLATE: ${path}.inputs`);
      }
      assertNoReservedOutputs(node.id, node.outputs);
      const effectiveKeys = node.gates.map((gate, index) => gate.gateKey ?? stableGateKey(gate, index));
      if (new Set(effectiveKeys).size !== effectiveKeys.length) {
        throw new Error(`INVALID_WORKFLOW_TEMPLATE: ${path}.gates`);
      }
      nodeIds.add(node.id);
      outputs.set(node.id, node.outputs);
    }
    phaseIds.add(phase.id);
  }
  return template;
}

function normalizeWorkflowTemplate(
  rawTemplate: RawWorkflowTemplate,
): WorkflowTemplate {
  const retryPolicy =
    rawTemplate.retryPolicy ?? rawTemplate.retry ?? defaultRetryPolicy();
  const phaseIds = new Set<string>();
  const nodeIds = new Set<string>();
  const knownPhaseIds = new Set<string>();
  const knownNodeIds = new Set<string>();
  const availableOutputs = new Map<
    string,
    WorkflowArtifactOutputRef & {
      nodeId: string;
    }
  >();

  const phases: WorkflowTemplatePhase[] = [];

  for (const rawPhase of rawTemplate.phases) {
    assertUniqueId(phaseIds, rawPhase.id, 'phase');

    for (const phaseDependency of rawPhase.dependsOn) {
      if (!knownPhaseIds.has(phaseDependency)) {
        throw new Error(
          `Invalid phase dependency "${phaseDependency}" in phase "${rawPhase.id}"`,
        );
      }
    }

    const phaseOutputIds = new Map<string, string>();
    const phaseNodes: WorkflowTemplateNode[] = [];

    for (const rawNode of rawPhase.nodes) {
      assertUniqueId(nodeIds, rawNode.id, 'node');

      for (const nodeDependency of rawNode.dependsOn) {
        if (!knownNodeIds.has(nodeDependency)) {
          throw new Error(
            `unknown dependency "${nodeDependency}" in node "${rawNode.id}"`,
          );
        }
      }

      const inputs = rawNode.inputs.map((input) =>
        resolveInputRef(input, rawNode.id, availableOutputs),
      );
      const outputs = rawNode.outputs.map((output) => parseArtifactRef(output));
      assertNoDuplicateNodeOutputIds(outputs, rawNode.id);
      assertNoReservedOutputs(rawNode.id, outputs);

      for (const output of outputs) {
        const owner = phaseOutputIds.get(output.id);
        if (owner) {
          throw new Error(
            `Phase "${rawPhase.id}" has conflicting output id "${output.id}" from "${owner}" and "${rawNode.id}"`,
          );
        }
        phaseOutputIds.set(output.id, rawNode.id);
      }

      const gates = rawNode.gates.map((gate) =>
        normalizeGate(gate, retryPolicy),
      );
      assertUniqueEffectiveGateKeys(gates, rawNode.id);
      // inputs 已 resolve 为带 fromNodeId 的形态，字符串简写的来源也在此刻
      // 确定，连通性校验基于解析结果而非原始 YAML 写法。
      assertHumanReworkTargets(
        gates,
        rawNode.id,
        new Set([
          ...rawNode.dependsOn,
          ...inputs.map((input) => input.fromNodeId),
        ]),
      );

      phaseNodes.push({
        id: rawNode.id,
        role: rawNode.role,
        ...(rawNode.prompt ? { prompt: rawNode.prompt } : {}),
        workspace: rawNode.workspace ?? 'worktree',
        inputs,
        outputs,
        gates,
        dependsOn: rawNode.dependsOn,
      });
    }

    for (const node of phaseNodes) {
      knownNodeIds.add(node.id);
      for (const output of node.outputs) {
        availableOutputs.set(output.id, {
          ...output,
          nodeId: node.id,
        });
      }
    }

    knownPhaseIds.add(rawPhase.id);
    phases.push({
      id: rawPhase.id,
      name: rawPhase.name ?? rawPhase.id,
      dependsOn: rawPhase.dependsOn,
      nodes: phaseNodes,
    });
  }

  return {
    id: rawTemplate.id,
    name: rawTemplate.name ?? rawTemplate.id,
    version: rawTemplate.version,
    retryPolicy: normalizeRetryPolicy(retryPolicy),
    phases,
  };
}

function defaultRetryPolicy(): WorkflowRetryPolicy {
  return normalizeRetryPolicy(workflowRetryPolicySchema.parse({}));
}

function normalizeGate(
  rawGate: RawGate,
  templateRetryPolicy: WorkflowRetryPolicy,
): WorkflowGateConfig {
  const retryPolicy =
    rawGate.retryPolicy ??
    rawGate.retry ??
    (rawGate.maxRetries === undefined
      ? templateRetryPolicy
      : {
          ...defaultRetryPolicy(),
          maxRetries: rawGate.maxRetries,
        });

  return {
    type: rawGate.type,
    ...(rawGate.gateKey ? { gateKey: rawGate.gateKey } : {}),
    ...(rawGate.command ? { command: rawGate.command } : {}),
    ...(rawGate.commandRef ? { commandRef: rawGate.commandRef } : {}),
    ...(rawGate.artifactType ? { artifactType: rawGate.artifactType } : {}),
    requiresHumanApproval:
      rawGate.requiresHumanApproval ?? rawGate.type === 'human',
    ...(rawGate.reworkTargetNodeId
      ? { reworkTargetNodeId: rawGate.reworkTargetNodeId }
      : {}),
    maxRetries:
      rawGate.maxRetries ??
      retryPolicy.maxRetries ??
      Math.max(0, (retryPolicy.maxAttempts ?? 1) - 1),
    ...(rawGate.timeoutMs ? { timeoutMs: rawGate.timeoutMs } : {}),
    ...(rawGate.autoFix !== undefined ? { autoFix: rawGate.autoFix } : {}),
    onExhausted: rawGate.onExhausted ?? retryPolicy.onExhausted ?? 'block',
    retryPolicy: normalizeRetryPolicy(retryPolicy),
  };
}

function assertUniqueEffectiveGateKeys(
  gates: WorkflowGateConfig[],
  nodeId: string,
): void {
  const seen = new Set<string>();
  for (const [index, gate] of gates.entries()) {
    const gateKey = gate.gateKey ?? stableGateKey(gate, index);
    if (seen.has(gateKey)) {
      throw new Error(`duplicate gateKey "${gateKey}" in node "${nodeId}"`);
    }
    seen.add(gateKey);
  }
}

/**
 * PD-18：human gate 的 reworkTargetNodeId 必须是本节点声明的直接上游
 * （dependsOn 或 inputs.from），与 independent-review 门禁的
 * isReviewTargetConnected 连通规则一致——防止驳回后返工一个与评审无关的
 * 节点。上游引用的存在性由本节点既有的 unknown dependency 校验保证。
 */
function assertHumanReworkTargets(
  gates: WorkflowGateConfig[],
  nodeId: string,
  upstreamNodeIds: Set<string>,
): void {
  for (const gate of gates) {
    const target = gate.reworkTargetNodeId;
    if (!target) continue;
    if (gate.type !== 'human') {
      throw new Error(
        `reworkTargetNodeId is only valid on human gates (node "${nodeId}", gate "${gate.type}")`,
      );
    }
    if (target === nodeId) {
      throw new Error(
        `human gate reworkTargetNodeId cannot target its own node "${nodeId}"`,
      );
    }
    if (!upstreamNodeIds.has(target)) {
      throw new Error(
        `human gate reworkTargetNodeId "${target}" in node "${nodeId}" must reference a direct upstream node declared in the node's dependsOn or inputs`,
      );
    }
  }
}

function stableGateKey(
  gate: Pick<
    WorkflowGateConfig,
    'type' | 'artifactType' | 'commandRef' | 'skipReason'
  >,
  index: number,
): string {
  return [
    String(index).padStart(2, '0'),
    gate.type,
    gate.artifactType ? `artifact=${gate.artifactType}` : '',
    gate.commandRef ? `commandRef=${gate.commandRef}` : '',
    gate.skipReason ? 'skipped' : '',
  ]
    .filter(Boolean)
    .join(':');
}

function parseArtifactRef(ref: RawArtifactRef): WorkflowArtifactOutputRef {
  if (typeof ref === 'string') {
    const [id, type, extra] = ref.split(':');
    if (!id || extra !== undefined) {
      throw new Error(
        `Invalid artifact ref "${ref}"; expected "artifact-type" or "id:artifact-type"`,
      );
    }
    if (!type) {
      const artifactType = artifactTypeSchema.parse(id);
      return {
        id: artifactType,
        type: artifactType,
      };
    }
    return {
      id,
      type: artifactTypeSchema.parse(type),
    };
  }

  if ('from' in ref) {
    const type = ref.artifactType ?? ref.type;
    return {
      id: ref.id ?? type,
      type,
    };
  }

  const type = ref.type ?? ref.artifactType;
  if (!type) {
    throw new Error(`Invalid artifact ref "${ref.id}"; missing type`);
  }
  return { id: ref.id, type };
}

function resolveInputRef(
  ref: RawArtifactRef,
  nodeId: string,
  availableOutputs: Map<string, WorkflowArtifactOutputRef & { nodeId: string }>,
): WorkflowArtifactInputRef {
  if (typeof ref !== 'string' && 'from' in ref) {
    const type = ref.artifactType ?? ref.type;
    const inputId = ref.id ?? type;
    const producer = [...availableOutputs.values()].find(
      (output) => output.nodeId === ref.from && output.type === type,
    );
    if (!producer) {
      throw new Error(
        `unknown dependency "${ref.from}" for artifact "${inputId}:${type}" in node "${nodeId}"`,
      );
    }
    return {
      id: inputId,
      type,
      fromNodeId: producer.nodeId,
    };
  }

  const input = parseArtifactRef(ref);
  const producer = availableOutputs.get(input.id);
  if (!producer || producer.type !== input.type) {
    throw new Error(
      `unknown dependency "${input.id}:${input.type}" in node "${nodeId}"`,
    );
  }

  return {
    ...input,
    fromNodeId: producer.nodeId,
  };
}

function normalizeRetryPolicy(
  policy: WorkflowRetryPolicy,
): WorkflowRetryPolicy {
  const maxRetries =
    policy.maxRetries ?? Math.max(0, (policy.maxAttempts ?? 1) - 1);
  return {
    ...policy,
    maxRetries,
    maxAttempts: policy.maxAttempts ?? maxRetries + 1,
  };
}

function getWorkflowsDir(workflowsDir?: string): string {
  if (workflowsDir) {
    return workflowsDir;
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, '..', '..', '..', '..', 'workflows');
}

function assertUniqueId(ids: Set<string>, id: string, label: 'phase' | 'node') {
  if (ids.has(id)) {
    throw new Error(`Duplicate ${label} id "${id}"`);
  }
  ids.add(id);
}

function assertNoDuplicateNodeOutputIds(
  outputs: WorkflowArtifactOutputRef[],
  nodeId: string,
) {
  const seen = new Set<string>();
  for (const output of outputs) {
    if (seen.has(output.id)) {
      throw new Error(
        `Node "${nodeId}" has duplicate output id "${output.id}"`,
      );
    }
    seen.add(output.id);
  }
}

// 交付保留类型（如 ci-status）由 Tekon 交付机制自产，模板节点不得声明为产物，
// 在解析期直接拒绝，避免运行期才出现晦涩的 manifest 错误。
function assertNoReservedOutputs(
  nodeId: string,
  outputs: WorkflowArtifactOutputRef[],
): void {
  for (const output of outputs) {
    if (
      (RESERVED_ARTIFACT_TYPES as readonly string[]).includes(output.type)
    ) {
      throw new Error(
        `Node "${nodeId}" cannot declare reserved artifact type "${output.type}": it is produced by Tekon delivery, not by workflow nodes`,
      );
    }
  }
}
