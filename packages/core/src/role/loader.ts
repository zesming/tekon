import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { roleSchema, type Role } from '../types/domain.js';
import { loadSkillsFromRoleDir, type RoleSkill } from './skill-loader.js';
import type { RoleToolsConfig } from './tool-policy.js';

const roleAgentConfigSchema = z.object({
  role: roleSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  injectMode: z.enum(['prepend', 'append', 'replace']).default('append'),
  priority: z.number().int().default(0),
  maxSkills: z.number().int().positive().optional(),
  knowledgeFiles: z.array(z.string().min(1)).default([]),
});

const toolsConfigSchema = z.object({
  network: z.enum(['disabled', 'restricted', 'enabled']).default('disabled'),
  allow: z
    .array(
      z.object({
        tool: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  deny: z
    .array(
      z.object({
        tool: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  requiresHumanApproval: z
    .array(
      z.object({
        tool: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type RoleAgentConfig = z.infer<typeof roleAgentConfigSchema>;
export type RoleSource = 'project' | 'user' | 'built-in';

export interface LoadedKnowledgeFile {
  path: string;
  content: string;
}

export interface LoadedRole {
  role: Role;
  source: RoleSource;
  roleDir: string;
  agent: RoleAgentConfig;
  systemPrompt: string;
  skills: RoleSkill[];
  knowledge: LoadedKnowledgeFile[];
  tools: RoleToolsConfig;
}

export interface LoadRoleOptions {
  role: Role;
  repoPath: string;
  userHome?: string;
  builtInRolesDir?: string;
}

interface RoleCandidate {
  source: RoleSource;
  roleDir: string;
}

export function loadRole(options: LoadRoleOptions): LoadedRole {
  const candidates = getRoleCandidates(options).filter((candidate) =>
    isDirectory(candidate.roleDir),
  );
  const selected = candidates.at(-1);
  if (!selected) {
    throw new Error(`role not found: ${options.role}`);
  }

  const agent = readAgentConfig(selected.roleDir, options.role);
  const systemPrompt = readTextFile(join(selected.roleDir, 'system.md'));
  const tools = readToolsConfig(selected.roleDir);
  const mergedSkills = mergeSkills(candidates);
  const limitedSkills =
    agent.maxSkills === undefined
      ? mergedSkills
      : mergedSkills.slice(0, agent.maxSkills);

  return {
    role: options.role,
    source: selected.source,
    roleDir: selected.roleDir,
    agent,
    systemPrompt,
    tools,
    skills: limitedSkills,
    knowledge: loadKnowledgeFiles(selected.roleDir, agent.knowledgeFiles),
  };
}

function getRoleCandidates(options: LoadRoleOptions): RoleCandidate[] {
  const userHome = options.userHome ?? process.env.HOME ?? '';
  const builtInRolesDir =
    options.builtInRolesDir ?? resolve(process.cwd(), 'roles');
  return [
    {
      source: 'built-in',
      roleDir: join(builtInRolesDir, options.role),
    },
    {
      source: 'user',
      roleDir: join(userHome, '.donkey', 'roles', options.role),
    },
    {
      source: 'project',
      roleDir: join(options.repoPath, '.donkey', 'roles', options.role),
    },
  ];
}

function readAgentConfig(roleDir: string, expectedRole: Role): RoleAgentConfig {
  const raw = readTextFile(join(roleDir, 'agent.yaml'));
  const parsed = roleAgentConfigSchema.parse(parseYaml(raw));
  if (parsed.role !== expectedRole) {
    throw new Error(
      `agent.yaml role mismatch: expected ${expectedRole}, got ${parsed.role}`,
    );
  }
  return parsed;
}

function readToolsConfig(roleDir: string): RoleToolsConfig {
  const toolsPath = join(roleDir, 'tools.yaml');
  if (!existsSync(toolsPath)) {
    return {
      network: 'disabled',
      allow: [],
      deny: [],
      requiresHumanApproval: [],
    };
  }

  return toolsConfigSchema.parse(parseYaml(readTextFile(toolsPath)));
}

function loadKnowledgeFiles(
  roleDir: string,
  knowledgeFiles: string[],
): LoadedKnowledgeFile[] {
  return knowledgeFiles.map((path) => ({
    path,
    content: readTextFile(join(roleDir, path)).trim(),
  }));
}

function mergeSkills(candidates: RoleCandidate[]): RoleSkill[] {
  const skillsById = new Map<string, RoleSkill>();
  for (const candidate of candidates) {
    for (const skill of loadSkillsFromRoleDir(candidate.roleDir)) {
      skillsById.set(skill.id, skill);
    }
  }

  return [...skillsById.values()].sort((left, right) => {
    const priority = right.priority - left.priority;
    return priority === 0 ? left.id.localeCompare(right.id) : priority;
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function listRoleIds(rolesRoot: string): Role[] {
  if (!existsSync(rolesRoot)) {
    return [];
  }
  return readdirSync(rolesRoot)
    .filter((entry) => isDirectory(join(rolesRoot, entry)))
    .flatMap((entry) => {
      const parsed = roleSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
}
