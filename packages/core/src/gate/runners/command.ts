import type { GateResult } from '../../types/domain.js';
import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import { runCommandGate } from '../runners.js';
import { type GateRunnerInput, makeGateResult } from '../helpers.js';
import type { GateDefinition } from '../registry.js';

function commandRunner(
  deps: { repositories: TekonRepositories; gateway?: CommandGateway },
  gateType: 'build' | 'test' | 'lint' | 'e2e-pass',
): (input: GateRunnerInput) => Promise<GateResult> {
  return async (input: GateRunnerInput) => {
    if (!deps.gateway || !input.gate.command) {
      return makeGateResult(input, 'failed', 'missing-command');
    }
    return runCommandGate({
      gateway: deps.gateway,
      runId: input.runId,
      nodeId: input.nodeId,
      gateType,
      gateKey: input.gate.gateKey,
      cwd: input.cwd,
      command: input.gate.command,
      policy: input.policy,
      outputDir: input.outputDir,
      retries: 0,
      timeoutMs: input.gate.timeoutMs,
    });
  };
}

const commandGateMeta = (tags: string[]) => ({
  commandLike: true,
  humanBlocking: false,
  supportsNotApplicable: true,
  requiredEvidence: [] as string[],
  sideEffect: 'creates-artifact' as const,
  riskTags: tags,
});

export function buildCommandGateDefinitions(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition[] {
  return [
    {
      type: 'build',
      category: 'command',
      tags: ['build', 'ci'],
      metadata: commandGateMeta(['build']),
      runner: commandRunner(deps, 'build'),
    },
    {
      type: 'test',
      category: 'command',
      tags: ['test', 'ci'],
      metadata: commandGateMeta(['quality']),
      runner: commandRunner(deps, 'test'),
    },
    {
      type: 'lint',
      category: 'command',
      tags: ['lint', 'ci'],
      metadata: commandGateMeta(['quality']),
      runner: commandRunner(deps, 'lint'),
    },
    {
      type: 'e2e-pass',
      category: 'command',
      tags: ['e2e', 'ci'],
      metadata: commandGateMeta(['quality']),
      runner: commandRunner(deps, 'e2e-pass'),
    },
  ];
}
