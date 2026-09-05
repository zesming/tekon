import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  artifactTypeSchema,
  commandInvocationSchema,
  gateTypeSchema,
  roleSchema,
  type ArtifactType,
  type CommandInvocation,
  type GateType,
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
  maxRetries: number;
  timeoutMs?: number;
  retryPolicy: WorkflowRetryPolicy;
  autoFix?: boolean;
  onExhausted?: 'block' | 'pause' | 'fail';
}

export interface WorkflowTemplateNode {
  id: string;
  role: Role;
  inputs: WorkflowArtifactInputRef[];
  outputs: WorkflowArtifactOutputRef[];
  gates: WorkflowGateConfig[];
  dependsOn: string[];
}

export interface WorkflowTemplatePhase {
  id: string;
  name: string;
  dependsOn: string[];
  parallel: boolean;
  nodes: WorkflowTemplateNode[];
}


export interface WorkflowCatalogEntry {
  id: string;
  name: string;
  builtin: boolean;
  path?: string;
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
  });

const rawNodeSchema = z
  .object({
    id: z.string().min(1),
    role: roleSchema,
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
    parallel: z.boolean().default(false),
    dependsOn: z.array(z.string().min(1)).default([]),
    nodes: z.array(rawNodeSchema).min(1),
  })
  .strict();

const rawWorkflowTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    version: z.number().int().positive().default(1),
    // 4b: governance mode. 'standard' (default) keeps every governance
    // invariant (notably the required reviewer node). 'none' is a WHITELIST
    // opt-out for lightweight `goal` runs (single agent node, optional gates);
    // it exempts ONLY the reviewer-node requirement and nothing else. Existing
    // delivery templates omit the field → 'standard' → unchanged.
    governance: z.enum(['standard', 'none']).default('standard'),
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
  for (const ext of ['.yaml', '.yml']) {
    const filePath = join(dir, `${options.name}${ext}`);
    if (existsSync(filePath)) {
      return loadWorkflowTemplateFile(filePath);
    }
  }
  return loadWorkflowTemplateFile(
    join(dir, `${options.name}.yaml`),
  );
}


export function listWorkflowCatalog(options?: {
  projectWorkflowsDir?: string;
}): WorkflowCatalogEntry[] {
  const catalogMap = new Map<string, WorkflowCatalogEntry>();

  const builtinDir = getWorkflowsDir();
  if (existsSync(builtinDir)) {
    try {
      const entries = readdirSync(builtinDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parsed = parseWorkflowFileEntry(entry.name);
        if (!parsed) continue;
        const { id, ext } = parsed;
        if (catalogMap.has(id) && ext === '.yml') {
          continue;
        }
        const fullPath = join(builtinDir, entry.name);
        let name = id;
        try {
          const raw = parseYaml(readFileSync(fullPath, 'utf8')) as {
            name?: unknown;
          } | null;
          if (raw && typeof raw.name === 'string' && raw.name.trim().length > 0) {
            name = raw.name.trim();
          }
        } catch {
          // fallback to id
        }
        catalogMap.set(id, {
          id,
          name,
          builtin: true,
          path: fullPath,
        });
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
        if (!entry.isFile()) continue;
        const parsed = parseWorkflowFileEntry(entry.name);
        if (!parsed) continue;
        const { id, ext } = parsed;
        const existing = catalogMap.get(id);
        if (existing && !existing.builtin && ext === '.yml') {
          continue;
        }
        const fullPath = join(options.projectWorkflowsDir, entry.name);
        let name = id;
        try {
          const raw = parseYaml(readFileSync(fullPath, 'utf8')) as {
            name?: unknown;
          } | null;
          if (raw && typeof raw.name === 'string' && raw.name.trim().length > 0) {
            name = raw.name.trim();
          }
        } catch {
          // fallback to id
        }
        catalogMap.set(id, {
          id,
          name,
          builtin: false,
          path: fullPath,
        });
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
    parallel: z.boolean(),
    nodes: z.array(z.object({
      id: z.string().min(1),
      role: roleSchema,
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

  let hasReviewer = false;
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
      assertCodeProducerHasBuildAndLint(rawNode.id, outputs, gates);

      if (rawNode.role === 'reviewer') {
        hasReviewer = true;
      }

      phaseNodes.push({
        id: rawNode.id,
        role: rawNode.role,
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
      parallel: rawPhase.parallel,
      nodes: phaseNodes,
    });
  }

  if (!hasReviewer && rawTemplate.governance !== 'none') {
    throw new Error('Workflow template must include a reviewer node');
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

function assertCodeProducerHasBuildAndLint(
  nodeId: string,
  outputs: WorkflowArtifactOutputRef[],
  gates: WorkflowGateConfig[],
) {
  if (!outputs.some((output) => output.type === 'code-changes')) {
    return;
  }

  const gateTypes = new Set(gates.map((gate) => gate.type));
  if (!gateTypes.has('build') || !gateTypes.has('lint')) {
    throw new Error(
      `Code-producing node "${nodeId}" must include build and lint gates`,
    );
  }
}
