import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import type { CommandInvocation } from '../types/domain.js';

const repoProfileCommandNames = [
  'build',
  'typecheck',
  'lint',
  'test',
  'e2e',
  'security',
] as const;

const candidateScriptNames: Record<RepoProfileCommandName, string[]> = {
  build: ['build', 'compile', 'bundle'],
  typecheck: ['typecheck', 'tsc', 'check-types'],
  lint: ['lint', 'eslint'],
  test: ['test', 'unit', 'test:unit'],
  e2e: ['e2e', 'test:e2e', 'playwright'],
  security: ['security:scan', 'security', 'audit'],
};

const repoProfileCommandSchema = z
  .object({
    tool: z.string().min(1),
    args: z.array(z.string()).default([]),
    description: z.string().min(1).optional(),
  })
  .strict();

const repoProfileNotApplicableCommandSchema = z
  .object({
    notApplicable: z.literal(true),
    reason: z.string().min(1),
  })
  .strict();

const repoProfileCommandEntrySchema = z.union([
  repoProfileCommandSchema,
  repoProfileNotApplicableCommandSchema,
]);

export const repoProfileSchema = z
  .object({
    version: z.number().int().positive().default(1),
    commands: z
      .object({
        build: repoProfileCommandEntrySchema.optional(),
        typecheck: repoProfileCommandEntrySchema.optional(),
        lint: repoProfileCommandEntrySchema.optional(),
        test: repoProfileCommandEntrySchema.optional(),
        e2e: repoProfileCommandEntrySchema.optional(),
        security: repoProfileCommandEntrySchema.optional(),
      })
      .default({}),
    pr: z
      .object({
        baseBranch: z.string().min(1).default('main'),
        titlePrefix: z.string().default(''),
        bodyTemplate: z.string().optional(),
      })
      .default({ baseBranch: 'main', titlePrefix: '' }),
    risks: z
      .object({
        highRiskPaths: z.array(z.string().min(1)).default([]),
        requiresHumanApproval: z.array(z.string().min(1)).default([]),
      })
      .default({ highRiskPaths: [], requiresHumanApproval: [] }),
  })
  .strict();

export type RepoProfile = z.infer<typeof repoProfileSchema>;
export type RepoProfileCommandName = (typeof repoProfileCommandNames)[number];

export interface RepoProfileCommandFixSuggestion {
  commandRef: RepoProfileCommandName;
  profilePath: string;
  scriptName: string;
  command: CommandInvocation;
  commandText: string;
  yamlSnippet: string;
}

export interface RepoProfileCommandGuidance {
  commandRef: RepoProfileCommandName;
  profilePath: string;
  status: 'resolved' | 'missing' | 'not-applicable';
  command: CommandInvocation | null;
  commandText: string;
  hint: string;
  reason?: string;
  suggestions: RepoProfileCommandFixSuggestion[];
}

export type RepoProfileCommandResolution =
  | {
      status: 'resolved';
      command: CommandInvocation;
      commandText: string;
    }
  | {
      status: 'not-applicable';
      reason: string;
    }
  | {
      status: 'missing';
    };

export function loadRepoProfile(repoPath: string): RepoProfile {
  const profilePath = repoProfilePath(repoPath);
  if (!existsSync(profilePath)) {
    return detectRepoProfile(repoPath);
  }

  return repoProfileSchema.parse(parseYaml(readFileSync(profilePath, 'utf8')));
}

export function writeDefaultRepoProfile(repoPath: string): RepoProfile {
  const profile = detectRepoProfile(repoPath);
  writeFileSync(
    repoProfilePath(repoPath),
    stringifyYaml(profile, { sortMapEntries: false }),
    'utf8',
  );
  return profile;
}

export function repoProfilePath(repoPath: string): string {
  return join(repoPath, '.donkey', 'repo-profile.yaml');
}

export function repoProfileCommand(
  profile: RepoProfile,
  name: RepoProfileCommandName,
): CommandInvocation | null {
  const resolution = repoProfileCommandResolution(profile, name);
  return resolution.status === 'resolved' ? resolution.command : null;
}

export function repoProfileCommandResolution(
  profile: RepoProfile,
  name: RepoProfileCommandName,
): RepoProfileCommandResolution {
  const entry = profile.commands[name];
  if (!entry) {
    return { status: 'missing' };
  }
  if (isNotApplicableCommand(entry)) {
    return { status: 'not-applicable', reason: entry.reason };
  }
  const command = { tool: entry.tool, args: entry.args };
  return {
    status: 'resolved',
    command,
    commandText: formatCommandInvocation(command),
  };
}

