import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import {
  applyConstraintMutations,
  validateWorkflowConstraints,
  type ConstraintMutationResult,
  type WorkflowGate,
  type WorkflowTemplate as ConstraintWorkflowTemplate,
} from '../constraint/validator.js';
import type { AgentAdapter, AgentRunInput } from '../runtime/agent-adapter.js';
import {
  artifactTypeSchema,
  commandInvocationSchema,
  gateTypeSchema,
  roleSchema,
  type ArtifactType,
} from '../types/domain.js';
import { parseWorkflowTemplate } from './template.js';

export const workflowSpecDraftGateSchema = z
  .object({
    type: gateTypeSchema,
    command: commandInvocationSchema.optional(),
    artifactType: artifactTypeSchema.optional(),
    requiresHumanApproval: z.boolean().optional(),
    maxRetries: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().optional(),
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

export const workflowSpecDraftNodeSchema = z
  .object({
    id: z.string().min(1),
    role: roleSchema,
    dependsOn: z.array(z.string().min(1)).default([]),
    artifactOutputs: z.array(artifactTypeSchema).default([]),
    gates: z.array(workflowSpecDraftGateSchema).default([]),
  })
  .strict();

export const workflowSpecDraftPhaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([]),
    parallel: z.boolean().default(false),
    nodes: z.array(workflowSpecDraftNodeSchema).min(1),
  })
  .strict();

