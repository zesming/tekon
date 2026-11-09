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
  replace?: (match: string, ...groups: string[]) => string;
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
    redacted = redacted.replace(rule.redactPattern, (match: string, ...rest: unknown[]) =>
      rule.replace
        ? rule.replace(match, ...rest.filter((value): value is string => typeof value === 'string'))
        : marker(rule.id),
    );
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

const keepPrefix = (_match: string, prefix: string) => `${prefix}[REDACTED_SECRET]`;

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
    // The whole block; a block cut off before its END line is masked to the end.
    redactPattern: /-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/gu,
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
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u,
    redactPattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gu,
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
    pattern: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/iu,
    redactPattern: /(\baws_secret_access_key\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}\b/giu,
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

const REDACTION_ONLY_RULES: SecretRule[] = [
  {
    id: 'auth-header',
    severity: 'high',
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/u,
    redactPattern: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{16,}/gu,
    replace: keepPrefix,
    message: 'An authorization header value is present.',
  },
  {
    id: 'jwt',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
    redactPattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
    message: 'A JSON web token is present.',
  },
  {
    id: 'url-credentials',
    severity: 'high',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/iu,
    redactPattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu,
    replace: (_match, prefix) => `${prefix}[REDACTED_SECRET]@`,
    message: 'Credentials embedded in a URL are present.',
  },
  {
    id: 'unquoted-secret-assignment',
    severity: 'high',
    // Values must be 8+ characters, unquoted and not already a [REDACTED…] marker.
    pattern: /\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*(?![['"<])[^\s'",;]{8,}/iu,
    redactPattern: /(\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)(?![['"<])[^\s'",;]{8,}/giu,
    replace: keepPrefix,
    message: 'A likely unquoted secret assignment is present.',
  },
];
