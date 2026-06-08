import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
}

export function scanTextForSecrets(
  content: string,
  path?: string,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
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
  for (const rule of SECRET_RULES) {
    redacted = redacted.replace(rule.redactPattern, (match) =>
      redactMatch(rule.id, match),
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

function redactMatch(ruleId: string, match: string): string {
  if (ruleId === 'generic-token-assignment') {
    return match.replace(/(['"])[^'"]+(['"])$/u, '$1[REDACTED_SECRET]$2');
  }
  return `[REDACTED_${ruleId.toUpperCase().replace(/-/g, '_')}]`;
}

function listScannableFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listScannableFiles(path));
    } else if (stat.isFile() && stat.size <= 512_000) {
      files.push(path);
    }
  }
  return files;
}

const IGNORED_DIRS = new Set([
  '.git',
  '.donkey',
  'node_modules',
  'dist',
  'coverage',
]);

const SECRET_RULES: SecretRule[] = [
  {
    id: 'private-key',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    redactPattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
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
    id: 'aws-access-key',
    severity: 'critical',
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
    redactPattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    message: 'AWS access key is present.',
  },
  {
    id: 'generic-token-assignment',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/iu,
    redactPattern:
      /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/giu,
    message: 'A likely token or secret assignment is present.',
  },
];
