import { z } from 'zod';
import {
  loadRepoProfileWithSource, repoProfileCommandResolution,
  type RepoProfileCommandName, type RepoCommandSource,
} from '../repo/profile.js';
import { normalizeExecutableTemplate, type WorkflowGateConfig, type WorkflowTemplate } from './template.js';

export type { RepoCommandSource } from '../repo/profile.js';
export type BoundRepoCommand = {
  commandRef: RepoProfileCommandName;
  source: RepoCommandSource;
} & (
  | { status: 'resolved'; command: { tool: string; args: string[] } }
  | { status: 'not-applicable'; reason: string }
  | { status: 'missing' }
);

const refSchema = z.enum(['build', 'typecheck', 'lint', 'test', 'e2e', 'security']);
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repo-profile'), resolverVersion: z.literal(1), profileVersion: z.number().int().positive(), path: z.literal('.tekon/repo-profile.yaml') }).strict(),
  z.object({ kind: z.literal('package-json-detection'), resolverVersion: z.literal(1), path: z.literal('package.json') }).strict(),
  z.object({ kind: z.literal('empty-default'), resolverVersion: z.literal(1) }).strict(),
]);
const entryBase = { commandRef: refSchema, source: sourceSchema };
const boundCommandsSchema = z.array(z.discriminatedUnion('status', [
  z.object({ ...entryBase, status: z.literal('resolved'), command: z.object({ tool: z.string().min(1), args: z.array(z.string()) }).strict() }).strict(),
  z.object({ ...entryBase, status: z.literal('not-applicable'), reason: z.string().min(1) }).strict(),
  z.object({ ...entryBase, status: z.literal('missing') }).strict(),
]));

function usedRefs(template: WorkflowTemplate): RepoProfileCommandName[] {
  return [...new Set(template.phases.flatMap(phase => phase.nodes.flatMap(node => node.gates.flatMap(gate => gate.commandRef && !gate.command ? [gate.commandRef] : []))))].sort();
}

/** 只捕获实际进入仓库解析分支的引用；没有引用时不接触文件系统。 */
export function captureRepoCommands(repoPath: string, template: WorkflowTemplate): BoundRepoCommand[] {
  const refs = usedRefs(normalizeExecutableTemplate(template));
  if (refs.length === 0) return [];
  try {
    const { profile, source } = loadRepoProfileWithSource(repoPath);
    return refs.map(commandRef => {
      const resolution = repoProfileCommandResolution(profile, commandRef);
      const base = { commandRef, source: { ...source } };
      if (resolution.status === 'resolved') return { ...base, status: 'resolved', command: structuredClone(resolution.command) };
      if (resolution.status === 'not-applicable') return { ...base, status: 'not-applicable', reason: resolution.reason };
      return { ...base, status: 'missing' };
    });
  } catch {
    throw new Error('PLAN_CONFIG_INVALID: 无法读取仓库检查配置；请修正 .tekon/repo-profile.yaml 或 package.json 后重新读取计划');
  }
}

/** 纯绑定校验：缺失不是默认值，任何多余字段或引用也不能被静默裁剪。 */
export function normalizeRepoCommands(template: WorkflowTemplate, value: unknown): BoundRepoCommand[] {
  const parsed = boundCommandsSchema.safeParse(value);
  if (!parsed.success) throw new Error('PLAN_DIGEST_MISMATCH: repoCommands.fields');
  const entries = parsed.data.sort((a, b) => a.commandRef.localeCompare(b.commandRef));
  if (entries.some(entry =>
    (entry.source.kind === 'empty-default' && entry.status !== 'missing') ||
    (entry.status === 'not-applicable' && entry.source.kind !== 'repo-profile'))) {
    throw new Error('PLAN_DIGEST_MISMATCH: repoCommands.source');
  }
  const expected = usedRefs(template);
  if (entries.length !== expected.length || entries.some((entry, index) => entry.commandRef !== expected[index])) {
    throw new Error('PLAN_DIGEST_MISMATCH: repoCommands.refs');
  }
  return entries;
}

/** gateKey 必须在调用前按原模板确定；物化后没有动态 profile 回退入口。 */
export function materializeBoundGate(gate: WorkflowGateConfig, entries: readonly BoundRepoCommand[]): WorkflowGateConfig {
  const result = structuredClone(gate);
  delete result.commandRef;
  if (gate.command || !gate.commandRef) return result;
  const entry = entries.find(item => item.commandRef === gate.commandRef);
  if (!entry) throw new Error('PLAN_DIGEST_MISMATCH: repoCommands.refs');
  if (entry.status === 'resolved') result.command = structuredClone(entry.command);
  else if (entry.status === 'not-applicable' && gate.type !== 'security-scan') {
    result.skipReason = `repo profile commands.${gate.commandRef} is not applicable: ${entry.reason}`;
  }
  return result;
}

export type CommandBindingBehavior = 'execute-command' | 'skip' | 'missing-command'
  | 'builtin-security' | 'builtin-security-and-command' | 'not-command-gate';

/** 与 GateEngine 的原有分支相同；解析成功并不一定意味着执行命令。 */
export function commandBindingBehavior(gate: WorkflowGateConfig): CommandBindingBehavior {
  if (gate.type === 'security-scan') return gate.command ? 'builtin-security-and-command' : 'builtin-security';
  if (!['build', 'test', 'lint', 'e2e-pass'].includes(gate.type)) return 'not-command-gate';
  if (gate.skipReason) return 'skip';
  return gate.command ? 'execute-command' : 'missing-command';
}
