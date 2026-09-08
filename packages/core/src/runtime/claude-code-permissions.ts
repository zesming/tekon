import { basename } from 'node:path';

import type {
  CommandPolicy,
  PermissionProfile,
} from '../types/config.js';
import type { CommandInvocation } from '../types/domain.js';

/** Permission rules understood by Claude Code's command line interface. */
export interface ClaudePermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

interface CommandPattern {
  tool: string;
  args: string[];
  match: 'exact' | 'prefix';
}

interface CandidateCommand extends CommandPattern {
  rule: string;
}

/**
 * The provider receives a small, explicit set of checks. A broad command
 * policy or a native `Bash(*)` capability can only select from this set; it
 * can never become a broad Claude permission by itself.
 */
const CANDIDATES: readonly CandidateCommand[] = [
  candidate('npm', ['test']),
  candidate('npm', ['run', 'test']),
  candidate('npm', ['run', 'build']),
  candidate('npm', ['run', 'lint']),
  candidate('npm', ['run', 'typecheck']),
  candidate('pnpm', ['test']),
  candidate('pnpm', ['run', 'test']),
  candidate('pnpm', ['build']),
  candidate('pnpm', ['run', 'build']),
  candidate('pnpm', ['lint']),
  candidate('pnpm', ['run', 'lint']),
  candidate('pnpm', ['typecheck']),
  candidate('pnpm', ['run', 'typecheck']),
  candidate('git', ['status']),
  candidate('git', ['diff']),
  candidate('git', ['log']),
];

const NON_COMMAND_TOOLS = new Set([
  'Read',
  'Edit',
  'Glob',
  'Grep',
  'Write',
  'Task',
  'WebFetch',
  'WebSearch',
]);

/**
 * Compile Tekon's structured command policy together with the provider's
 * native capability profile. The structured policy is authoritative for
 * grants; the profile is an additional upper bound. Both deny sources and
 * structured human-approval rules are retained independently.
 */
export function compileClaudePermissions(
  profile: PermissionProfile,
  commandPolicy?: CommandPolicy,
): ClaudePermissionRules {
  const nativeAllow = (profile.tools?.allow ?? []).map((rule) =>
    parseNativeRule(rule, 'allow'),
  );
  const nativeDeny = (profile.tools?.deny ?? []).map((rule) => {
    // Native Claude rules are preserved. Plain command strings from the role
    // compiler are converted to equivalent Bash prefix rules. A malformed
    // rule must fail startup rather than silently weakening the boundary.
    assertSafeNativeRule(rule, 'deny');
    return serializeNativeDeny(rule);
  });
  const nativeDenyPatterns = (profile.tools?.deny ?? []).map((rule) =>
    parseNativeRule(rule, 'deny'),
  );

  const policyAllow = commandPolicy?.allow ?? [];
  const policyDeny = commandPolicy?.deny ?? [];
  const policyAsk = commandPolicy?.requiresHumanApproval ?? [];

  // Validate every structured rule before any rule is filtered by the finite
  // candidate set. This keeps an unsafe configuration from being hidden just
  // because it currently has no matching candidate.
  [...policyAllow, ...policyDeny, ...policyAsk].forEach(assertSafeInvocation);

  const denyRules = policyDeny.map(serializeInvocation);
  const askRules = policyAsk.map(serializeInvocation);
  const denyPatterns: CommandPattern[] = [
    ...policyDeny.map(toPattern),
    ...nativeDenyPatterns.filter(
      (pattern): pattern is CommandPattern => pattern !== null,
    ),
  ];
  const askPatterns = policyAsk.map(toPattern);

  const allowRules = CANDIDATES.filter((candidateEntry) => {
    if (!policyAllow.some((entry) => matchesInvocation(candidateEntry, entry))) {
      return false;
    }

    if (
      !nativeAllow.some(
        (entry): entry is CommandPattern =>
          entry !== null &&
          entry.tool !== '*' &&
          matchesPattern(candidateEntry, entry),
      )
    ) {
      return false;
    }

    // Do not put a command in Claude's allow list when a deny or approval
    // rule also covers it. Claude gives those constraints precedence, but
    // removing the conflict keeps the generated allow list self-contained.
    return (
      !denyPatterns.some((entry) => matchesPattern(candidateEntry, entry)) &&
      !askPatterns.some((entry) => matchesPattern(candidateEntry, entry))
    );
  }).map((entry) => entry.rule);

  return {
    allow: unique(allowRules),
    deny: unique([...nativeDeny, ...denyRules]),
    ask: unique(askRules),
  };
}

