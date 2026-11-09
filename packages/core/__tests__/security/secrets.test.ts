import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  redactSecrets,
  scanFilesForSecrets,
  scanTextForSecrets,
} from '../../src/index.js';

describe('secret scanning and redaction', () => {
  const tempDirs: string[] = [];
  const fakeOpenAiKey = ['sk', '123456789012345678901234'].join('-');
  const fakeGenericSecret = ['123456789012', '345678901234567890'].join('');

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('detects and redacts likely secrets in text', () => {
    const content = [
      `api_key = "${fakeGenericSecret}"`,
      `OPENAI=${fakeOpenAiKey}`,
    ].join('\n');

    expect(
      scanTextForSecrets(content).map((finding) => finding.ruleId),
    ).toEqual(['openai-api-key', 'generic-token-assignment']);
    const redacted = redactSecrets(content).content;
    expect(redacted).not.toContain(fakeOpenAiKey);
    expect(redacted).not.toContain(fakeGenericSecret);
    expect(redacted).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  const j = (...parts: string[]) => parts.join('');
  const keyBody = j('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7');
  const privateKey = [
    j('-----BEGIN ', 'PRIVATE KEY-----'),
    keyBody,
    j('-----END ', 'PRIVATE KEY-----'),
  ].join('\n');
  const githubClassic = j('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const githubFineGrained = j('github', '_pat_', '11ABCDEFG0123456789abc', '_', 'x'.repeat(59));
  const slackToken = j('xox', 'b-', '123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx');
  const awsSecret = j('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY');
  const bearerValue = j('abcDEF123456', 'ghiJKL789012');
  const jwt = j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV');

  it('redacts the whole private key block, including a truncated one', () => {
    const redacted = redactSecrets(`before\n${privateKey}\nafter`).content;
    expect(redacted).not.toContain(keyBody);
    expect(redacted).not.toContain('PRIVATE KEY-----');
    expect(redacted).toContain('before');
    expect(redacted).toContain('after');
    expect(scanTextForSecrets(privateKey).map((finding) => finding.ruleId)).toEqual(['private-key']);

    const truncated = privateKey.split('\n').slice(0, 2).join('\n');
    expect(redactSecrets(truncated).content).not.toContain(keyBody);
  });

  it('blocks and redacts high-precision token shapes', () => {
    const content = [
      `classic ${githubClassic}`,
      `fine ${githubFineGrained}`,
      `slack ${slackToken}`,
      `aws_secret_access_key = ${awsSecret}`,
    ].join('\n');
    expect(scanTextForSecrets(content).map((finding) => finding.ruleId).sort()).toEqual([
      'aws-secret-access-key',
      'github-token',
      'slack-token',
    ]);
    const redacted = redactSecrets(content).content;
    for (const value of [githubClassic, githubFineGrained, slackToken, awsSecret]) {
      expect(redacted).not.toContain(value);
    }
    expect(redacted).toContain('aws_secret_access_key = ');
  });

  it('redacts lower-precision credentials without blocking artifacts that contain them', () => {
    const content = [
      `Authorization: Bearer ${bearerValue}`,
      `API_KEY=${fakeGenericSecret}`,
      `password: ${j('hunter2', 'hunter2')}`,
      `DATABASE_URL=postgres://app:${j('s3cr3t', 'pass')}@localhost:5432/app`,
      `jwt ${jwt}`,
    ].join('\n');
    expect(scanTextForSecrets(content)).toEqual([]);
    const redacted = redactSecrets(content).content;
    for (const value of [bearerValue, fakeGenericSecret, j('hunter2', 'hunter2'), j('s3cr3t', 'pass'), jwt]) {
      expect(redacted).not.toContain(value);
    }
    expect(redacted).toContain('Authorization: Bearer ');
    expect(redacted).toContain('postgres://app:');
    expect(redacted).toContain('@localhost:5432/app');
  });

  it('keeps placeholders, short values and already-redacted values readable', () => {
    const content = [
      'Authorization: Bearer <token>',
      'token=[REDACTED]',
      'max_tokens: 4096',
      'sort_key = name',
    ].join('\n');
    expect(redactSecrets(content).content).toBe(content);
    expect(scanTextForSecrets(content)).toEqual([]);
  });

  it('does not block common Slack placeholders but still masks them in logs', () => {
    for (const placeholder of [j('xox', 'b-your-bot-token'), j('xox', 'b-your-token'), j('xox', 'b-xxxxxxxxxx-xxxx')]) {
      expect(scanTextForSecrets(`SLACK_BOT_TOKEN=${placeholder}`)).toEqual([]);
    }
    expect(scanTextForSecrets(j('xox', 'p-', '123456789012-123456789012-123456789012-', 'a'.repeat(32))).map((f) => f.ruleId)).toEqual(['slack-token']);
  });

  it('catches AWS secrets that end in / or +', () => {
    const slashEnd = j('a'.repeat(39), '/');
    for (const content of [`aws_secret_access_key = ${slashEnd}\n`, `aws_secret_access_key = "${slashEnd}"`, `aws_secret_access_key=${j('b'.repeat(39), '+')}`]) {
      expect(scanTextForSecrets(content).map((f) => f.ruleId)).toEqual(['aws-secret-access-key']);
      expect(redactSecrets(content).content).not.toMatch(/[ab]{39}/u);
    }
    expect(scanTextForSecrets(`aws_secret_access_key = ${'c'.repeat(41)}`)).toEqual([]);
  });

  it('redacts keyed credentials of any length in core', () => {
    const cases: Array<[string, string]> = [
      ['password = "hunter2hunter2"', 'hunter2hunter2'],
      ['DB_PASSWORD="correct-horse-battery"', 'correct-horse-battery'],
      ['API_KEY="abcdef1234567890"', 'abcdef1234567890'],
      ['{"password": "pa55word-json"}', 'pa55word-json'],
      ['run --password hunter2cli now', 'hunter2cli'],
      ['run --api-key=keyvalue99 now', 'keyvalue99'],
      ['authorization: bearer lowercasevalue1', 'lowercasevalue1'],
      ['Authorization: token ghostvalue42', 'ghostvalue42'],
      ['Cookie: session=cookievalue77', 'cookievalue77'],
      ['pwd=shortpw', 'shortpw'],
    ];
    for (const [content, secret] of cases) {
      const redacted = redactSecrets(content).content;
      expect(redacted, content).not.toContain(secret);
      expect(scanTextForSecrets(content), content).toEqual([]);
    }
  });

  it('leaves code expressions readable', () => {
    const content = [
      'const token = getToken();',
      'api_key = os.environ["API_KEY"]',
      'secret: process.env.SECRET',
      'token: ${{ secrets.GH_TOKEN }}',
    ].join('\n');
    expect(redactSecrets(content).content).toBe(content);
  });

  it('only masks key material after a BEGIN line that has no END line', () => {
    const log = [
      j('rejects keys that do not start with "-----BEGIN RSA ', 'PRIVATE KEY-----"'),
      'AssertionError: expected false to be true',
      'Tests  1 failed | 20 passed',
    ].join('\n');
    expect(redactSecrets(log).content).toContain('Tests  1 failed | 20 passed');
    expect(redactSecrets(log).content).toContain('AssertionError');
    const truncated = [j('-----BEGIN ', 'PRIVATE KEY-----'), keyBody, keyBody, '', 'next log line'].join('\n');
    const redacted = redactSecrets(truncated).content;
    expect(redacted).not.toContain(keyBody);
    expect(redacted).toContain('next log line');
  });

  it('keeps redaction linear on adversarial input', () => {
    for (const input of ['a.'.repeat(64_000), 'eyJ-'.repeat(32_000), 'a'.repeat(128_000), 'password'.repeat(16_000)]) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started, input.slice(0, 8)).toBeLessThan(500);
    }
  });

  it('scans repository files while ignoring .tekon runtime output', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-secret-scan-'));
    tempDirs.push(repoPath);
    writeFileSync(
      join(repoPath, 'config.ts'),
      `export const token = "${fakeOpenAiKey}";\n`,
      'utf8',
    );
    writeFileSync(join(repoPath, '.tekon'), 'ignored runtime file', 'utf8');

    writeFileSync(join(repoPath, 'ci.env'), `GH=${githubClassic}\n`, 'utf8');

    const findings = scanFilesForSecrets(repoPath);
    expect(findings).toEqual([
      expect.objectContaining({
        path: 'ci.env',
        ruleId: 'github-token',
      }),
      expect.objectContaining({
        path: 'config.ts',
        ruleId: 'openai-api-key',
      }),
      expect.objectContaining({
        path: 'config.ts',
        ruleId: 'generic-token-assignment',
      }),
    ]);
  });
});
