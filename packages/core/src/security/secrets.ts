import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
  /** What to replace; private keys are handled by the key block stage instead. */
  redactPattern?: RegExp;
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

/**
 * Masks secrets in text. Whole text and streamed output go through the same
 * line processor, so a log written chunk by chunk ends up identical to
 * redacting it in one piece.
 */
export function redactSecrets(content: string): {
  content: string;
  findings: SecretFinding[];
} {
  const processor = createRedactionProcessor();
  const redacted = processor.write(content) + processor.end();
  return { content: redacted, findings: scanTextForSecrets(content) };
}

/** Redacts a byte stream line by line, writing each line once it is complete. */
export function createSecretRedactionTransform(): Transform {
  const decoder = new StringDecoder('utf8');
  const processor = createRedactionProcessor();
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback: TransformCallback) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const output = processor.write(text);
      callback(null, output.length > 0 ? output : undefined);
    },
    flush(callback: TransformCallback) {
      const output = processor.write(decoder.end()) + processor.end();
      callback(null, output.length > 0 ? output : undefined);
    },
  });
}

/** Longest line kept whole; longer lines are cut, preferably at a space. */
export const MAX_REDACTION_LINE_LENGTH = 1_048_576;
const LINE_CUT_BACKTRACK = 4096;
/** How far after a BEGIN line its END line is looked for. */
const KEY_BLOCK_MAX_LINES = 200;
const KEY_BLOCK_MAX_CHARS = 16_384;

interface TextLine {
  content: string;
  /** '\n', '\r\n', '\r', or '' for the end of input or a cut long line. */
  term: string;
  /** First END position of each key type in this line, computed once. */
  ends?: Map<string, [number, number]>;
}

interface RedactionProcessor {
  write(text: string): string;
  end(): string;
}

function createRedactionProcessor(): RedactionProcessor {
  let output = '';
  const rules = createRuleStage((text) => {
    output += text;
  });
  const keys = createKeyBlockStage((line) => rules.push(line));
  let buffer = '';

  const emitLine = (content: string, term: string) => {
    let rest = content;
    while (rest.length > MAX_REDACTION_LINE_LENGTH) {
      const cut = lineCutPoint(rest);
      keys.push({ content: rest.slice(0, cut), term: '' });
      rest = rest.slice(cut);
    }
    keys.push({ content: rest, term });
  };

  const drain = (final: boolean) => {
    let start = 0;
    const terminator = /[\r\n]/gu;
    for (;;) {
      terminator.lastIndex = start;
      const found = terminator.exec(buffer);
      if (!found) break;
      const index = found.index;
      let term = '\n';
      if (buffer[index] === '\r') {
        // A trailing \r may still be the first half of \r\n.
        if (index + 1 === buffer.length && !final) break;
        term = buffer[index + 1] === '\n' ? '\r\n' : '\r';
      }
      emitLine(buffer.slice(start, index), term);
      start = index + term.length;
    }
    let pending = buffer.slice(start);
    if (final) {
      if (pending.length > 0) emitLine(pending, '');
      pending = '';
    } else {
      // Only a line known to be longer than the limit is cut while streaming,
      // the same cut whole text gets.
      while (pending.length > MAX_REDACTION_LINE_LENGTH && !pending.endsWith('\r')) {
        const cut = lineCutPoint(pending);
        keys.push({ content: pending.slice(0, cut), term: '' });
        pending = pending.slice(cut);
      }
    }
    buffer = pending;
  };

  const take = () => {
    const text = output;
    output = '';
    return text;
  };

  return {
    write(text) {
      if (text.length === 0) return '';
      buffer += text;
      drain(false);
      return take();
    },
    end() {
      drain(true);
      keys.end();
      rules.end();
      return take();
    },
  };
}

function lineCutPoint(content: string): number {
  const window = content.slice(MAX_REDACTION_LINE_LENGTH - LINE_CUT_BACKTRACK, MAX_REDACTION_LINE_LENGTH);
  const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
  let cut = space >= 0
    ? MAX_REDACTION_LINE_LENGTH - LINE_CUT_BACKTRACK + space + 1
    : MAX_REDACTION_LINE_LENGTH;
  // Never split a surrogate pair.
  const code = content.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut;
}

function endsOf(line: TextLine): Map<string, [number, number]> {
  if (!line.ends) {
    line.ends = new Map();
    if (line.content.includes('PRIVATE KEY-----')) {
      for (const match of line.content.matchAll(PRIVATE_KEY_END)) {
        const type = match[1] ?? '';
        if (!line.ends.has(type)) line.ends.set(type, [match.index, match.index + match[0].length]);
      }
    }
  }
  return line.ends;
}

