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
  /** Either a pattern to replace, or a custom pass over the whole text. */
  redactPattern?: RegExp;
  redact?: (content: string) => string;
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
    if (rule.redact) {
      redacted = rule.redact(redacted);
      continue;
    }
    if (!rule.redactPattern) continue;
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
  '(?:api[_-]?key|secret[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|credentials?|session|cookie)';
// Values that are code, types or placeholders rather than literal secrets.
// Kept free of unbounded lookaheads so matching stays linear.
const NOT_A_LITERAL =
  "(?![\\[<$=`\\\\])(?!(?:true|false|null|none|undefined|string|number|boolean|any|unknown|object|never|void)\\b)(?!process\\.env|os\\.environ)";
// A quoted value, also when the quotes are escaped inside a JSON string.
const QUOTED_VALUE = `(\\\\?["'])(?![<$[])([^"'\\n\\\\]+)\\\\?["']`;
const UNQUOTED_VALUE = `${NOT_A_LITERAL}[^\\s'",;\\\\]+`;

/** Masks the value but leaves call expressions such as `getToken()` alone. */
const maskCredentialValue = (match: string, prefix?: string, quote?: string, quoted?: string) => {
  if (quote !== undefined && quoted !== undefined) return `${prefix ?? ''}${quote}[REDACTED_SECRET]${quote}`;
  const value = match.slice((prefix ?? '').length);
  if (/[()]/u.test(value)) return match;
  return `${prefix ?? ''}[REDACTED_SECRET]`;
};

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----/gu;
const PRIVATE_KEY_END = /-----END ((?:[A-Z]+ )*)PRIVATE KEY-----/gu;
// Key lines right after a BEGIN line that has no END line: real or
// JSON-escaped newlines, PEM headers, blank lines, or 20+ character pieces when
// whitespace was collapsed. Always matches, possibly empty.
const TRUNCATED_KEY_TAIL =
  /(?:(?:\r?\n|\\(?:r\\)?n)[ \t]*(?:Proc-Type:[^\n\\]*|DEK-Info:[^\n\\]*|[A-Za-z0-9+/=]+(?=\r?\n|\\(?:r\\)?n|["']|$))?|[ \t]+[A-Za-z0-9+/=]{20,})*/uy;

/**
 * Replaces each private key block, BEGIN through its matching END, with one
 * marker. A block cut off before END loses only the key lines after BEGIN, so
 * the rest of a log stays readable. END positions are indexed once per key type,
 * so text full of BEGIN lines is still handled in linear time.
 */
function redactPrivateKeyBlocks(content: string): string {
  if (!content.includes('PRIVATE KEY-----')) return content;
  const endsByType = new Map<string, { positions: Array<[number, number]>; next: number }>();
  for (const match of content.matchAll(PRIVATE_KEY_END)) {
    const type = match[1] ?? '';
    const entry = endsByType.get(type) ?? { positions: [], next: 0 };
    entry.positions.push([match.index, match.index + match[0].length]);
    endsByType.set(type, entry);
  }
  let output = '';
  let cursor = 0;
  for (const match of content.matchAll(PRIVATE_KEY_BEGIN)) {
    if (match.index < cursor) continue;
    const headerEnd = match.index + match[0].length;
    const ends = endsByType.get(match[1] ?? '');
    while (ends && ends.next < ends.positions.length && ends.positions[ends.next]![0] < headerEnd) ends.next++;
    let stop: number;
    if (ends && ends.next < ends.positions.length) {
      stop = ends.positions[ends.next]![1];
    } else {
      TRUNCATED_KEY_TAIL.lastIndex = headerEnd;
      stop = headerEnd + (TRUNCATED_KEY_TAIL.exec(content)?.[0].length ?? 0);
    }
    output += `${content.slice(cursor, match.index)}${marker('private-key')}`;
    cursor = stop;
  }
  return output + content.slice(cursor);
}

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
    redact: redactPrivateKeyBlocks,
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
      `(?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`,
      'iu',
    ),
    redactPattern: new RegExp(
      `((?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*)(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`,
      'giu',
    ),
    replace: maskCredentialValue,
    message: 'A credential assignment is present.',
  },
  {
    id: 'credential-flag',
    severity: 'high',
    pattern: new RegExp(`(?<![A-Za-z0-9-])--[A-Za-z0-9-]*?${CREDENTIAL_KEY}\\s+(?!-)(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`, 'iu'),
    redactPattern: new RegExp(`((?<![A-Za-z0-9-])--[A-Za-z0-9-]*?${CREDENTIAL_KEY}\\s+)(?!-)(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`, 'giu'),
    replace: maskCredentialValue,
    message: 'A credential passed as a command-line flag is present.',
  },
];
