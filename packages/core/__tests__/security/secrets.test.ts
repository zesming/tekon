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

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('detects and redacts likely secrets in text', () => {
    const content = [
      'api_key = "123456789012345678901234567890"',
      'OPENAI=sk-123456789012345678901234',
    ].join('\n');

    expect(
      scanTextForSecrets(content).map((finding) => finding.ruleId),
    ).toEqual(['openai-api-key', 'generic-token-assignment']);
    const redacted = redactSecrets(content).content;
    expect(redacted).not.toContain('sk-123456789012345678901234');
    expect(redacted).not.toContain('123456789012345678901234567890');
    expect(redacted).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  it('scans repository files while ignoring .donkey runtime output', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-secret-scan-'));
    tempDirs.push(repoPath);
    writeFileSync(
      join(repoPath, 'config.ts'),
      'export const token = "sk-123456789012345678901234";\n',
      'utf8',
    );
    writeFileSync(join(repoPath, '.donkey'), 'ignored runtime file', 'utf8');

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