function findEndAfter(content: string, type: string, from: number): [number, number] | undefined {
  const end = new RegExp(PRIVATE_KEY_END.source, 'gu');
  end.lastIndex = from;
  for (let match = end.exec(content); match; match = end.exec(content)) {
    if ((match[1] ?? '') === type) return [match.index, match.index + match[0].length];
  }
  return undefined;
}

/**
 * Chars of a line, after its own newline, that look like key material: PEM
 * headers, base64, blank, or JSON-escaped or space-collapsed pieces; -1 when
 * the line does not start like key material.
 */
function keyMaterialLength(content: string): number {
  TRUNCATED_KEY_TAIL.lastIndex = 0;
  const consumed = TRUNCATED_KEY_TAIL.exec(`\n${content}\n`)?.[0].length ?? 0;
  return consumed === 0 ? -1 : Math.min(consumed - 1, content.length);
}

/**
 * Replaces private key blocks. A BEGIN line waits for its END line of the same
 * type for up to KEY_BLOCK_MAX_LINES lines and KEY_BLOCK_MAX_CHARS characters;
 * found, everything from BEGIN to END becomes one marker, so prefixed lines
 * (`cat -n`, `grep -A`, timestamps) are covered. Not found, only the key
 * material right after BEGIN is dropped and the rest of the log stays.
 */
function createKeyBlockStage(emit: (line: TextLine) => void) {
  let mode: 'normal' | 'block' | 'tail' = 'normal';
  let block: { prefix: string; type: string; rest: string; term: string; held: TextLine[]; chars: number } | undefined;
  let tail: { content: string; term: string } | undefined;
  const keyMarker = marker('private-key');

  function scan(line: TextLine): void {
    const { content } = line;
    if (!content.includes('PRIVATE KEY-----')) {
      emit(line);
      return;
    }
    const begin = new RegExp(PRIVATE_KEY_BEGIN.source, 'gu');
    let out = '';
    let pos = 0;
    for (;;) {
      begin.lastIndex = pos;
      const match = begin.exec(content);
      if (!match) {
        emit({ content: out + content.slice(pos), term: line.term });
        return;
      }
      out += content.slice(pos, match.index);
      const headerEnd = match.index + match[0].length;
      const type = match[1] ?? '';
      const end = findEndAfter(content, type, headerEnd);
      if (end) {
        out += keyMarker;
        pos = end[1];
        continue;
      }
      mode = 'block';
      const rest = content.slice(headerEnd);
      block = { prefix: out, type, rest, term: line.term, held: [], chars: rest.length + line.term.length };
      return;
    }
  }

  function resolveTruncated(queue: TextLine[]): void {
    const current = block!;
    block = undefined;
    TRUNCATED_KEY_TAIL.lastIndex = 0;
    const consumed = TRUNCATED_KEY_TAIL.exec(current.rest)?.[0].length ?? 0;
    const head = current.prefix + keyMarker;
    if (consumed < current.rest.length) {
      mode = 'normal';
      queue.unshift({ content: head + current.rest.slice(consumed), term: current.term }, ...current.held);
    } else {
      mode = 'tail';
      tail = { content: head, term: current.term };
      queue.unshift(...current.held);
    }
  }

  function step(line: TextLine, queue: TextLine[]): void {
    if (mode === 'normal') {
      scan(line);
      return;
    }
    if (mode === 'block') {
      const current = block!;
      current.held.push(line);
      const end = endsOf(line).get(current.type);
      if (end && current.held.length <= KEY_BLOCK_MAX_LINES && current.chars + end[0] <= KEY_BLOCK_MAX_CHARS) {
        mode = 'normal';
        block = undefined;
        queue.unshift({ content: current.prefix + keyMarker + line.content.slice(end[1]), term: line.term });
        return;
      }
      current.chars += line.content.length + line.term.length;
      if (current.held.length >= KEY_BLOCK_MAX_LINES || current.chars > KEY_BLOCK_MAX_CHARS) {
        resolveTruncated(queue);
      }
      return;
    }
    const pending = tail!;
    const length = keyMaterialLength(line.content);
    if (length === line.content.length) {
      // The whole line is key material: drop it with the newline before it.
      pending.term = line.term;
      return;
    }
    mode = 'normal';
    tail = undefined;
    if (length > 0) {
      queue.unshift({ content: pending.content + line.content.slice(length), term: line.term });
    } else {
      emit({ content: pending.content, term: pending.term });
      queue.unshift(line);
    }
  }

  function run(queue: TextLine[]): void {
    while (queue.length > 0) step(queue.shift()!, queue);
  }

  return {
    push(line: TextLine) {
      run([line]);
    },
    end() {
      for (;;) {
        if (mode === 'block') {
          const queue: TextLine[] = [];
          resolveTruncated(queue);
          run(queue);
          continue;
        }
        if (mode === 'tail') {
          emit({ content: tail!.content, term: tail!.term });
          tail = undefined;
          mode = 'normal';
        }
        return;
      }
    },
  };
}

