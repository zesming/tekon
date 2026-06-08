import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandPolicy } from '../types/config.js';
import type { GateConfig, GateResult, Node, Role } from '../types/domain.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import { validateArtifactContent } from '../artifact/schemas.js';
import { runCommandGate, runSecurityScanGate } from './runners.js';
import { createHumanGate } from './human-gate.js';

export interface GateEngineRunInput {
  runId: string;
  nodeId: string;
  gate: GateConfig;
  cwd: string;
  artifactRoot?: string;
  outputDir: string;
  policy: CommandPolicy;
}

export interface GateEngine {
  runGate(input: GateEngineRunInput): Promise<GateResult>;
  createAutoFixRepairNode(input: {
    failedGateResult: GateResult;
    fixerRole: Role;
  }): Promise<Node>;
}

export function createGateEngine(options: {
  repositories: DonkeyRepositories;
  gateway?: CommandGateway;
}): GateEngine {
  return {
    async runGate(input) {
      let result: GateResult;

      if (input.gate.type === 'security-scan') {
        result = await runSecurityScanGate({
          gateway: options.gateway,
          runId: input.runId,
          nodeId: input.nodeId,
          cwd: input.cwd,
          command: input.gate.command,
          policy: input.policy,
          outputDir: input.outputDir,
          timeoutMs: input.gate.timeoutMs,
        });
      } else if (isCommandGate(input.gate.type)) {
        if (!options.gateway || !input.gate.command) {
          result = makeGateResult(input, 'failed', 'missing-command');
        } else {
          result = await runCommandGate({
            gateway: options.gateway,
            runId: input.runId,
            nodeId: input.nodeId,
            gateType: input.gate.type,
            cwd: input.cwd,
            command: input.gate.command,
            policy: input.policy,
            outputDir: input.outputDir,
            retries: 0,
            timeoutMs: input.gate.timeoutMs,
          });
        }
      } else if (input.gate.type === 'schema') {
        result = await runSchemaGate(input, options.repositories);
      } else if (input.gate.type === 'human') {
        result = makeGateResult(input, 'blocked', 'human-approval');
        await options.repositories.recordGateResult(result);
        await createHumanGate({
          repositories: options.repositories,
        }).requestHumanGate({
          runId: input.runId,
          nodeId: input.nodeId,
          gateResultId: result.id,
          note: formatHumanGateContext(input.gate, result),
        });
        return result;
      } else {
        result = makeGateResult(input, 'failed', 'unsupported-gate');
      }

      return options.repositories.recordGateResult(result);
    },

    async createAutoFixRepairNode(input) {
      const now = new Date().toISOString();
      return options.repositories.createNode({
        id: `repair_${input.failedGateResult.id}`,
        runId: input.failedGateResult.runId,
        role: input.fixerRole,
        status: 'pending',
        inputs: [],
        outputs: [],
        gates: [],
        dependencies: [input.failedGateResult.nodeId],
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

function formatHumanGateContext(gate: GateConfig, result: GateResult): string {
  return [
    'request: Human approval is required before this node can continue.',
    `gate: ${result.id} ${gate.type} ${result.status}`,
    `exactCommand: ${gate.command ? formatCommand(gate.command) : 'not_applicable'}`,
    `risk: ${gate.type === 'human' ? 'human-control' : 'normal'}`,
  ].join('\n');
}

function formatCommand(command: NonNullable<GateConfig['command']>): string {
  return [command.tool, ...(command.args ?? [])].join(' ').trim();
}

function isCommandGate(
  type: GateConfig['type'],
): type is 'build' | 'test' | 'lint' | 'e2e-pass' {
  return ['build', 'test', 'lint', 'e2e-pass'].includes(type);
}

async function runSchemaGate(
  input: GateEngineRunInput,
  repositories: DonkeyRepositories,
): Promise<GateResult> {
  mkdirSync(input.outputDir, { recursive: true });
  const outputPath = join(input.outputDir, `${input.nodeId}-schema.log`);
  const artifactType = input.gate.artifactType;
  if (!artifactType) {
    writeFileSync(outputPath, 'missing artifact type for schema gate', 'utf8');
    return makeGateResult(input, 'failed', 'missing-artifact-type', outputPath);
  }

  const artifacts = await repositories.listArtifacts(
    input.runId,
    input.nodeId,
    artifactType,
  );

  if (artifacts.length === 0) {
    writeFileSync(
      outputPath,
      `missing artifact: ${artifactType ?? 'unspecified'}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'missing-artifact', outputPath);
  }

  const latestArtifact = artifacts.at(-1)!;
  try {
    const content = readFileSync(
      join(input.artifactRoot ?? input.cwd, latestArtifact.path),
      'utf8',
    );
    validateArtifactContent(artifactType, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      outputPath,
      `invalid artifact ${latestArtifact.path}: ${message}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'invalid-artifact', outputPath);
  }

  writeFileSync(
    outputPath,
    `schema gate passed for ${artifactType}: ${latestArtifact.path}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

function makeGateResult(
  input: GateEngineRunInput,
  status: GateResult['status'],
  failureClassification: string | null,
  outputPath?: string,
): GateResult {
  return {
    id: `gate_${randomUUID()}`,
    runId: input.runId,
    nodeId: input.nodeId,
    gateType: input.gate.type,
    status,
    outputPath,
    durationMs: 0,
    retries: 0,
    failureClassification,
    createdAt: new Date().toISOString(),
  };
}
