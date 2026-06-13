import { describe, expect, it } from 'vitest';

import {
  assertWorkflowTransition,
  canWorkflowTransition,
  transitionWorkflowNode,
} from '../../src/workflow/state-machine.js';

describe('workflow state machine', () => {
  it('allows only explicit legal node transitions', () => {
    expect(canWorkflowTransition('pending', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'awaiting-gate')).toBe(true);
    expect(canWorkflowTransition('awaiting-gate', 'passed')).toBe(true);
    expect(canWorkflowTransition('awaiting-gate', 'needs-revision')).toBe(true);
    expect(canWorkflowTransition('needs-revision', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'blocked')).toBe(true);
    expect(canWorkflowTransition('running', 'paused')).toBe(true);
    expect(canWorkflowTransition('paused', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'interrupted')).toBe(true);
    expect(canWorkflowTransition('interrupted', 'running')).toBe(true);
    expect(canWorkflowTransition('pending', 'skipped')).toBe(true);
    expect(canWorkflowTransition('running', 'failed')).toBe(true);

    expect(canWorkflowTransition('pending', 'passed')).toBe(false);
    expect(canWorkflowTransition('passed', 'running')).toBe(false);
  });

  it('throws a readable error for illegal transitions', () => {
    expect(() => assertWorkflowTransition('passed', 'running')).toThrow(
      /illegal workflow transition: passed -> running/u,
    );
  });

  it('transitionWorkflowNode performs a valid transition and records history', () => {
    const snapshot = { status: 'pending' as const, revision: 0 };
    const result = transitionWorkflowNode(snapshot, 'running');

    expect(result.status).toBe('running');
    expect(result.revision).toBe(0); // non-needs-revision keeps revision unchanged
    expect(result.updatedAt).toEqual(expect.any(String));
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      from: 'pending',
      to: 'running',
      at: expect.any(String),
    });
  });

  it('transitionWorkflowNode bumps revision on needs-revision transition', () => {
    const snapshot = { status: 'running' as const, revision: 2 };
    const result = transitionWorkflowNode(snapshot, 'needs-revision');

    expect(result.status).toBe('needs-revision');
    expect(result.revision).toBe(3);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      from: 'running',
      to: 'needs-revision',
    });
  });

  it('transitionWorkflowNode includes reason in history when provided', () => {
    const snapshot = { status: 'pending' as const };
    const result = transitionWorkflowNode(snapshot, 'running', {
      reason: 'manual trigger',
    });

    expect(result.history[0].reason).toBe('manual trigger');
    expect(result.history[0]).toMatchObject({
      from: 'pending',
      to: 'running',
      reason: 'manual trigger',
    });
  });

  it('transitionWorkflowNode appends to existing history', () => {
    const snapshot = {
      status: 'running' as const,
      history: [{ from: 'pending' as const, to: 'running' as const, at: '2026-01-01T00:00:00.000Z' }],
    };
    const result = transitionWorkflowNode(snapshot, 'awaiting-gate');

    expect(result.history).toHaveLength(2);
    expect(result.history[0].from).toBe('pending');
    expect(result.history[1]).toMatchObject({
      from: 'running',
      to: 'awaiting-gate',
    });
  });

  it('all terminal states have zero outgoing transitions', () => {
    // Note: 'passed' is no longer terminal — it can transition to
    // 'needs-revision' when an independent review finds changes-requested.
    const terminalStates = ['skipped', 'failed'] as const;
    // Verify 'passed' can only go to 'needs-revision'
    expect(canWorkflowTransition('passed', 'needs-revision')).toBe(true);
    const nonRevisionTargets = [
      'pending', 'running', 'awaiting-gate', 'blocked',
      'paused', 'interrupted', 'skipped', 'failed',
    ] as const;
    for (const target of nonRevisionTargets) {
      expect(canWorkflowTransition('passed', target)).toBe(false);
    }

    const allStates = [
      'pending',
      'running',
      'awaiting-gate',
      'passed',
      'needs-revision',
      'blocked',
      'paused',
      'interrupted',
      'skipped',
      'failed',
    ] as const;

    for (const terminal of terminalStates) {
      for (const target of allStates) {
        expect(canWorkflowTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('passed node can transition to needs-revision for rework', () => {
    expect(canWorkflowTransition('passed', 'needs-revision')).toBe(true);

    const node = { status: 'passed' as const, revision: 0 };
    const result = transitionWorkflowNode(node, 'needs-revision');

    expect(result.status).toBe('needs-revision');
    expect(result.revision).toBe(1);
  });

  it('passed node cannot transition to other states', () => {
    expect(canWorkflowTransition('passed', 'running')).toBe(false);
    expect(canWorkflowTransition('passed', 'blocked')).toBe(false);
    expect(canWorkflowTransition('passed', 'failed')).toBe(false);
    expect(canWorkflowTransition('passed', 'pending')).toBe(false);
  });

  it('needs-revision to running transition works for re-execution', () => {
    expect(canWorkflowTransition('needs-revision', 'running')).toBe(true);
  });

  it('transitionWorkflowNode handles passed → needs-revision → running → passed revision chain', () => {
    let node = { status: 'passed' as const, revision: 0 };

    // Transition to needs-revision → revision should be 1
    node = transitionWorkflowNode(node, 'needs-revision');
    expect(node.status).toBe('needs-revision');
    expect(node.revision).toBe(1);

    // Transition to running → revision should stay 1
    node = transitionWorkflowNode(node, 'running');
    expect(node.status).toBe('running');
    expect(node.revision).toBe(1);

    // Transition to passed → revision should stay 1
    node = transitionWorkflowNode(node, 'passed');
    expect(node.status).toBe('passed');
    expect(node.revision).toBe(1);
  });

  it('throws for invalid source or target status values', () => {
    expect(() => canWorkflowTransition('completed' as any, 'running')).toThrow();
    expect(() => canWorkflowTransition('pending', 'success' as any)).toThrow();
    expect(() => canWorkflowTransition('idle' as any, 'done' as any)).toThrow();
  });
});
