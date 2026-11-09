import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';

export interface SecretFinding {
  severity: 'high' | 'critical';
  path?: string;
  ruleId: string;
  message: string;
}

interface SecretRule {
  id: string;
  severity: 'high' | 'critical';
  pattern: RegExp;
  redactPattern: RegExp;
  message: string;
  /** Replacement for one match; defaults to a `[REDACTED_<ID>]` marker. */
  replace?: (match: string, ...groups: Array<string | undefined>) => string;
}

/**
 * Two tiers: BLOCKING_RULES are high precision and make artifact writes and the
 * security-scan gate fail; REDACTION_ONLY_RULES are broader, so they only mask
 * values in logs and events and never block a write on a false positive.
 */

export function scanTextForSecrets(
  content: string,
  path?: string,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of BLOCKING_RULES) {
    if (rule.pattern.test(content)) {
      findings.push({
        severity: rule.severity,
        path,
        ruleId: rule.id,
        message: rule.message,
      });
    }
  }
  return findings;
}

export function redactSecrets(content: string): {
  content: string;
  findings: SecretFinding[];
} {
  let redacted = content;
  const findings = scanTextForSecrets(content);
  for (const rule of [...BLOCKING_RULES, ...REDACTION_ONLY_RULES]) {
    redacted = redacted.replace(rule.redactPattern, (match: string, ...rest: unknown[]) => {
      if (!rule.replace) return marker(rule.id);
      // String.replace passes the capture groups first, then the numeric offset.
      const groups = rest.slice(0, rest.findIndex((value) => typeof value === 'number'));
      return rule.replace(match, ...(groups as Array<string | undefined>));
    });
  }
  return { content: redacted, findings };
}

export function createSecretRedactionTransform(): Transform {
  const chunks: string[] = [];
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback: TransformCallback) {
      chunks.push(chunk.toString());
      callback();
    },
    flush(callback: TransformCallback) {
      callback(null, redactSecrets(chunks.join('')).content);
    },
  });
}

export function scanFilesForSecrets(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const filePath of listScannableFiles(root)) {
    const relativePath = relative(root, filePath);
    const content = readFileSync(filePath, 'utf8');
    findings.push(...scanTextForSecrets(content, relativePath));
  }
  return findings;
}

function marker(ruleId: string): string {
  return `[REDACTED_${ruleId.toUpperCase().replace(/-/g, '_')}]`;
}

const keepPrefix = (_match: string, prefix?: string) => `${prefix ?? ''}[REDACTED_SECRET]`;

// Key names whose values are credentials, matched case-insensitively.
const CREDENTIAL_KEY =
  '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|credentials?|private[_-]?key|cookie)';
// Values that are code or placeholders rather than literal secrets.
const NOT_A_LITERAL =
  "(?![\\[<$])(?!(?:true|false|null|none|undefined)\\b)(?!process\\.env|os\\.environ)(?![^\\s'\",;]*[()])";

const MAX_SCAN_DEPTH = 10;
const MAX_SCAN_FILES = 10_000;

function listScannableFiles(
  root: string,
  depth = 0,
  state: { count: number } = { count: 0 },
): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (depth > MAX_SCAN_DEPTH) {
    return [];
  }
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }
    if (state.count >= MAX_SCAN_FILES) {
      break;
    }
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...listScannableFiles(path, depth + 1, state));
    } else if (stat.isFile() && stat.size <= 512_000) {
      files.push(path);
      state.count++;
    }
  }
  return files;
}

const IGNORED_DIRS = new Set([
  '.git',
  '.tekon',
  'node_modules',
  'dist',
  'coverage',
]);

