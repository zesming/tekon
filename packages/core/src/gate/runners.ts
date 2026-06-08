import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CommandPolicy } from '../types/config.js';
import type {
  CommandInvocation,
  GateResult,
  GateType,
} from '../types/domain.js';
import type { CommandGateway } from '../runtime/command-gateway.js';

export interface RunCommandGateInput {
  gateway: CommandGateway;
  runId: string;
  nodeId: string;
  gateType: Extract<
    GateType,
    'build' | 'test' | 'lint' | 'e2e-pass' | 'security-scan'
  >;
  cwd: string;
  command: CommandInvocation;
  policy: CommandPolicy;
  outputDir: string;
  retries?: number;
  timeoutMs?: number;
}

export async function runCommandGate(
  input: RunCommandGateInput,
): Promise<GateResult> {
  mkdirSync(input.outputDir, { recursive: true });
  const startedAt = Date.now();
  const result = await input.gateway.run({
    command: input.command,
    cwd: input.cwd,
    policy: input.policy,
    outputDir: input.outputDir,
    timeoutMs: input.timeoutMs,
    runId: input.runId,
    nodeId: input.nodeId,
  });

  const outputPath = join(
    input.outputDir,
    `${input.nodeId}-${input.gateType}.log`,
  );
  let status: GateResult['status'] = 'failed';
  let failureClassification: string | null = null;

  if (result.status === 'executed') {
    const stdout = readFileSync(result.stdoutPath, 'utf8');
    const stderr = readFileSync(result.stderrPath, 'utf8');
    writeFileSync(outputPath, `${stdout}${stderr}`, 'utf8');
    status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed';
    failureClassification = result.timedOut
      ? 'timeout'
      : result.exitCode === 0
        ? null
        : 'exit-code';
  } else {
    const output =
      result.status === 'rejected'
        ? result.reason
        : `command blocked for approval: ${result.decisionId}`;
    writeFileSync(outputPath, output, 'utf8');
    status = result.status === 'blocked-for-approval' ? 'blocked' : 'failed';
    failureClassification = result.status;
  }

  return {
    id: `gate_${randomUUID()}`,
    runId: input.runId,
    nodeId: input.nodeId,
    gateType: input.gateType,
    status,
    outputPath,
    durationMs: Date.now() - startedAt,
    retries: input.retries ?? 0,
    failureClassification,
    createdAt: new Date().toISOString(),
  };
}

export interface SecurityFinding {
  id: string;
  severity: 'high' | 'critical';
  path: string;
  ruleId: string;
  message: string;
}

export interface RunSecurityScanGateInput {
  gateway?: CommandGateway;
  runId: string;
  nodeId: string;
  cwd: string;
  command?: CommandInvocation;
  policy: CommandPolicy;
  outputDir: string;
  timeoutMs?: number;
}

export async function runSecurityScanGate(
  input: RunSecurityScanGateInput,
): Promise<GateResult> {
  mkdirSync(input.outputDir, { recursive: true });
  const startedAt = Date.now();
  const findings = scanForSecrets(input.cwd);
  const outputPath = join(input.outputDir, `${input.nodeId}-security-scan.log`);

  if (findings.length > 0) {
    writeFileSync(
      outputPath,
      JSON.stringify({ findings, scanner: 'donkey-builtin' }, null, 2),
      'utf8',
    );
    return {
      id: `gate_${randomUUID()}`,
      runId: input.runId,
      nodeId: input.nodeId,
      gateType: 'security-scan',
      status: 'failed',
      outputPath,
      durationMs: Date.now() - startedAt,
      retries: 0,
      failureClassification: 'security-findings',
      createdAt: new Date().toISOString(),
    };
  }

  if (input.gateway && input.command) {
    return runCommandGate({
      gateway: input.gateway,
      runId: input.runId,
      nodeId: input.nodeId,
      gateType: 'security-scan',
      cwd: input.cwd,
      command: input.command,
      policy: input.policy,
      outputDir: input.outputDir,
      timeoutMs: input.timeoutMs,
    });
  }

  writeFileSync(
    outputPath,
    JSON.stringify({ findings: [], scanner: 'donkey-builtin' }, null, 2),
    'utf8',
  );
  return {
    id: `gate_${randomUUID()}`,
    runId: input.runId,
    nodeId: input.nodeId,
    gateType: 'security-scan',
    status: 'passed',
    outputPath,
    durationMs: Date.now() - startedAt,
    retries: 0,
    failureClassification: null,
    createdAt: new Date().toISOString(),
  };
}

function scanForSecrets(root: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const filePath of listScannableFiles(root)) {
    const content = readFileSync(filePath, 'utf8');
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(content)) {
        findings.push({
          id: `finding_${randomUUID()}`,
          severity: rule.severity,
          path: relative(root, filePath),
          ruleId: rule.id,
          message: rule.message,
        });
      }
    }
  }
  return findings;
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

const SECRET_RULES: Array<{
  id: string;
  severity: 'high' | 'critical';
  pattern: RegExp;
  message: string;
}> = [
  {
    id: 'private-key',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    message: 'Private key material is present in the worktree.',
  },
  {
    id: 'openai-api-key',
    severity: 'critical',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    message: 'OpenAI-style API key is present in the worktree.',
  },
  {
    id: 'aws-access-key',
    severity: 'critical',
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
    message: 'AWS access key is present in the worktree.',
  },
  {
    id: 'generic-token-assignment',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/iu,
    message: 'A likely token or secret assignment is present in the worktree.',
  },
];
