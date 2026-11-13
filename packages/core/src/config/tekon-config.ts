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
  'BASHOPTS',
  'SHELLOPTS',
  'PS4',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'XDG_CONFIG_HOME',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
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
    // A malformed entry may be a value or token pasted in place of a name;
    // never echo it. The issue path gives its position instead.
    return 'entry is not an upper-case environment variable name';
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
    names.forEach((name, index) => {
      const issue = passthroughEnvNameIssue(name);
      if (issue) ctx.addIssue({ code: 'custom', message: issue, path: [index] });
    });
  });

/** Codex profile names: no leading `-` or `.`, so a value never reads as a flag. */
export const CODEX_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const tekonRepoConfigSchema = z
  .object({
    defaultAgent: z.enum(TEKON_DEFAULT_AGENTS).optional(),
    providers: z
      .object({
        'claude-code': z
          .object({ passthroughEnv: passthroughEnvSchema.optional() })
          .strict()
          .nullish(),
        codex: z
          .object({
            profile: z
              .string()
              .regex(CODEX_PROFILE_NAME, 'codex profile must be a safe profile name')
              .optional(),
            passthroughEnv: passthroughEnvSchema.optional(),
          })
          .strict()
          .nullish(),
      })
      .strict()
      .nullish(),
    // Older `tekon init` wrote project/storage; they are accepted and ignored.
    project: z.unknown().optional(),
    storage: z.unknown().optional(),
  })
  // Any other key is a typo (for example `defaultagent`) and is an error.
  .strict();

type ParsedConfig = z.infer<typeof tekonRepoConfigSchema>;
type ParsedProviders = NonNullable<ParsedConfig['providers']>;

export interface TekonRepoConfig {
  defaultAgent?: ParsedConfig['defaultAgent'];
  providers?: {
    [K in keyof ParsedProviders]?: NonNullable<ParsedProviders[K]>;
  };
}

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
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TekonConfigError(
      `.tekon/config.yaml cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    // Keep only the first line: the parser appends a source excerpt.
    const reason = (error as Error).message.split('\n')[0];
    throw new TekonConfigError(`.tekon/config.yaml is not valid YAML: ${reason}`);
  }
  const parsed = tekonRepoConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new TekonConfigError(`.tekon/config.yaml is invalid: ${details}`);
  }
  const { defaultAgent, providers } = parsed.data;
  const providerConfig: NonNullable<TekonRepoConfig['providers']> = {};
  if (providers?.['claude-code']) providerConfig['claude-code'] = providers['claude-code'];
  if (providers?.codex) providerConfig.codex = providers.codex;
  return {
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(providers ? { providers: providerConfig } : {}),
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