const BLOCKING_RULES: SecretRule[] = [
  {
    id: 'private-key',
    severity: 'critical',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u,
    // The whole block. Without an END line only the key lines right after
    // BEGIN are masked, so the rest of a log stays readable.
    redactPattern:
      /-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----(?:[\s\S]*?-----END \1PRIVATE KEY-----|(?:\r?\n[ \t]*(?:[A-Za-z0-9+/=]+|Proc-Type:[^\n]*|DEK-Info:[^\n]*))*)/gu,
    message: 'Private key material is present.',
  },
  {
    id: 'openai-api-key',
    severity: 'critical',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    redactPattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
    message: 'OpenAI-style API key is present.',
  },
  {
    id: 'github-token',
    severity: 'critical',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/u,
    redactPattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/gu,
    message: 'GitHub token is present.',
  },
  {
    id: 'slack-token',
    severity: 'critical',
    pattern: /\bxox[baprs]-\d{6,}-\d{6,}(?:-\d{6,})?-[A-Za-z0-9]{20,}\b/u,
    redactPattern: /\bxox[baprs]-\d{6,}-\d{6,}(?:-\d{6,})?-[A-Za-z0-9]{20,}\b/gu,
    message: 'Slack token is present.',
  },
  {
    id: 'aws-access-key',
    severity: 'critical',
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
    redactPattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    message: 'AWS access key is present.',
  },
  {
    id: 'aws-secret-access-key',
    severity: 'critical',
    pattern: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/iu,
    redactPattern: /(\baws_secret_access_key\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/giu,
    replace: keepPrefix,
    message: 'AWS secret access key is present.',
  },
  {
    id: 'generic-token-assignment',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/iu,
    redactPattern:
      /(\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"])[A-Za-z0-9_\-]{24,}(['"])/giu,
    replace: (_match, prefix, quote) => `${prefix}[REDACTED_SECRET]${quote}`,
    message: 'A likely token or secret assignment is present.',
  },
];

// Every pattern below starts with a lookbehind on its own leading character
// class, so each run of characters has one starting point and matching stays
// linear on adversarial input.
const REDACTION_ONLY_RULES: SecretRule[] = [
  {
    id: 'slack-token',
    severity: 'high',
    pattern: /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,}/u,
    redactPattern: /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,}/gu,
    message: 'A Slack-style token is present.',
  },
  {
    id: 'auth-header',
    severity: 'high',
    pattern: /(?<![A-Za-z])(?:Bearer|Basic|Token|ApiKey|Digest)\s+[A-Za-z0-9._~+/=-]{16,}/iu,
    redactPattern: /((?<![A-Za-z])(?:Bearer|Basic|Token|ApiKey|Digest)\s+)[A-Za-z0-9._~+/=-]{16,}/giu,
    replace: keepPrefix,
    message: 'An authorization header value is present.',
  },
  {
    id: 'authorization-value',
    severity: 'high',
    pattern: /(?<![A-Za-z0-9_-])authorization["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token|ApiKey|Digest)\s+)?(?![[<$])(?!(?:Bearer|Basic|Token|ApiKey|Digest)\b)[^\s'",;]+/iu,
    redactPattern: /((?<![A-Za-z0-9_-])authorization["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token|ApiKey|Digest)\s+)?)(?![[<$])(?!(?:Bearer|Basic|Token|ApiKey|Digest)\b)[^\s'",;]+/giu,
    replace: keepPrefix,
    message: 'An authorization value is present.',
  },
  {
    id: 'jwt',
    severity: 'high',
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
    redactPattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
    message: 'A JSON web token is present.',
  },
  {
    id: 'url-credentials',
    severity: 'high',
    pattern: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/iu,
    redactPattern: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu,
    replace: (_match, prefix) => `${prefix ?? ''}[REDACTED_SECRET]@`,
    message: 'Credentials embedded in a URL are present.',
  },
  {
    id: 'credential-assignment',
    severity: 'high',
    // KEY=value, KEY: "value", "key": "value" and --key=value, of any length.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*(?:"(?![<$[])[^"\\n]+"|'(?![<$[])[^'\\n]+'|${NOT_A_LITERAL}[^\\s'",;]+)`,
      'iu',
    ),
    redactPattern: new RegExp(
      `((?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*)(?:"(?![<$[])([^"\\n]+)"|'(?![<$[])([^'\\n]+)'|${NOT_A_LITERAL}[^\\s'",;]+)`,
      'giu',
    ),
    replace: (_match, prefix, doubleQuoted, singleQuoted) => {
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
      return `${prefix ?? ''}${quote}[REDACTED_SECRET]${quote}`;
    },
    message: 'A credential assignment is present.',
  },
  {
    id: 'credential-flag',
    severity: 'high',
    pattern: new RegExp(`(?<!-)--[A-Za-z0-9-]*?${CREDENTIAL_KEY}\\s+(?!-)${NOT_A_LITERAL}[^\\s'",;]+`, 'iu'),
    redactPattern: new RegExp(`((?<!-)--[A-Za-z0-9-]*?${CREDENTIAL_KEY}\\s+)(?!-)${NOT_A_LITERAL}[^\\s'",;]+`, 'giu'),
    replace: keepPrefix,
    message: 'A credential passed as a command-line flag is present.',
  },
];
