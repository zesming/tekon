import { describe, expect, it } from 'vitest';

import type { Node, Phase } from '../../src/types/domain.js';
import { createPhaseSchedule } from '../../src/workflow/scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO = '2026-01-01T00:00:00.000Z';

function makePhase(overrides: Partial<Phase> & { id: string }): Phase {
  return {
    runId: 'run-1',
    name: `phase-${overrides.id}`,
    status: 'pending',
    order: 0,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    runId: 'run-1',
    phaseId: 'phase-1',
    role: 'rd',
    status: 'pending',
    inputs: [],
    outputs: [],
    gates: [],
    dependencies: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPhaseSchedule', () => {
  it('preserves the original phase ordering', () => {
    const phases = [
      makePhase({ id: 'phase-c', order: 2 }),
      makePhase({ id: 'phase-a', order: 0 }),
      makePhase({ id: 'phase-b', order: 1 }),
    ];

    const result = createPhaseSchedule({ phases, nodes: [] });

    expect(result).toHaveLength(3);
    expect(result[0]!.phase.id).toBe('phase-c');
    expect(result[1]!.phase.id).toBe('phase-a');
    expect(result[2]!.phase.id).toBe('phase-b');
  });

  it('filters nodes by phaseId correctly', () => {
    const phases = [makePhase({ id: 'phase-1' }), makePhase({ id: 'phase-2' })];
    const nodes = [
      makeNode({ id: 'n1', phaseId: 'phase-1' }),
      makeNode({ id: 'n2', phaseId: 'phase-2' }),
      makeNode({ id: 'n3', phaseId: 'phase-1' }),
    ];

    const result = createPhaseSchedule({ phases, nodes });

    expect(result[0]!.nodes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(result[1]!.nodes.map((n) => n.id)).toEqual(['n2']);
  });

  it('produces empty node arrays for phases with no matching nodes', () => {
    const phases = [
      makePhase({ id: 'phase-1' }),
      makePhase({ id: 'phase-empty' }),
    ];
    const nodes = [makeNode({ id: 'n1', phaseId: 'phase-1' })];

    const result = createPhaseSchedule({ phases, nodes });

    expect(result[0]!.nodes).toHaveLength(1);
    expect(result[1]!.nodes).toEqual([]);
  });

  it('excludes nodes whose phaseId does not match any phase', () => {
    const phases = [makePhase({ id: 'phase-1' })];
    const nodes = [
      makeNode({ id: 'n1', phaseId: 'phase-1' }),
      makeNode({ id: 'n-orphan', phaseId: 'phase-unknown' }),
    ];

    const result = createPhaseSchedule({ phases, nodes });

    expect(result).toHaveLength(1);
    expect(result[0]!.nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('returns an empty array when given no phases and no nodes', () => {
    const result = createPhaseSchedule({ phases: [], nodes: [] });

    expect(result).toEqual([]);
  });

  it('preserves the relative order of multiple nodes within the same phase', () => {
    const phases = [makePhase({ id: 'phase-1' })];
    const nodes = [
      makeNode({ id: 'n-a', phaseId: 'phase-1' }),
      makeNode({ id: 'n-b', phaseId: 'phase-1' }),
      makeNode({ id: 'n-c', phaseId: 'phase-1' }),
    ];

    const result = createPhaseSchedule({ phases, nodes });

    expect(result[0]!.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b', 'n-c']);
  });

  it('excludes nodes with undefined phaseId from all phases', () => {
    const phases = [makePhase({ id: 'phase-1' })];
    const nodes = [
      makeNode({ id: 'n1', phaseId: 'phase-1' }),
      makeNode({ id: 'n-no-phase', phaseId: undefined }),
    ];

    const result = createPhaseSchedule({ phases, nodes });

    expect(result[0]!.nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('returns phase objects by reference (same identity)', () => {
    const phase = makePhase({ id: 'phase-1' });
    const result = createPhaseSchedule({ phases: [phase], nodes: [] });

    expect(result[0]!.phase).toBe(phase);
  });
});