/**
 * Applies the token and assignment rules. A line ending in a key whose value
 * may start on the next line waits for that line, so a value at most one
 * newline after its key is masked.
 */
function createRuleStage(emit: (text: string) => void) {
  let segment = '';
  const flush = () => {
    if (segment.length === 0) return;
    emit(applyRedactionRules(segment));
    segment = '';
  };
  return {
    push(line: TextLine) {
      segment += line.content + line.term;
      if (
        (line.term === '\n' || line.term === '\r\n') &&
        segment.length <= MAX_REDACTION_LINE_LENGTH &&
        DANGLING_KEY_PATTERNS.some((pattern) => pattern.test(line.content))
      ) {
        return;
      }
      flush();
    },
    end: flush,
  };
}

function applyRedactionRules(text: string): string {
  let redacted = text;
  for (const rule of [...BLOCKING_RULES, ...REDACTION_ONLY_RULES]) {
    if (!rule.redactPattern) continue;
    redacted = redacted.replace(rule.redactPattern, (match: string, ...rest: unknown[]) => {
      if (!rule.replace) return marker(rule.id);
      // String.replace passes the capture groups first, then the numeric offset.
      const groups = rest.slice(0, rest.findIndex((value) => typeof value === 'number'));
      return rule.replace(match, ...(groups as Array<string | undefined>));
    });
  }
  return redacted;
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
// Values that are code, types or placeholders rather than literal secrets: a
// type or keyword only counts when a terminator follows it, so a password such
// as `any-secret` is still masked. Kept free of unbounded lookaheads.
const NOT_A_LITERAL = String.raw`(?![\[<$=` + '`' + String.raw`\\])(?!(?:true|false|null|none|undefined|string|number|boolean|any|unknown|object|never|void|await|new|typeof)(?=[\s'",;)|}\]>]|$))(?!process\.env|os\.environ)`;
// Quoted values close with the same quote and may contain escapes; the third
// form is a value quoted with escaped quotes inside a JSON string; the last two
// take a trailing backslash literally (YAML/shell single quotes, PowerShell).
const QUOTED_VALUE = String.raw`(")(?![<$[])((?:[^"\\\n]|\\.)+)"|(')(?![<$[])((?:[^'\\\n]|\\.)+)'|(\\")(?![<$[])((?:[^"\\\n]|\\[^"\n])+)\\"|(")(?![<$[])([^"\n]+)"|(')(?![<$[])([^'\n]+)'`;
// Unquoted values may contain backslashes but stop at \n, \r, \t or an escaped quote.
const UNQUOTED_VALUE = String.raw`${NOT_A_LITERAL}(?:[^\s'",;\\]|\\\\|\\(?![nrt"'\\]))+`;

/** Masks the value but leaves call expressions such as `getToken()` alone. */
const maskCredentialValue = (match: string, prefix = '', ...quoted: Array<string | undefined>) => {
  const quote = quoted.find((value, index) => index % 2 === 0 && value !== undefined);
  if (quote !== undefined) return `${prefix}${quote}[REDACTED_SECRET]${quote}`;
  if (/[()]/u.test(match.slice(prefix.length))) return match;
  return `${prefix}[REDACTED_SECRET]`;
};

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY-----/gu;
const PRIVATE_KEY_END = /-----END ((?:[A-Z]+ )*)PRIVATE KEY-----/gu;
// Key lines right after a BEGIN line that has no END line: real or
// JSON-escaped newlines, PEM headers, blank lines, or 20+ character pieces when
// whitespace was collapsed. Always matches, possibly empty.
const TRUNCATED_KEY_TAIL =
  /(?:(?:\r?\n|\\(?:r\\)?n)[ \t]*(?:Proc-Type:[^\n\\]*|DEK-Info:[^\n\\]*|[A-Za-z0-9+/=]+[ \t]*(?=\r?\n|\\(?:r\\)?n|["']|$)|(?=\r?\n|\\(?:r\\)?n))|[ \t]+[A-Za-z0-9+/=]{20,})*/uy;

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

// Between a key and its value: spaces, and at most one newline.
const OPTIONAL_SEPARATOR = String.raw`[ \t]*(?:\r?\n[ \t]*)?`;
const REQUIRED_SEPARATOR = String.raw`(?:[ \t]+(?:\r?\n[ \t]*)?|\r?\n[ \t]*)`;

interface KeyedPattern {
  /** Everything up to the separator, including `:` or `=`. */
  key: string;
  separator: 'optional' | 'required';
  /** Kept with the key, e.g. an opening quote. */
  prefixTail?: string;
  value: string;
}

const KEYED_PATTERNS: KeyedPattern[] = [];

/** Builds a redact pattern whose group 1 is the kept prefix. */
function keyed(pattern: KeyedPattern): { redactPattern: RegExp } {
  KEYED_PATTERNS.push(pattern);
  const separator = pattern.separator === 'optional' ? OPTIONAL_SEPARATOR : REQUIRED_SEPARATOR;
  return {
    redactPattern: new RegExp(`(${pattern.key}${separator}${pattern.prefixTail ?? ''})${pattern.value}`, 'giu'),
  };
}

const BLOCKING_RULES: SecretRule[] = [
  {
    id: 'private-key',
    severity: 'critical',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u,
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
    ...keyed({
      key: String.raw`\baws_secret_access_key[ \t]*[:=]`,
      separator: 'optional',
      prefixTail: `['"]?`,
      value: String.raw`[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])`,
    }),
    replace: keepPrefix,
    message: 'AWS secret access key is present.',
  },
  {
    id: 'generic-token-assignment',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/iu,
    ...keyed({
      key: String.raw`\b(?:api[_-]?key|token|secret)[ \t]*[:=]`,
      separator: 'optional',
      prefixTail: `['"]`,
      value: String.raw`[A-Za-z0-9_\-]{24,}(['"])`,
    }),
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
    ...keyed({
      key: String.raw`(?<![A-Za-z])(?:Bearer|Basic|Token|ApiKey|Digest)`,
      separator: 'required',
      value: String.raw`[A-Za-z0-9._~+/=-]{16,}`,
    }),
    replace: keepPrefix,
    message: 'An authorization header value is present.',
  },
  {
    id: 'authorization-value',
    severity: 'high',
    pattern: /(?<![A-Za-z0-9_-])authorization["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token|ApiKey|Digest)\s+)?(?![[<$])(?!(?:Bearer|Basic|Token|ApiKey|Digest)\b)[^\s'",;]+/iu,
    ...keyed({
      key: String.raw`(?<![A-Za-z0-9_-])authorization["']?[ \t]*[:=]`,
      separator: 'optional',
      prefixTail: String.raw`(?:(?:Bearer|Basic|Token|ApiKey|Digest)[ \t]+)?`,
      value: String.raw`(?![[<$])(?!(?:Bearer|Basic|Token|ApiKey|Digest)\b)[^\s'",;]+`,
    }),
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
      `(?<![A-Za-z0-9_-])(?:\\\\?["'])?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}(?:\\\\?["'])?\\s*[:=]\\s*(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`,
      'iu',
    ),
    ...keyed({
      key: String.raw`(?<![A-Za-z0-9_-])(?:\\?["'])?[A-Za-z0-9_-]*?${CREDENTIAL_KEY}(?:\\?["'])?[ \t]*[:=]`,
      separator: 'optional',
      value: `(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`,
    }),
    replace: maskCredentialValue,
    message: 'A credential assignment is present.',
  },
  {
    id: 'credential-flag',
    severity: 'high',
    pattern: new RegExp(`(?<![A-Za-z0-9-])--[A-Za-z0-9-]*?${CREDENTIAL_KEY}\\s+(?!-)(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`, 'iu'),
    ...keyed({
      key: String.raw`(?<![A-Za-z0-9-])--[A-Za-z0-9-]*?${CREDENTIAL_KEY}`,
      separator: 'required',
      value: `(?!-)(?:${QUOTED_VALUE}|${UNQUOTED_VALUE})`,
    }),
    replace: maskCredentialValue,
    message: 'A credential passed as a command-line flag is present.',
  },
];

/** Lines that end in a key whose value may still come on the next line. */
const DANGLING_KEY_PATTERNS = KEYED_PATTERNS.map(
  (pattern) => new RegExp(`${pattern.key}[ \\t]*$`, 'iu'),
);
