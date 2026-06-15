import type { RoleAgentConfig } from '../role/loader.js';

export type AutonomyLevel = 'assist' | 'review-gated' | 'auto-pr' | 'restricted';
export type RiskTolerance = 'low' | 'medium' | 'high';

export interface HumanApprovalRule {
  filePatterns?: string[];
  toolPatterns?: string[];
  actionTypes?: string[];
}

export interface RoleRuntimePolicy {
  autonomy: { level: AutonomyLevel; riskTolerance: RiskTolerance };
  requiresHumanApproval: HumanApprovalRule[];
  defaultTimeoutMs?: number;
  allowedGateTags?: string[];
}

export interface HumanApprovalContext {
  files?: string[];
  tools?: string[];
  actions?: string[];
}

const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'review-gated';
const DEFAULT_RISK_TOLERANCE: RiskTolerance = 'medium';

export function compileRoleRuntimePolicy(agentConfig: RoleAgentConfig): RoleRuntimePolicy {
  const level = agentConfig.autonomy?.level ?? DEFAULT_AUTONOMY_LEVEL;
  const riskTolerance = agentConfig.autonomy?.riskTolerance ?? DEFAULT_RISK_TOLERANCE;

  return {
    autonomy: { level, riskTolerance },
    requiresHumanApproval: agentConfig.requiresHumanApprovalFor ?? [],
    defaultTimeoutMs: agentConfig.defaultTimeoutMs,
    allowedGateTags: agentConfig.allowedGateTags,
  };
}

export function requiresHumanApproval(
  policy: RoleRuntimePolicy,
  context: HumanApprovalContext,
): boolean {
  if (policy.requiresHumanApproval.length === 0) {
    return false;
  }

  for (const rule of policy.requiresHumanApproval) {
    if (matchesRule(rule, context)) {
      return true;
    }
  }

  return false;
}

function matchesRule(rule: HumanApprovalRule, context: HumanApprovalContext): boolean {
  if (rule.filePatterns && rule.filePatterns.length > 0 && context.files) {
    for (const pattern of rule.filePatterns) {
      for (const file of context.files) {
        if (matchGlob(pattern, file)) {
          return true;
        }
      }
    }
  }

  if (rule.toolPatterns && rule.toolPatterns.length > 0 && context.tools) {
    for (const pattern of rule.toolPatterns) {
      for (const tool of context.tools) {
        if (matchGlob(pattern, tool)) {
          return true;
        }
      }
    }
  }

  if (rule.actionTypes && rule.actionTypes.length > 0 && context.actions) {
    for (const actionType of rule.actionTypes) {
      if (context.actions.includes(actionType)) {
        return true;
      }
    }
  }

  return false;
}

export function canSatisfyGate(
  policy: RoleRuntimePolicy,
  gateTags: string[],
): boolean {
  if (!policy.allowedGateTags || policy.allowedGateTags.length === 0) {
    return true;
  }

  return gateTags.every((tag) => policy.allowedGateTags!.includes(tag));
}

/**
 * Simple glob matching supporting *, **, and ? wildcards.
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/` (recursive directory match)
 * - `?` matches a single character except `/`
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
        // ** — match everything including /
        if (pattern[i + 2] === '/') {
          result += '(?:.*/)?';
          i += 3;
        } else {
          result += '.*';
          i += 2;
        }
      } else {
        // * — match everything except /
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