function candidate(tool: string, args: string[]): CandidateCommand {
  return {
    tool,
    args,
    match: 'exact',
    rule: `Bash(${[tool, ...args].join(' ')})`,
  };
}

function toPattern(command: CommandInvocation): CommandPattern {
  return {
    tool: command.tool,
    args: [...(command.args ?? [])],
    match: command.match === 'exact' ? 'exact' : 'prefix',
  };
}

function matchesInvocation(
  candidateEntry: CandidateCommand,
  pattern: CommandInvocation,
): boolean {
  return matchesPattern(candidateEntry, toPattern(pattern));
}

function matchesPattern(
  candidateEntry: CandidateCommand,
  pattern: CommandPattern,
): boolean {
  if (!matchesTool(candidateEntry.tool, pattern.tool)) {
    return false;
  }

  if (
    pattern.match === 'exact' &&
    candidateEntry.args.length !== pattern.args.length
  ) {
    return false;
  }

  return pattern.args.every((arg, index) => candidateEntry.args[index] === arg);
}

function matchesTool(candidateTool: string, patternTool: string): boolean {
  if (patternTool === '*') {
    return true;
  }

  return (
    patternTool === candidateTool ||
    (!patternTool.includes('/') && basename(candidateTool) === patternTool)
  );
}

function serializeInvocation(command: CommandInvocation): string {
  const args = command.args ?? [];
  const commandText = [command.tool, ...args].join(' ');
  return command.match === 'exact'
    ? `Bash(${commandText})`
    : `Bash(${commandText} *)`;
}

function serializeNativeDeny(rawRule: string): string {
  if (
    rawRule.startsWith('Bash(') ||
    rawRule === '*' ||
    NON_COMMAND_TOOLS.has(rawRule) ||
    isNativeToolRule(rawRule) ||
    rawRule === 'Bash'
  ) {
    return rawRule;
  }

  // Plain command strings are the providerPermission format emitted by the
  // role compiler. Keep their prefix semantics when converting them to the
  // Claude Bash rule language.
  const pattern = parseNativeRule(rawRule, 'deny');
  if (!pattern) {
    return rawRule;
  }
  return serializePattern(pattern);
}

function serializePattern(pattern: CommandPattern): string {
  const commandText = [pattern.tool, ...pattern.args].join(' ');
  return pattern.match === 'exact'
    ? `Bash(${commandText})`
    : `Bash(${commandText} *)`;
}

/**
 * Parse a native Claude-style rule for use as a capability cap. Native allow
 * rules are never emitted directly: only a recognized candidate can result.
 * Plain role compiler output keeps its historical prefix semantics.
 */
function parseNativeRule(
  rawRule: string,
  kind: 'allow' | 'deny',
): CommandPattern | null {
  assertSafeNativeRule(rawRule, kind);

  if (NON_COMMAND_TOOLS.has(rawRule) || rawRule === 'Bash') {
    return kind === 'deny' && rawRule === 'Bash'
      ? { tool: '*', args: [], match: 'prefix' }
      : null;
  }

  if (rawRule === '*') {
    return kind === 'deny'
      ? { tool: '*', args: [], match: 'prefix' }
      : null;
  }

  if (rawRule.startsWith('Bash(')) {
    if (!rawRule.endsWith(')')) {
      throw unsafeRuleError(rawRule, kind);
    }
    return parseBashRule(rawRule, kind);
  }

  if (isNativeToolRule(rawRule)) {
    return null;
  }

  // The role compiler stores provider permissions as a readable command
  // string (for example `npm` or `git status`). Split only on whitespace;
  // quoting and shell syntax were rejected above, so argv boundaries remain
  // deterministic. Plain rules retain prefix semantics.
  const tokens = rawRule.trim().split(/\s+/u);
  if (tokens.length === 0 || !tokens[0]) {
    throw unsafeRuleError(rawRule, kind);
  }
  const wildcard = tokens.at(-1) === '*';
  const commandTokens = wildcard ? tokens.slice(0, -1) : tokens;
  if (commandTokens.length === 0) {
    return kind === 'deny'
      ? { tool: '*', args: [], match: 'prefix' }
      : null;
  }

  return {
    tool: commandTokens[0]!,
    args: commandTokens.slice(1),
    match: 'prefix',
  };
}