export const workflowSpecDraftSchema = z
  .object({
    demandSummary: z.string().min(1),
    phases: z.array(workflowSpecDraftPhaseSchema).min(1),
    riskTags: z.array(z.string().min(1)).default([]),
    riskLevel: z.string().min(1).optional(),
    assumptions: z.array(z.string().min(1)).default([]),
    openQuestions: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type WorkflowSpecDraft = z.infer<typeof workflowSpecDraftSchema>;

export interface GenerateDynamicWorkflowOptions {
  demandText: string;
  adapter: AgentAdapter;
  repoPath?: string;
  dataDir?: string;
  outputDir?: string;
  runId?: string;
}

export interface DynamicWorkflowPreview {
  dryRun: true;
  draft: WorkflowSpecDraft;
  workflow: ConstraintWorkflowTemplate;
  constraints: ConstraintMutationResult;
}

export interface SaveDynamicTemplateOptions {
  workflowsDir?: string;
}

export interface SaveDynamicTemplateResult {
  path: string;
  workflow: ConstraintWorkflowTemplate;
}

interface DynamicConstraintWorkflow extends ConstraintWorkflowTemplate {
  phases: DynamicConstraintPhase[];
}

interface DynamicConstraintPhase {
  id: string;
  name: string;
  nodes: DynamicConstraintNode[];
  dependsOn?: string[];
  parallel?: boolean;
  source?: string;
  explanation?: string;
}

interface DynamicConstraintNode {
  id: string;
  role: string;
  gates?: WorkflowGate[];
  dependsOn?: string[];
  outputs?: ArtifactType[];
  source?: string;
  explanation?: string;
}

const safeTemplateNamePattern = /^[a-zA-Z0-9_-]+$/u;

export async function generateDynamicWorkflow(
  options: GenerateDynamicWorkflowOptions,
): Promise<DynamicWorkflowPreview> {
  const runId = options.runId ?? 'dynamic-preview';
  const repoPath = options.repoPath ?? process.cwd();
  const dataDir = options.dataDir ?? join(repoPath, '.donkey');
  const outputDir =
    options.outputDir ?? mkDynamicOutputDir(`${runId}-pm-workflow-`);

  mkdirSync(outputDir, { recursive: true });

  const result = await options.adapter.runAgent(
    buildPmDraftInput({
      demandText: options.demandText,
      repoPath,
      dataDir,
      outputDir,
      runId,
    }),
  );

  if (result.timedOut) {
    throw new Error('PM workflow draft generation timed out');
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `PM workflow draft generation failed with exit code ${String(
        result.exitCode,
      )}`,
    );
  }

  const outputPath = result.outputFiles[0];
  if (!outputPath) {
    throw new Error('PM workflow draft generation did not produce JSON output');
  }

  const draft = parseWorkflowSpecDraftJson(readFileSync(outputPath, 'utf8'));
  return previewFromDraft(draft, options.demandText);
}

export function saveDynamicTemplate(
  spec: unknown,
  name: string,
  options: SaveDynamicTemplateOptions = {},
): SaveDynamicTemplateResult {
  if (!safeTemplateNamePattern.test(name)) {
    throw new Error(`invalid dynamic template name: ${name}`);
  }

  const draftResult = workflowSpecDraftSchema.safeParse(spec);
  if (!draftResult.success) {
    throw new Error(
      `invalid dynamic workflow spec: ${formatZodIssues(
        draftResult.error.issues,
      )}`,
    );
  }

  const preview = previewFromDraft(
    draftResult.data,
    draftResult.data.demandSummary,
  );
  const workflowsDir = getWorkflowsDir(options.workflowsDir);
  const targetPath = resolve(workflowsDir, `${name}.yaml`);
  assertInsideWorkflowsDir(workflowsDir, targetPath);

  const templateObject = toWorkflowTemplateObject(
    preview.workflow as DynamicConstraintWorkflow,
    name,
    draftResult.data.demandSummary,
  );
  parseWorkflowTemplate(templateObject);

  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(targetPath, stringifyYaml(templateObject), 'utf8');

  return {
    path: targetPath,
    workflow: preview.workflow,
  };
}

function previewFromDraft(
  draft: WorkflowSpecDraft,
  demandText: string,
): DynamicWorkflowPreview {
  const workflow = workflowFromDraft(draft);
  const hardValidation = validateWorkflowConstraints(workflow);
  if (!hardValidation.valid) {
    throw new Error(
      `dynamic workflow violates hard constraints: ${hardValidation.issues
        .map((issue) => issue.id)
        .join(', ')}`,
    );
  }

  const constraints = applyConstraintMutations(workflow, {
    title: draft.demandSummary,
    body: demandText,
    tags: draft.riskTags,
    riskLevel: draft.riskLevel,
  });
  if (!constraints.valid) {
    throw new Error(
      `dynamic workflow violates hard constraints: ${constraints.issues
        .map((issue) => issue.id)
        .join(', ')}`,
    );
  }

  return {
    dryRun: true,
    draft,
    workflow: constraints.workflow,
    constraints,
  };
}

function parseWorkflowSpecDraftJson(content: string): WorkflowSpecDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid PM workflow JSON: ${message}`);
  }

  const result = workflowSpecDraftSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `invalid dynamic workflow spec: ${formatZodIssues(result.error.issues)}`,
    );
  }

  return result.data;
}

function buildPmDraftInput(options: {
  demandText: string;
  repoPath: string;
  dataDir: string;
  outputDir: string;
  runId: string;
}): AgentRunInput {
  const createdAt = new Date().toISOString();
  const nodeId = 'dynamic-pm-draft';

  return {
    roleConfig: { role: 'pm', name: 'Dynamic Workflow PM' },
    prompt: buildPmPrompt(options.demandText),
    worktreeLease: {
      id: `${options.runId}-pm-preview`,
      runId: options.runId,
      nodeId,
      role: 'pm',
      repoPath: options.repoPath,
      worktreePath: options.repoPath,
      branchName: 'dynamic-preview',
      createdAt,
    },
    outputDir: options.outputDir,
    commandPolicy: {
      allow: [],
      deny: [],
      requiresHumanApproval: [],
      cwdScope: [options.repoPath],
      network: 'disabled',
    },
    runContext: {
      runId: options.runId,
      nodeId,
      projectId: 'dynamic-preview',
      repoPath: options.repoPath,
      dataDir: options.dataDir,
    },
  };
}

function buildPmPrompt(demandText: string): string {
  return [
    'You are the Donkey PM Agent. Produce only one WorkflowSpecDraft JSON object.',
    'Required top-level fields: demandSummary, phases, riskTags, assumptions, openQuestions.',
    'Each phase must include id, name, nodes, and optional dependsOn/parallel.',
    'Each node must include id, role, artifactOutputs, and optional dependsOn/gates.',
    'Allowed roles: pm, rd, qa, reviewer, pmo.',
    'Allowed artifactOutputs: demand-card, prd, tech-design, code-changes, test-report, review-report, security-report, rollback-plan, delivery-package.',
    'Code-change nodes must include build and lint gates. Code-change workflows must include validation and reviewer coverage.',
    `Demand: ${demandText}`,
  ].join('\n');
}

function workflowFromDraft(
  draft: WorkflowSpecDraft,
): DynamicConstraintWorkflow {
  return {
    id: 'dynamic-preview',
    name: draft.demandSummary,
    phases: draft.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      dependsOn: phase.dependsOn,
      parallel: phase.parallel,
      source: 'dynamic',
      nodes: phase.nodes.map((node) => ({
        id: node.id,
        role: node.role,
        dependsOn: node.dependsOn,
        outputs: node.artifactOutputs,
        source: 'dynamic',
        gates: node.gates.map((gate) => ({
          type: gate.type,
          ...(gate.command ? { command: gate.command } : {}),
          ...(gate.artifactType ? { artifactType: gate.artifactType } : {}),
          ...(gate.requiresHumanApproval !== undefined
            ? { requiresHumanApproval: gate.requiresHumanApproval }
            : {}),
          ...(gate.maxRetries !== undefined
            ? { maxRetries: gate.maxRetries }
            : {}),
          ...(gate.timeoutMs !== undefined
            ? { timeoutMs: gate.timeoutMs }
            : {}),
        })),
      })),
    })),
  };
}

function toWorkflowTemplateObject(
  workflow: DynamicConstraintWorkflow,
  id: string,
  name: string,
) {
  return {
    id,
    name,
    version: 1,
    phases: workflow.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      ...(phase.parallel ? { parallel: phase.parallel } : {}),
      ...(phase.dependsOn?.length ? { dependsOn: phase.dependsOn } : {}),
      nodes: phase.nodes.map((node) => ({
        id: node.id,
        role: node.role,
        ...(node.dependsOn?.length ? { dependsOn: node.dependsOn } : {}),
        ...(node.outputs?.length ? { outputs: node.outputs } : {}),
        ...(node.gates?.length
          ? { gates: node.gates.map((gate) => toTemplateGate(gate)) }
          : {}),
      })),
    })),
  };
}

function toTemplateGate(gate: WorkflowGate) {
  return {
    type: gate.type,
    ...(gate.command ? { command: gate.command } : {}),
    ...(gate.artifactType ? { artifactType: gate.artifactType } : {}),
    requiresHumanApproval:
      (gate.requiresHumanApproval ?? gate.type === 'human') ? true : undefined,
    ...(gate.maxRetries !== undefined ? { maxRetries: gate.maxRetries } : {}),
    ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
  };
}

function getWorkflowsDir(workflowsDir?: string) {
  if (workflowsDir) {
    return resolve(workflowsDir);
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, '..', '..', '..', '..', 'workflows');
}

function assertInsideWorkflowsDir(workflowsDir: string, targetPath: string) {
  const root = resolve(workflowsDir);
  const target = resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `dynamic template path escapes workflows directory: ${target}`,
    );
  }
}

function mkDynamicOutputDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), `donkey-${prefix}`));
}

function formatZodIssues(issues: z.ZodIssue[]) {
  return issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
