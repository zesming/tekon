import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import { createHumanGate } from '../human-gate.js';
import {
  type GateRunnerInput,
  makeGateResult,
  formatHumanGateContext,
} from '../helpers.js';
import type { GateDefinition } from '../registry.js';

export function humanGateDefinition(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition {
  return {
    type: 'human',
    category: 'human',
    tags: ['human', 'approval', 'control'],
    metadata: {
      commandLike: false,
      humanBlocking: true,
      supportsNotApplicable: false,
      requiredEvidence: [],
      sideEffect: 'creates-decision',
      riskTags: ['human-control'],
    },
    handlesOwnPersistence: true,
    runner: async (input: GateRunnerInput) => {
      const result = makeGateResult(input, 'blocked', 'human-approval');
      await deps.repositories.recordGateResult(result);
      await createHumanGate({
        repositories: deps.repositories,
      }).requestHumanGate({
        runId: input.runId,
        nodeId: input.nodeId,
        gateResultId: result.id,
        note: formatHumanGateContext(input.gate, result),
      });
      return result;
    },
  };
}