function parseBashRule(rawRule: string, kind: 'allow' | 'deny'): CommandPattern {
  const body = rawRule.slice('Bash('.length, -1);
  const tokens = body.trim().split(/\s+/u);
  if (tokens.length === 0 || !tokens[0]) {
    throw unsafeRuleError(rawRule, kind);
  }

  const wildcard = tokens.at(-1) === '*';
  const commandTokens = wildcard ? tokens.slice(0, -1) : tokens;
  if (commandTokens.length === 0) {
    return { tool: '*', args: [], match: 'prefix' };
  }

  return {
    tool: commandTokens[0]!,
    args: commandTokens.slice(1),
    match: wildcard ? 'prefix' : 'exact',
  };
}

function assertSafeInvocation(command: CommandInvocation): void {
  assertSafeToken(command.tool, `command tool ${command.tool}`);
  for (const arg of command.args ?? []) {
    assertSafeToken(arg, `command argument for ${command.tool}`);
  }
}

function assertSafeNativeRule(rawRule: string, kind: 'allow' | 'deny'): void {
  if (!rawRule.trim() || /[\r\n]/u.test(rawRule)) {
    throw unsafeRuleError(rawRule, kind);
  }

  // Native rules may contain spaces and a trailing `*`, which are part of
  // Claude's rule syntax. Other shell/control or pattern characters cannot be
  // safely represented as one argv value.
  if (/["'`;&|$<>\\]/u.test(rawRule)) {
    throw unsafeRuleError(rawRule, kind);
  }

  if (rawRule.startsWith('Bash(')) {
    const body = rawRule.endsWith(')')
      ? rawRule.slice('Bash('.length, -1)
      : '';
    const tokens = body.trim().split(/\s+/u);
    const wildcardIndexes = tokens
      .map((token, index) => (token === '*' ? index : -1))
      .filter((index) => index >= 0);
    if (
      !rawRule.endsWith(')') ||
      tokens.length === 0 ||
      !tokens[0] ||
      (wildcardIndexes.length > 0 &&
        wildcardIndexes[wildcardIndexes.length - 1] !== tokens.length - 1)
    ) {
      throw unsafeRuleError(rawRule, kind);
    }
    for (const token of tokens) {
      if (token !== '*') {
        assertSafeToken(token, `native ${kind} rule`);
      }
    }
    return;
  }

  if (isNativeToolRule(rawRule)) {
    return;
  }

  // A plain native rule can be an existing Claude tool name or a command
  // string emitted by the role compiler. Validate each whitespace-delimited
  // token while allowing one trailing wildcard.
  const tokens = rawRule.trim().split(/\s+/u);
  for (const [index, token] of tokens.entries()) {
    if (token === '*' && index === tokens.length - 1) {
      continue;
    }
    assertSafeToken(token, `native ${kind} rule`);
  }
}

function isNativeToolRule(rawRule: string): boolean {
  if (rawRule.startsWith('mcp__') && !/\s/u.test(rawRule)) {
    return true;
  }
  // Claude also accepts bare tool names such as `Agent`, in addition to
  // scoped rules such as `Read(./src/**)`. Keep those rules in Claude's
  // native syntax instead of treating the name as a shell command.
  return /^[A-Z][A-Za-z0-9_]*(?:\(.+\))?$/u.test(rawRule);
}

function assertSafeToken(value: string, context: string): void {
  if (
    !value ||
    /\s/u.test(value) ||
    /["'`;&|$<>\\*?[\]{}(),!]/u.test(value)
  ) {
    throw new Error(
      `Claude permission ${context} cannot be serialized safely`,
    );
  }
}

function unsafeRuleError(rawRule: string, kind: 'allow' | 'deny'): Error {
  return new Error(
    `Claude permission ${kind} rule cannot be serialized safely: ${rawRule}`,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
