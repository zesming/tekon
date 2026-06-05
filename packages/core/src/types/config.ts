import { z } from 'zod';

import {
  commandInvocationSchema,
  gateConfigSchema,
  roleSchema,
} from './domain.js';

const unsafeToolNames = new Set(['rm', 'sudo', 'su', 'chmod', 'chown']);
const shellMetaPattern = /[;&|`$<>]/u;

function assertSafeCommand(command: { tool: string; args?: string[] }) {
  if (unsafeToolNames.has(command.tool)) {
    return false;
  }

  if (shellMetaPattern.test(command.tool)) {
    return false;
  }

  return !(command.args ?? []).some((arg) => shellMetaPattern.test(arg));
}

export const toolPolicySchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const permissionProfileSchema = z
  .object({
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    approval: z.enum(['never', 'on-request', 'on-failure']),
    filesystemScope: z.array(z.string().min(1)).min(1),
    network: z.enum(['disabled', 'restricted', 'enabled']).default('disabled'),
    tools: toolPolicySchema.default({ allow: [], deny: [] }),
  })
  .superRefine((profile, ctx) => {
    if (
      profile.sandbox === 'danger-full-access' &&
      profile.approval === 'never'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'danger-full-access requires an approval boundary',
        path: ['approval'],
      });
    }

    if (profile.filesystemScope.includes('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filesystem scope must not be the filesystem root',
        path: ['filesystemScope'],
      });
    }

    if (profile.tools.allow.includes('*') && profile.tools.deny.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wildcard tools require explicit deny rules',
        path: ['tools', 'deny'],
      });
    }
  });
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

export const commandPolicySchema = z
  .object({
    allow: z.array(commandInvocationSchema).default([]),
    deny: z.array(commandInvocationSchema).default([]),
    requiresHumanApproval: z.array(commandInvocationSchema).default([]),
    cwdScope: z.array(z.string().min(1)).min(1),
    network: z.enum(['disabled', 'restricted', 'enabled']).default('disabled'),
  })
  .superRefine((policy, ctx) => {
    for (const [listName, list] of [
      ['allow', policy.allow] as const,
      ['deny', policy.deny] as const,
      ['requiresHumanApproval', policy.requiresHumanApproval] as const,
    ]) {
      for (const [index, command] of list.entries()) {
        if (!assertSafeCommand(command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'command policy cannot contain shell metacharacters or unsafe tool defaults',
            path: [listName, index],
          });
        }
      }
    }
  });
export type CommandPolicy = z.infer<typeof commandPolicySchema>;

export const agentAdapterConfigSchema = z.object({
  provider: z.enum(['mock', 'claude-code', 'custom']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  promptMode: z.enum(['stdin', 'arg-append', 'file']).default('stdin'),
  outputFormat: z.enum(['text', 'json']).default('text'),
  permissionProfile: permissionProfileSchema,
  timeoutMs: z.number().int().positive().default(300_000),
});
export type AgentAdapterConfig = z.infer<typeof agentAdapterConfigSchema>;

export const worktreeLeaseSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  role: roleSchema,
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  createdAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable().optional(),
});
export type WorktreeLease = z.infer<typeof worktreeLeaseSchema>;

export const runContextSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  projectId: z.string().min(1),
  repoPath: z.string().min(1),
  dataDir: z.string().min(1),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const donkeyConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    repoPath: z.string().min(1),
  }),
  storage: z.object({
    dataDir: z.string().min(1).default('.donkey'),
  }),
  defaultAgent: z.enum(['mock', 'claude-code', 'custom']).default('mock'),
});
export type DonkeyConfig = z.infer<typeof donkeyConfigSchema>;

export const workflowTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        role: roleSchema,
        gates: z.array(gateConfigSchema).default([]),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

export const dynamicWorkflowSpecSchema = z.object({
  goal: z.string().min(1),
  requiredRoles: z.array(roleSchema).min(1),
  gates: z.array(gateConfigSchema).default([]),
});
export type DynamicWorkflowSpec = z.infer<typeof dynamicWorkflowSpecSchema>;

export const constraintRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  appliesTo: z.array(roleSchema).optional(),
});
export type ConstraintRule = z.infer<typeof constraintRuleSchema>;

export const constraintRulesSchema = z.object({
  hard: z.array(constraintRuleSchema).default([]),
  conditional: z.array(constraintRuleSchema).default([]),
  soft: z.array(constraintRuleSchema).default([]),
});
export type ConstraintRules = z.infer<typeof constraintRulesSchema>;
