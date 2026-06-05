import { describe, expect, it } from 'vitest';

import {
  assertWorkflowTransition,
  canWorkflowTransition,
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
});
