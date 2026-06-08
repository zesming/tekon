import { readFileSync } from 'node:fs';
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

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: number;
  retryPolicy: WorkflowRetryPolicy;
  phases: WorkflowTemplatePhase[];
}

export type BuiltInWorkflowTemplateId = 'standard-feature' | 'bugfix';

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

export function loadWorkflowTemplate(options: {
  name: string;
  workflowsDir?: string;
}): WorkflowTemplate {
  if (!/^[a-zA-Z0-9_-]+$/u.test(options.name)) {
    throw new Error(`invalid workflow template name: ${options.name}`);
  }
  return loadWorkflowTemplateFile(
    join(getWorkflowsDir(options.workflowsDir), `${options.name}.yaml`),
  );
}

export function loadBuiltInWorkflowTemplate(
  id: BuiltInWorkflowTemplateId,
  options: { workflowsDir?: string } = {},
): WorkflowTemplate {
  return loadWorkflowTemplate({ name: id, workflowsDir: options.workflowsDir });
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

  if (!hasReviewer) {
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
