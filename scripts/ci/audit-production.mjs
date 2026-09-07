#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT/i,
  /ERR_SOCKET_TIMEOUT/i,
  /ERR_PNPM_AUDIT_TIMEOUT/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /timed?\s*out/i,
  /HTTP\s*5\d\d/i,
  /status\s*5\d\d/i,
  /500\s+Internal\s+Server\s+Error/i,
  /502\s+Bad\s+Gateway/i,
  /503\s+Service\s+Unavailable/i,
  /504\s+Gateway\s+Timeout/i,
  /Bad\s+Gateway/i,
  /Service\s+Unavailable/i,
  /Gateway\s+Timeout/i,
];

export function parseAndValidateAuditJson(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return { valid: false, error: 'empty_stdout' };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { valid: false, error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'malformed_structure' };
  }

  const advisories = parsed.advisories;
  if (
    !advisories ||
    typeof advisories !== 'object' ||
    Array.isArray(advisories)
  ) {
    return { valid: false, error: 'missing_or_invalid_advisories' };
  }

  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { valid: false, error: 'missing_metadata' };
  }

  const vulns = metadata.vulnerabilities;
  if (!vulns || typeof vulns !== 'object' || Array.isArray(vulns)) {
    return { valid: false, error: 'missing_vulnerabilities' };
  }

  const categories = ['info', 'low', 'moderate', 'high', 'critical'];
  let totalVulns = 0;
  for (const cat of categories) {
    const count = vulns[cat];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      return { valid: false, error: `invalid_vulnerability_count_${cat}` };
    }
    totalVulns += count;
  }

  const advisoryCount = Object.keys(advisories).length;
  return {
    valid: true,
    data: parsed,
    advisories,
    advisoryCount,
    vulnerabilities: vulns,
    totalVulns,
  };
}

export function classifyAuditAttempt({ exitCode, stdout, stderr }) {
  const jsonValidation = parseAndValidateAuditJson(stdout);

  if (jsonValidation.valid) {
    if (jsonValidation.advisoryCount > 0 || jsonValidation.totalVulns > 0) {
      return {
        status: 'vulnerability',
        retryable: false,
        totalVulns: jsonValidation.totalVulns,
        advisoryCount: jsonValidation.advisoryCount,
        reason: `Vulnerabilities found: ${jsonValidation.totalVulns} (${jsonValidation.advisoryCount} advisories)`,
      };
    }

    if (exitCode === 0) {
      return {
        status: 'success',
        retryable: false,
        reason: 'No known vulnerabilities found in production dependencies',
      };
    }

    return {
      status: 'fatal_failure',
      retryable: false,
      reason: `Audit returned valid zero-vulnerability JSON but exited with code ${exitCode}`,
    };
  }

  if (exitCode === 0) {
    return {
      status: 'fatal_failure',
      retryable: false,
      reason: `Command exited 0 but output was invalid or empty: ${jsonValidation.error || 'unknown'}`,
    };
  }

  const combinedError = `${stdout}\n${stderr}`;
  const isTransient = TRANSIENT_PATTERNS.some((pattern) =>
    pattern.test(combinedError),
  );

  if (isTransient) {
    return {
      status: 'transient_failure',
      retryable: true,
      reason: `Transient registry/network error detected (exit ${exitCode})`,
    };
  }

  return {
    status: 'fatal_failure',
    retryable: false,
    reason: `Audit failed with exit code ${exitCode} and unclassified error output`,
  };
}

export async function defaultRunCommand() {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['audit', '--prod', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runProductionAudit(options = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const sleepMs = options.sleepMs ?? 15_000;
  const log = options.log ?? console.log;
  const logWarning = options.logWarning ?? console.warn;
  const logError = options.logError ?? console.error;

  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(
      `[audit] Running production dependency audit (attempt ${attempt}/${maxAttempts})...`,
    );
    const rawResult = await runCommand();
    const classification = classifyAuditAttempt(rawResult);

    if (classification.status === 'success') {
      log(`[audit] ${classification.reason}`);
      return { success: true, attempts: attempt, exitCode: 0, classification };
    }

    if (classification.status === 'vulnerability') {
      logError(`::error::${classification.reason}`);
      if (rawResult.stdout) {
        logError(rawResult.stdout);
      }
      return {
        success: false,
        attempts: attempt,
        exitCode: 1,
        reason: classification.status,
        classification,
      };
    }

    if (
      classification.status === 'transient_failure' &&
      attempt < maxAttempts
    ) {
      logWarning(
        `::warning::${classification.reason}; retrying once after ${Math.round(sleepMs / 1000)}s...`,
      );
      await sleepFn(sleepMs);
      continue;
    }

    logError(
      `::error::Production dependency audit failed on attempt ${attempt}: ${classification.reason}`,
    );
    if (rawResult.stderr) {
      logError(rawResult.stderr);
    }
    return {
      success: false,
      attempts: attempt,
      exitCode: 1,
      reason: classification.status,
      classification,
    };
  }

  return {
    success: false,
    attempts: maxAttempts,
    exitCode: 1,
    reason: 'max_attempts_exceeded',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outcome = await runProductionAudit();
  process.exitCode = outcome.exitCode;
}
