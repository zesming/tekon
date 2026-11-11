import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const TEKON_DEFAULT_AGENTS = [
  'mock',
  'claude-code',
  'codex',
  'dsh-headless',
] as const;
export type TekonDefaultAgent = (typeof TEKON_DEFAULT_AGENTS)[number];

/** Agent used when neither `--agent` nor `defaultAgent` is set. */
export const FALLBACK_DEFAULT_AGENT: TekonDefaultAgent = 'claude-code';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
// Variables that change how a shell, runtime or tool loads code, or that
// Tekon itself controls. Passing them through would let repo config alter
// the provider process beyond handing it a value.
const BLOCKED_ENV_NAMES = new Set([
  'PATH',
  'SHELL',
  'ENV',
  'BASH_ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
]);
const BLOCKED_ENV_PREFIXES = [
  'NODE_',
  'LD_',
  'DYLD_',
  'GIT_',
  'TEKON_',
  'NPM_CONFIG_',
  'PYTHON',
];

export function passthroughEnvNameIssue(name: string): string | undefined {
  if (!ENV_NAME.test(name)) {
    return `${name} is not an upper-case environment variable name`;
  }
  if (BLOCKED_ENV_NAMES.has(name)) {
    return `${name} cannot be passed through`;
  }
  const prefix = BLOCKED_ENV_PREFIXES.find((item) => name.startsWith(item));
  if (prefix) {
    return `${name} cannot be passed through (${prefix}* is reserved)`;
  }
  return undefined;
}

/** Upper-case variable names a provider receives on top of its own allow list. */
export const passthroughEnvSchema = z
  .array(z.string())
  .superRefine((names, ctx) => {
    for (const name of names) {
      const issue = passthroughEnvNameIssue(name);
      if (issue) ctx.addIssue({ code: 'custom', message: issue });
    }
  });

const tekonRepoConfigSchema = z
  .object({
    defaultAgent: z.enum(TEKON_DEFAULT_AGENTS).optional(),
    providers: z
      .object({
        'claude-code': z
          .object({ passthroughEnv: passthroughEnvSchema.optional() })
          .strict()
          .optional(),
        codex: z
          .object({
            profile: z
              .string()
              .regex(/^[A-Za-z0-9._-]+$/u, 'codex profile must be a safe profile name')
              .optional(),
            passthroughEnv: passthroughEnvSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  // Older `tekon init` wrote project/storage; they are accepted and ignored.
  .passthrough();

export type TekonRepoConfig = Pick<
  z.infer<typeof tekonRepoConfigSchema>,
  'defaultAgent' | 'providers'
>;

export class TekonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TekonConfigError';
  }
}

export function tekonConfigPath(repoPath: string): string {
  return join(repoPath, '.tekon', 'config.yaml');
}

/**
 * Reads `.tekon/config.yaml`. A missing file is an empty config; a file that
 * does not parse or validate is an error, never a silent default.
 */
export function readTekonConfig(repoPath: string): TekonRepoConfig {
  const path = tekonConfigPath(repoPath);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new TekonConfigError(
      `.tekon/config.yaml is not valid YAML: ${(error as Error).message}`,
    );
  }
  const parsed = tekonRepoConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new TekonConfigError(`.tekon/config.yaml is invalid: ${details}`);
  }
  const { defaultAgent, providers } = parsed.data;
  return {
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(providers ? { providers } : {}),
  };
}

/** The one place that decides which agent a run uses without `--agent`. */
export function resolveDefaultAgent(config: TekonRepoConfig): TekonDefaultAgent {
  return config.defaultAgent ?? FALLBACK_DEFAULT_AGENT;
}

/**
 * Audit payload fragment naming the variables a provider snapshot passes
 * through. Names only: values never enter the hash-chained audit log.
 */
export function passthroughEnvAuditPayload(
  configSummary: Record<string, unknown> | undefined,
): { passthroughEnv?: string[] } {
  const names = configSummary?.passthroughEnv;
  return Array.isArray(names) && names.length > 0
    ? { passthroughEnv: names.filter((name): name is string => typeof name === 'string') }
    : {};
}
