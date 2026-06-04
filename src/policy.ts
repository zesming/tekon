import type { RepoProfile, RiskLevel } from "./types.js";
import { hasShellControlOperator, parseCommandLine } from "./command-line.js";

export interface RiskEvaluation {
  level: RiskLevel;
  findings: string[];
}

export interface CommandPolicyResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateInputRisk(input: string, repoProfile: RepoProfile): RiskEvaluation {
  const normalized = input.toLowerCase();
  const keywordFindings = repoProfile.risk.highRiskKeywords.filter((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
  const pathFindings = repoProfile.risk.highRiskPaths.filter((highRiskPath) =>
    inputMentionsPath(normalized, highRiskPath),
  );
  const findings = [...keywordFindings, ...pathFindings];

  if (findings.length > 0) {
    return { level: "high", findings };
  }

  return { level: "low", findings: [] };
}

function inputMentionsPath(normalizedInput: string, highRiskPath: string): boolean {
  const normalizedPath = highRiskPath.toLowerCase();
  if (normalizedPath.startsWith(".")) {
    return normalizedInput.includes(normalizedPath);
  }

  const escaped = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s"'/:])${escaped}($|[\\s"'/.:])`, "i").test(normalizedInput);
}

export function evaluateCommandPolicy(command: string, repoProfile: RepoProfile): CommandPolicyResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: false,
      reason: "blocked empty command",
    };
  }

  if (hasShellControlOperator(trimmed)) {
    return {
      allowed: false,
      reason: "blocked shell control operator",
    };
  }

  try {
    if (parseCommandLine(trimmed).length === 0) {
      return {
        allowed: false,
        reason: "blocked empty command",
      };
    }
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "invalid command",
    };
  }

  for (const pattern of repoProfile.risk.blockedCommandPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(trimmed)) {
      return {
        allowed: false,
        reason: `blocked by command policy: ${pattern}`,
      };
    }
  }

  for (const pattern of repoProfile.risk.allowedCommandPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(trimmed)) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: "blocked by default deny policy",
  };
}
