const SENSITIVE_NAME = String.raw`(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)|KEY)`;
const SENSITIVE_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s]+)`;
const SENSITIVE_ASSIGNMENT = new RegExp(String.raw`\b(${SENSITIVE_NAME}=)${SENSITIVE_VALUE}`, "gi");
const SENSITIVE_NAME_WITH_SPACE = new RegExp(String.raw`\b(${SENSITIVE_NAME}\b\s+)${SENSITIVE_VALUE}`, "gi");
const SENSITIVE_FLAG = new RegExp(
  String.raw`(--(?:token|secret|password|api[-_]?key|access[-_]?key|private[-_]?key))(=|\s+)${SENSITIVE_VALUE}`,
  "gi",
);
const SENSITIVE_LABEL = new RegExp(
  String.raw`\b(token|secret|password|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key)(\s*:\s*)${SENSITIVE_VALUE}`,
  "gi",
);
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const HIGH_RISK_URL = /https?:\/\/[^\s"'<>]*(?:token|secret|key)[^\s"'<>]*/gi;

export function redactSensitive(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(SENSITIVE_NAME_WITH_SPACE, "$1[REDACTED]")
    .replace(SENSITIVE_FLAG, "$1$2[REDACTED]")
    .replace(SENSITIVE_LABEL, "$1$2[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(HIGH_RISK_URL, "[REDACTED_URL]");
}