export function repoProfileCommandGuidance(
  repoPath: string,
  profile: RepoProfile,
  name: RepoProfileCommandName,
): RepoProfileCommandGuidance {
  const resolution = repoProfileCommandResolution(profile, name);
  const profilePath = repoProfilePath(repoPath);
  if (resolution.status === 'resolved') {
    return {
      commandRef: name,
      profilePath,
      status: 'resolved',
      command: resolution.command,
      commandText: resolution.commandText,
      hint: '',
      suggestions: [],
    };
  }
  if (resolution.status === 'not-applicable') {
    return {
      commandRef: name,
      profilePath,
      status: 'not-applicable',
      command: null,
      commandText: '',
      hint: `commands.${name} is explicitly marked notApplicable`,
      reason: resolution.reason,
      suggestions: [],
    };
  }

  const suggestions = suggestRepoProfileCommandFixes(repoPath, name);
  const hint =
    suggestions.length > 0
      ? `add commands.${name} to .donkey/repo-profile.yaml`
      : `add commands.${name} to .donkey/repo-profile.yaml with this repo's validation command`;
  return {
    commandRef: name,
    profilePath,
    status: 'missing',
    command: null,
    commandText: '',
    hint,
    suggestions,
  };
}

export function suggestRepoProfileCommandFixes(
  repoPath: string,
  name: RepoProfileCommandName,
): RepoProfileCommandFixSuggestion[] {
  const packageScripts = readPackageScripts(repoPath);
  if (!packageScripts) {
    return [];
  }

  const scriptName = candidateScriptNames[name].find(
    (candidate) => packageScripts.scripts[candidate],
  );
  if (!scriptName) {
    return [];
  }

  const command = scriptCommand(packageScripts.runner, scriptName);
  return [
    {
      commandRef: name,
      profilePath: repoProfilePath(repoPath),
      scriptName,
      command,
      commandText: formatCommandInvocation(command),
      yamlSnippet: formatRepoProfileCommandYaml(name, command),
    },
  ];
}

export function detectRepoProfile(repoPath: string): RepoProfile {
  const packageScripts = readPackageScripts(repoPath);
  if (!packageScripts) {
    return repoProfileSchema.parse({});
  }

  const { runner, scripts } = packageScripts;

  return repoProfileSchema.parse({
    version: 1,
    commands: {
      ...(scripts.build
        ? { build: scriptCommand(runner, 'build', 'Build gate') }
        : {}),
      ...(scripts.typecheck
        ? { typecheck: scriptCommand(runner, 'typecheck', 'Typecheck gate') }
        : {}),
      ...(scripts.lint
        ? { lint: scriptCommand(runner, 'lint', 'Lint gate') }
        : {}),
      ...(scripts.test
        ? { test: scriptCommand(runner, 'test', 'Test gate') }
        : {}),
      ...(scripts.e2e ? { e2e: scriptCommand(runner, 'e2e', 'E2E gate') } : {}),
      ...detectSecurityCommand(scripts, runner),
    },
    pr: { baseBranch: 'main', titlePrefix: '' },
    risks: { highRiskPaths: [], requiresHumanApproval: [] },
  });
}

function detectSecurityCommand(
  scripts: Record<string, string>,
  runner: 'npm' | 'pnpm',
) {
  const scriptName = ['security:scan', 'security', 'audit'].find(
    (name) => scripts[name],
  );
  return scriptName
    ? {
        security: scriptCommand(runner, scriptName, 'Security scan command'),
      }
    : {};
}

function scriptCommand(
  runner: 'npm' | 'pnpm',
  scriptName: string,
  description?: string,
) {
  const command =
    runner === 'pnpm'
      ? { tool: 'pnpm', args: [scriptName] }
      : { tool: 'npm', args: ['run', scriptName] };
  return description ? { ...command, description } : command;
}

function readPackageScripts(
  repoPath: string,
): { runner: 'npm' | 'pnpm'; scripts: Record<string, string> } | null {
  const packageJsonPath = join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  return {
    runner: packageJson.packageManager?.startsWith('pnpm@') ? 'pnpm' : 'npm',
    scripts: packageJson.scripts ?? {},
  };
}

function formatCommandInvocation(command: CommandInvocation): string {
  return [command.tool, ...command.args].join(' ');
}

function isNotApplicableCommand(
  entry: NonNullable<RepoProfile['commands'][RepoProfileCommandName]>,
): entry is z.infer<typeof repoProfileNotApplicableCommandSchema> {
  return 'notApplicable' in entry && entry.notApplicable === true;
}

function formatRepoProfileCommandYaml(
  name: RepoProfileCommandName,
  command: CommandInvocation,
): string {
  return stringifyYaml(
    {
      commands: {
        [name]: {
          tool: command.tool,
          args: command.args,
        },
      },
    },
    { sortMapEntries: false },
  ).trimEnd();
}
