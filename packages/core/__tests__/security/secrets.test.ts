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
