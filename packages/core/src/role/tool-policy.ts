import type { z } from 'zod';

import {
  commandPolicySchema,
  type PermissionProfile,
} from '../types/config.js';
import type { CommandInvocation, Role } from '../types/domain.js';

export interface RoleToolsConfig {
  network?: 'disabled' | 'restricted' | 'enabled';
  allow?: CommandInvocation[];
  deny?: CommandInvocation[];
  requiresHumanApproval?: CommandInvocation[];
}

export interface CompileRoleToolPolicyInput {
  repoPath: string;
  role: Role;
  tools?: RoleToolsConfig;
}

export interface CompiledRoleToolPolicy {
  commandPolicy: z.infer<typeof commandPolicySchema>;
  providerPermission: PermissionProfile;
  promptSummary: string;
}

export function compileRoleToolPolicy(
  input: CompileRoleToolPolicyInput,
): CompiledRoleToolPolicy {
  const tools = input.tools ?? {};
  const allow = tools.allow ?? [];
  const deny = tools.deny ?? [];
  const requiresHumanApproval = tools.requiresHumanApproval ?? [];
  const network = tools.network ?? 'disabled';
  const commandPolicy = commandPolicySchema.parse({
    allow,
    deny,
    requiresHumanApproval,
    cwdScope: [input.repoPath],
    network,
  });

  return {
    commandPolicy,
    providerPermission: {
      sandbox: 'workspace-write',
      approval:
        requiresHumanApproval.length > 0 || input.role === 'pmo'
          ? 'on-request'
          : 'on-failure',
      filesystemScope: [input.repoPath],
      network,
      tools: {
        allow: allow.map(formatCommand),
        deny: deny.map(formatCommand),
      },
    },
    promptSummary: [
      `network: ${network}`,
      allow.length > 0
        ? `allow: ${allow.map(formatCommand).join(', ')}`
        : 'allow: none',
      deny.length > 0
        ? `deny: ${deny.map(formatCommand).join(', ')}`
        : 'deny: none',
      requiresHumanApproval.length > 0
        ? `requires human approval: ${requiresHumanApproval
            .map(formatCommand)
            .join(', ')}`
        : 'requires human approval: none',
    ].join('\n'),
  };
}

export function formatCommand(command: CommandInvocation): string {
  return [command.tool, ...(command.args ?? [])].join(' ').trim();
}
