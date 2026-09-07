import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyAuditAttempt,
  runProductionAudit,
} from '../../../../scripts/ci/audit-production.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const VALID_ZERO_VULN_JSON = JSON.stringify({
  actions: [],
  advisories: {},
  muted: [],
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
    dependencies: 50,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 50,
  },
});

const VALID_WITH_ADVISORY_JSON = JSON.stringify({
  actions: [],
  advisories: {
    '1092': {
      id: 1092,
      title: 'Example vulnerability',
      severity: 'high',
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
    totalDependencies: 50,
  },
});

const VALID_WITH_COUNT_ONLY_JSON = JSON.stringify({
  advisories: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
    },
  },
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Production dependency audit classifier (scripts/ci/audit-production.mjs)', () => {
  it('classifies exit 0 + zero vulnerabilities as success', () => {
    const result = classifyAuditAttempt({
      exitCode: 0,
      stdout: VALID_ZERO_VULN_JSON,
      stderr: '',
    });
    expect(result.status).toBe('success');
  });

  it('classifies valid JSON with advisories as vulnerability and fails immediately', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: VALID_WITH_ADVISORY_JSON,
      stderr: '',
    });
    expect(result.status).toBe('vulnerability');
  });

  it('classifies a non-zero vulnerability count without advisory entries as vulnerability', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: VALID_WITH_COUNT_ONLY_JSON,
      stderr: '',
    });
    expect(result.status).toBe('vulnerability');
  });

  it('classifies exit 0 with malformed JSON as fatal_failure (fail-closed)', () => {
    const result = classifyAuditAttempt({
      exitCode: 0,
      stdout: 'not-valid-json',
      stderr: '',
    });
    expect(result.status).toBe('fatal_failure');
    expect(result.reason).toContain('invalid');
  });

  it('classifies exit 0 with empty stdout as fatal_failure (fail-closed)', () => {
    const result = classifyAuditAttempt({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    expect(result.status).toBe('fatal_failure');
  });

  it.each([
    ['top-level array', '[]', 'malformed_structure'],
    ['empty object', '{}', 'missing_or_invalid_advisories'],
    [
      'advisories array',
      JSON.stringify({ advisories: [], metadata: { vulnerabilities: {} } }),
      'missing_or_invalid_advisories',
    ],
    ['missing metadata', JSON.stringify({ advisories: {} }), 'missing_metadata'],
    [
      'missing vulnerabilities',
      JSON.stringify({ advisories: {}, metadata: {} }),
      'missing_vulnerabilities',
    ],
    [
      'negative vulnerability count',
      JSON.stringify({
        advisories: {},
        metadata: {
          vulnerabilities: {
            info: -1,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
          },
        },
      }),
      'invalid_vulnerability_count_info',
    ],
    [
      'string vulnerability count',
      JSON.stringify({
        advisories: {},
        metadata: {
          vulnerabilities: {
            info: '0',
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
          },
        },
      }),
      'invalid_vulnerability_count_info',
    ],
  ])(
    'fails closed without retry for syntactically valid but unknown audit JSON: %s',
    (_label, stdout, validationError) => {
      const result = classifyAuditAttempt({ exitCode: 0, stdout, stderr: '' });
      expect(result).toMatchObject({
        status: 'fatal_failure',
        retryable: false,
      });
      expect(result.reason).toContain(validationError);
    },
  );

  it('classifies exit 0 with an Advisory as vulnerability (fail-closed, no retry)', () => {
    const result = classifyAuditAttempt({
      exitCode: 0,
      stdout: VALID_WITH_ADVISORY_JSON,
      stderr: '',
    });
    expect(result.status).toBe('vulnerability');
  });

  it('classifies advisory output that also contains timeout text as vulnerability (does not downgrade to transient)', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: VALID_WITH_ADVISORY_JSON,
      stderr: 'npm ERR! fetch timed out while checking secondary registry',
    });
    expect(result.status).toBe('vulnerability');
  });

  it('treats valid zero-vulnerability JSON with a non-zero exit as fatal even when stderr says timeout', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: VALID_ZERO_VULN_JSON,
      stderr: 'ERR_SOCKET_TIMEOUT after the audit result was produced',
    });
    expect(result.status).toBe('fatal_failure');
  });

  it('does not treat a generic FetchError such as a certificate failure as transient', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'FetchError: unable to verify the first certificate',
    });
    expect(result.status).toBe('fatal_failure');
  });

  it('classifies network timeout without audit results as transient_failure', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'ERR_SOCKET_TIMEOUT: request to registry.npmjs.org timed out',
    });
    expect(result.status).toBe('transient_failure');
  });

  it('classifies HTTP 5xx registry failure without audit results as transient_failure', () => {
    const result = classifyAuditAttempt({
      exitCode: 1,
      stdout: '',
      stderr:
        'pnpm: 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits',
    });
    expect(result.status).toBe('transient_failure');
  });

  it('classifies unknown error as fatal_failure without retry', () => {
    const result = classifyAuditAttempt({
      exitCode: 127,
      stdout: '',
      stderr: 'sh: line 1: pnpm: command not found',
    });
    expect(result.status).toBe('fatal_failure');
  });
});

