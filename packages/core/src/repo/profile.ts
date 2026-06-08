import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import type { CommandInvocation } from '../types/domain.js';

const repoProfileCommandSchema = z
  .object({
    tool: z.string().min(1),
    args: z.array(z.string()).default([]),
    description: z.string().min(1).optional(),
  })
  .strict();

export const repoProfileSchema = z
  .object({
    version: z.number().int().positive().default(1),
    commands: z
      .object({
        build: repoProfileCommandSchema.optional(),
        typecheck: repoProfileCommandSchema.optional(),
        lint: repoProfileCommandSchema.optional(),
        test: repoProfileCommandSchema.optional(),
        e2e: repoProfileCommandSchema.optional(),
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
  name: keyof RepoProfile['commands'],
): CommandInvocation | null {
  const command = profile.commands[name];
  return command ? { tool: command.tool, args: command.args } : null;
}

export function detectRepoProfile(repoPath: string): RepoProfile {
  const packageJsonPath = join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return repoProfileSchema.parse({});
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  const scripts = packageJson.scripts ?? {};
  const runner = packageJson.packageManager?.startsWith('pnpm@')
    ? 'pnpm'
    : 'npm';

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
    },
    pr: { baseBranch: 'main', titlePrefix: '' },
    risks: { highRiskPaths: [], requiresHumanApproval: [] },
  });
}

function scriptCommand(
  runner: 'npm' | 'pnpm',
  scriptName: string,
  description: string,
) {
  return runner === 'pnpm'
    ? { tool: 'pnpm', args: [scriptName], description }
    : { tool: 'npm', args: ['run', scriptName], description };
}
