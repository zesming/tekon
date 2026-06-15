import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const constraintActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('requiresGate'),
    gateType: z.string().min(1),
    gateKey: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('injectGate'),
    gateType: z.string().min(1),
    phase: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('requirePhase'),
    phaseName: z.string().min(1),
  }),
  z.object({
    type: z.literal('requireOutput'),
    artifactType: z.string().min(1),
  }),
  z.object({
    type: z.literal('suggest'),
    message: z.string().min(1),
  }),
]);

const constraintRuleSchema = z.object({
  id: z.string().min(1),
  when: z.object({
    riskLevel: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    filePatterns: z.array(z.string().min(1)).optional(),
  }),
  then: z.array(constraintActionSchema).min(1),
});

const constraintFileSchema = z.object({
  rules: z.array(constraintRuleSchema).default([]),
});

export type ConstraintAction = z.infer<typeof constraintActionSchema>;
export type ConstraintRule = z.infer<typeof constraintRuleSchema>;

export interface DslConstraintContext {
  tags?: string[];
  riskLevel?: string;
  files?: string[];
}

export interface DslConstraintEvaluationResult {
  required: ConstraintAction[];
  suggestions: ConstraintAction[];
}

export function loadConstraintRules(repoPath: string): ConstraintRule[] {
  const filePath = join(repoPath, 'constraints.yaml');
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = constraintFileSchema.parse(parseYaml(raw));
  return parsed.rules;
}

export function evaluateConstraints(
  rules: ConstraintRule[],
  context: DslConstraintContext,
): DslConstraintEvaluationResult {
  const required: ConstraintAction[] = [];
  const suggestions: ConstraintAction[] = [];

  for (const rule of rules) {
    if (!ruleMatchesContext(rule, context)) {
      continue;
    }

    for (const action of rule.then) {
      if (action.type === 'suggest') {
        suggestions.push(action);
      } else {
        required.push(action);
      }
    }
  }

  return { required, suggestions };
}

function ruleMatchesContext(
  rule: ConstraintRule,
  context: DslConstraintContext,
): boolean {
  const { when } = rule;
  const contextTags = (context.tags ?? []).map((tag) => tag.toLowerCase().trim());
  const contextRisk = context.riskLevel?.toLowerCase().trim();
  const contextFiles = context.files ?? [];

  if (when.riskLevel && when.riskLevel.length > 0) {
    const matchesRisk = when.riskLevel.some(
      (level) => level.toLowerCase().trim() === contextRisk,
    );
    if (!matchesRisk) {
      return false;
    }
  }

  if (when.tags && when.tags.length > 0) {
    const matchesTag = when.tags.some((tag) =>
      contextTags.includes(tag.toLowerCase().trim()),
    );
    if (!matchesTag) {
      return false;
    }
  }

  if (when.filePatterns && when.filePatterns.length > 0) {
    const matchesFile = when.filePatterns.some((pattern) =>
      contextFiles.some((file) => matchGlob(pattern, file)),
    );
    if (!matchesFile) {
      return false;
    }
  }

  // A rule with no conditions always matches (unconditional rule).
  const hasConditions =
    Boolean(when.riskLevel && when.riskLevel.length > 0) ||
    Boolean(when.tags && when.tags.length > 0) ||
    Boolean(when.filePatterns && when.filePatterns.length > 0);

  return hasConditions;
}

/**
 * Simple glob matching supporting *, **, and ? wildcards.
 */
function matchGlob(pattern: string, value: string): boolean {
  const regexStr = globToRegex(pattern);
  return new RegExp(`^${regexStr}$`, 'u').test(value);
}

function globToRegex(pattern: string): string {
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          result += '(?:.*/)?';
          i += 3;
        } else {
          result += '.*';
          i += 2;
        }
      } else {
        result += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      result += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      result += `\\${char}`;
      i++;
    } else {
      result += char;
      i++;
    }
  }
  return result;
}