describe('Production dependency audit runner (runProductionAudit)', () => {
  it('succeeds on first attempt when zero vulnerabilities found', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: VALID_ZERO_VULN_JSON,
      stderr: '',
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await runProductionAudit({
      runCommand,
      sleepFn,
      sleepMs: 0,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('fails immediately without retry when advisories are detected', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: VALID_WITH_ADVISORY_JSON,
      stderr: '',
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await runProductionAudit({
      runCommand,
      sleepFn,
      sleepMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries once on transient timeout and succeeds when second attempt succeeds', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'ERR_SOCKET_TIMEOUT: timed out',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: VALID_ZERO_VULN_JSON,
        stderr: '',
      });
    const sleepFn = vi.fn(async () => {});

    const result = await runProductionAudit({
      runCommand,
      sleepFn,
      sleepMs: 15_000,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(15_000);
  });

  it('retries once on transient 5xx and fails when second attempt also fails', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: '503 Service Unavailable',
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: '503 Service Unavailable',
      });
    const sleepFn = vi.fn(async () => {});

    const result = await runProductionAudit({
      runCommand,
      sleepFn,
      sleepMs: 10,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('retries once on a transient 5xx and succeeds on a valid second result', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 502 Bad Gateway',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: VALID_ZERO_VULN_JSON,
        stderr: '',
      });
    const warnings: string[] = [];
    const result = await runProductionAudit({
      runCommand,
      sleepFn: vi.fn(async () => {}),
      sleepMs: 0,
      log: vi.fn(),
      logWarning: (message: string) => warnings.push(message),
      logError: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(warnings).toEqual([
      expect.stringMatching(/retrying once/u),
    ]);
  });

  it('retries a timeout only once when both attempts time out', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ERR_SOCKET_TIMEOUT',
    }));
    const errors: string[] = [];
    const result = await runProductionAudit({
      runCommand,
      sleepFn: vi.fn(async () => {}),
      sleepMs: 0,
      log: vi.fn(),
      logWarning: vi.fn(),
      logError: (message: string) => errors.push(message),
    });

    expect(result).toMatchObject({ success: false, attempts: 2, exitCode: 1 });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(errors.join('\n')).toMatch(/failed on attempt 2/u);
  });

  it('fails immediately without retry on unknown non-transient error', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'unexpected lockfile format',
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await runProductionAudit({ runCommand, sleepFn });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

describe('Production dependency audit executable entry point', () => {
  function runRealScript(input: {
    stdout: string;
    stderr?: string;
    exitCode: number;
  }) {
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-audit-bin-'));
    tempDirs.push(binDir);
    const argvPath = join(binDir, 'argv.json');
    const fakePnpm = join(binDir, 'pnpm');
    writeFileSync(
      fakePnpm,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.AUDIT_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        `process.stdout.write(${JSON.stringify(input.stdout)});`,
        `process.stderr.write(${JSON.stringify(input.stderr ?? '')});`,
        `process.exitCode = ${input.exitCode};`,
      ].join('\n'),
    );
    chmodSync(fakePnpm, 0o755);

    const scriptPath = join(REPO_ROOT, 'scripts', 'ci', 'audit-production.mjs');
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        AUDIT_ARGV_PATH: argvPath,
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ...result,
      argv: JSON.parse(readFileSync(argvPath, 'utf8')) as string[],
    };
  }

  it('invokes pnpm with the exact production argv and propagates success', () => {
    const result = runRealScript({
      stdout: VALID_ZERO_VULN_JSON,
      exitCode: 0,
    });
    expect(result.status).toBe(0);
    expect(result.argv).toEqual(['audit', '--prod', '--json']);
    expect(result.stdout).toContain('No known vulnerabilities');
  });

  it('propagates failure after flushing a large advisory diagnostic', () => {
    const tailMarker = 'AUDIT_DIAGNOSTIC_TAIL_MARKER';
    const largeAdvisory = JSON.stringify({
      advisories: {
        one: { title: `${'x'.repeat(2 * 1024 * 1024)}${tailMarker}` },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
        },
      },
    });
    const result = runRealScript({ stdout: largeAdvisory, exitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.argv).toEqual(['audit', '--prod', '--json']);
    expect(result.stderr).toContain(tailMarker);
  });
});
