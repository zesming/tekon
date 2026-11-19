import type { TekonRepositories } from '../../src/db/repositories.js';
import type { GateEngine } from '../../src/gate/engine.js';

/**
 * Gate engine for tests that do not care about gates: every gate is recorded
 * as passed without running anything. Tests that use it must not assert gate
 * behavior; those keep the real engine. Test-only, never exported from core.
 */
export function passthroughGateEngine(repositories: TekonRepositories): GateEngine {
  let gateCounter = 0;
  return {
    async runGate(input) {
      gateCounter += 1;
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        gateKey: input.gate.gateKey,
        status: 'passed',
        durationMs: 0,
        retries: 0,
        createdAt: new Date().toISOString(),
      });
    },
  };
}
