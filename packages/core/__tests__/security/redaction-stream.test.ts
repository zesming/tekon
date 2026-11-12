import { describe, expect, it } from 'vitest';

import {
  createSecretRedactionTransform,
  redactSecrets,
  scanTextForSecrets,
} from '../../src/index.js';

const j = (...parts: string[]) => parts.join('');
const BEGIN = j('-----BEGIN ', 'PRIVATE KEY-----');
const END = j('-----END ', 'PRIVATE KEY-----');
const keyBody = j('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7');
const openAi = j('sk', '-', '123456789012345678901234');
const githubClassic = j('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const awsSecret = j('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY');
const jwt = j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV');
const bearer = j('abcDEF123456', 'ghiJKL789012');
const password = j('hunter2-', 'correct-horse');

/** One positive sample per rule, each inside ordinary log lines. */
const samples: Record<string, string> = {
  'private-key': `start\n${BEGIN}\n${keyBody}\n${keyBody}\n${END}\nafter`,
  'openai-api-key': `key in use: ${openAi} ok`,
  'github-token': `GH=${githubClassic}`,
  'slack-token': `slack ${j('xox', 'b-', '123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx')}`,
  'aws-access-key': `id ${j('AKIA', 'ABCDEFGHIJKLMNOP')}`,
  'aws-secret-access-key': `aws_secret_access_key = ${awsSecret}`,
  'generic-token-assignment': `api_key = "${j('123456789012', '345678901234567890')}"`,
  'slack-token-loose': `token ${j('xox', 'p-', 'abcdefghij-1234')}`,
  'auth-header': `curl -H "Authorization: Bearer ${bearer}"`,
  'authorization-value': `authorization=${bearer}x`,
  jwt: `jwt ${jwt}`,
  'url-credentials': `git clone https://user:${password}@example.com/repo`,
  'credential-assignment': `DB_PASSWORD=${password}`,
  'credential-flag': `run --api-token ${password} --verbose`,
};

/** Separator rules: the value may start on the next line. */
const crossLine: Record<string, (nl: string) => string> = {
  'aws-secret-access-key': (nl) => `aws_secret_access_key =${nl}  ${awsSecret}`,
  'auth-header': (nl) => `Authorization: Bearer${nl}  ${bearer}`,
  'credential-assignment': (nl) => `password:${nl}  ${password}`,
  'credential-flag': (nl) => `--api-token${nl}${password}`,
  'authorization-value': (nl) => `authorization:${nl}${bearer}x`,
  'generic-token-assignment': (nl) => `token =${nl}"${j('123456789012', '345678901234567890')}"`,
};

function secretsOf(text: string): string[] {
  return [keyBody, openAi, githubClassic, awsSecret, jwt, bearer, password].filter((value) =>
    text.includes(value),
  );
}

async function stream(pieces: Array<string | Buffer>): Promise<string> {
  const transform = createSecretRedactionTransform();
  const out: Buffer[] = [];
  transform.on('data', (chunk: Buffer | string) => out.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => {
    transform.once('end', resolve);
    transform.once('error', reject);
  });
  for (const piece of pieces) transform.write(piece);
  transform.end();
  await done;
  return Buffer.concat(out).toString('utf8');
}

function splitAt(bytes: Buffer, cuts: number[]): Buffer[] {
  const points = [...new Set(cuts)].filter((cut) => cut > 0 && cut < bytes.length).sort((a, b) => a - b);
  const pieces: Buffer[] = [];
  let start = 0;
  for (const point of points) {
    pieces.push(bytes.subarray(start, point));
    start = point;
  }
  pieces.push(bytes.subarray(start));
  return pieces;
}

// Deterministic so a failure can be replayed.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('streaming secret redaction', () => {
  it('writes exactly what whole-text redaction gives, wherever the chunks are cut', async () => {
    const next = random(7);
    for (const [rule, sample] of Object.entries(samples)) {
      const text = `first line\n${sample}\nlast line\n`;
      const expected = redactSecrets(text).content;
      expect(secretsOf(expected), rule).toEqual([]);
      const bytes = Buffer.from(text);
      for (let round = 0; round < 8; round++) {
        const cut = 1 + Math.floor(next() * (bytes.length - 1));
        // Shift the cut byte by byte across a few positions on both sides.
        for (let shift = -3; shift <= 3; shift++) {
          const pieces = splitAt(bytes, [cut + shift, Math.floor(next() * bytes.length)]);
          expect(await stream(pieces), `${rule} cut at ${cut + shift}`).toBe(expected);
        }
      }
      const oneByteAtATime = [...bytes].map((byte) => Buffer.from([byte]));
      expect(await stream(oneByteAtATime), rule).toBe(expected);
    }
  });

  it('masks a value on the line after its key, with \\n and \\r\\n', async () => {
    for (const [rule, build] of Object.entries(crossLine)) {
      for (const nl of ['\n', '\r\n']) {
        const text = `before${nl}${build(nl)}${nl}after${nl}`;
        const whole = redactSecrets(text).content;
        expect(secretsOf(whole), `${rule} ${JSON.stringify(nl)}`).toEqual([]);
        expect(whole).toContain(`after${nl}`);
        const bytes = Buffer.from(text);
        expect(await stream([...bytes].map((byte) => Buffer.from([byte]))), rule).toBe(whole);
      }
    }
  });

  it('masks whole private key blocks printed with line prefixes', async () => {
    const blocks = {
      'cat -n': [BEGIN, keyBody, keyBody, END].map((line, index) => `${String(index + 1).padStart(6)}\t${line}`),
      'grep -A': [`id.pem:${BEGIN}`, `id.pem-${keyBody}`, `id.pem-${keyBody}`, `id.pem-${END}`],
      timestamps: [BEGIN, keyBody, keyBody, END].map((line, index) => `2026-11-13T10:00:0${index}Z ${line}`),
    };
    for (const [name, lines] of Object.entries(blocks)) {
      const text = ['before', ...lines, 'after', ''].join('\n');
      const whole = redactSecrets(text).content;
      expect(whole, name).not.toContain(keyBody);
      expect(whole, name).not.toContain('PRIVATE KEY-----');
      expect(whole, name).toMatch(/^before\n.*\[REDACTED_PRIVATE_KEY\]\nafter\n$/u);
      expect(await stream(splitAt(Buffer.from(text), [5, 40, 90])), name).toBe(whole);
    }
  });

  it('keeps the lines after a cut-off private key, including an is_error result', async () => {
    const result = '{"type":"result","subtype":"error_during_execution","is_error":true}';
    const text = [BEGIN, keyBody, keyBody, result, ''].join('\n');
    const output = await stream([text]);
    expect(output).not.toContain(keyBody);
    expect(output).toContain(result);
    expect(output).toBe(redactSecrets(text).content);
  });

  it('still detects secrets with the same patterns as before', () => {
    expect(scanTextForSecrets(`aws_secret_access_key\n=\n${awsSecret}`).map((f) => f.ruleId)).toEqual([
      'aws-secret-access-key',
    ]);
    expect(scanTextForSecrets(`${BEGIN}\n`).map((f) => f.ruleId)).toEqual(['private-key']);
  });

  it('decodes characters split across chunks', async () => {
    const text = '进度：完成 ✓ 🚀\n';
    const bytes = Buffer.from(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await stream(splitAt(bytes, [cut]))).toBe(text);
    }
  });

  it('writes each finished line before the input ends, including \\r progress updates', async () => {
    const transform = createSecretRedactionTransform();
    const seen: string[] = [];
    transform.on('data', (chunk: Buffer | string) => seen.push(chunk.toString()));
    transform.write('first line\nhalf');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.join('')).toBe('first line\n');
    transform.write(' line\r10%\r');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.join('')).toBe('first line\nhalf line\r');
    transform.write('20%\r\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.join('')).toBe('first line\nhalf line\r10%\r20%\r\n');
    transform.end();
  });

  it('bounds memory on a very long line and stays equal to whole-text redaction', async () => {
    const word = 'abcdefghij ';
    const longLine = `${word.repeat(300_000)}${openAi} tail`;
    const transform = createSecretRedactionTransform();
    let emitted = 0;
    const out: string[] = [];
    transform.on('data', (chunk: Buffer | string) => {
      emitted += chunk.length;
      out.push(chunk.toString());
    });
    const done = new Promise((resolve) => transform.once('end', resolve));
    const bytes = Buffer.from(longLine);
    const half = Math.floor(bytes.length * 0.9);
    for (let offset = 0; offset < half; offset += 65_536) {
      transform.write(bytes.subarray(offset, Math.min(offset + 65_536, half)));
    }
    await new Promise((resolve) => setImmediate(resolve));
    // Most of the line is out before it ends; at most about 1MB waits.
    expect(emitted).toBeGreaterThan(half - 1_100_000);
    transform.end(bytes.subarray(half));
    await done;
    const output = out.join('');
    expect(output).not.toContain(openAi);
    expect(output).toBe(redactSecrets(longLine).content);
  });
});
