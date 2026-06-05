import type { Node, Phase } from '../types/domain.js';

export interface ScheduledPhase {
  phase: Phase;
  nodes: Node[];
}

export function createPhaseSchedule(input: {
  phases: Phase[];
  nodes: Node[];
}): ScheduledPhase[] {
  return input.phases.map((phase) => ({
    phase,
    nodes: input.nodes.filter((node) => node.phaseId === phase.id),
  }));
}
