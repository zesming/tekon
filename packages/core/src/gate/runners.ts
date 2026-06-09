import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CommandPolicy } from '../types/config.js';
import type {
  CommandInvocation,
  GateResult,
  GateType,
} from '../types/domain.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import {
  scanFilesForSecrets,
  type SecretFinding,
} from '../security/secrets.js';

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

export type SecurityFinding = SecretFinding & { id: string; path: string };

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
  const findings = scanFilesForSecrets(input.cwd).map((finding) => ({
    ...finding,
    id: `finding_${randomUUID()}`,
    path: finding.path ?? '',
  }));
  const outputPath = join(input.outputDir, `${input.nodeId}-security-scan.log`);

  if (findings.length > 0) {
    writeFileSync(
      outputPath,
      JSON.stringify({ findings, scanner: 'tekon-builtin' }, null, 2),
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
    JSON.stringify({ findings: [], scanner: 'tekon-builtin' }, null, 2),
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
