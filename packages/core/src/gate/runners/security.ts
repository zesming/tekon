import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import { runSecurityScanGate } from '../runners.js';
import type { GateRunnerInput } from '../helpers.js';
import type { GateDefinition } from '../registry.js';

export function securityScanGateDefinition(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition {
  return {
    type: 'security-scan',
    category: 'command',
    tags: ['security', 'scan'],
    metadata: {
      commandLike: true,
      humanBlocking: false,
      supportsNotApplicable: false,
      requiredEvidence: [],
      sideEffect: 'creates-artifact',
      riskTags: ['security'],
    },
    runner: async (input: GateRunnerInput) =>
      runSecurityScanGate({
        gateway: deps.gateway,
        runId: input.runId,
        nodeId: input.nodeId,
        gateKey: input.gate.gateKey,
        cwd: input.cwd,
        command: input.gate.command,
        policy: input.policy,
        outputDir: input.outputDir,
        timeoutMs: input.gate.timeoutMs,
      }),
  };
}
