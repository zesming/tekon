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

  it('scans repository files while ignoring .tekon runtime output', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-secret-scan-'));
    tempDirs.push(repoPath);
    writeFileSync(
      join(repoPath, 'config.ts'),
      `export const token = "${fakeOpenAiKey}";\n`,
      'utf8',
    );
    writeFileSync(join(repoPath, '.tekon'), 'ignored runtime file', 'utf8');

    const findings = scanFilesForSecrets(repoPath);
    expect(findings).toEqual([
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
