import { describe, expect, it } from 'vitest';

import {
  isWorkflowTerminalError,
  WorkflowTerminalError,
} from '../../src/workflow/errors.js';

describe('WorkflowTerminalError', () => {
  it('carries the WORKFLOW_TERMINAL code, runId and terminal status', () => {
    const error = new WorkflowTerminalError('run_1', 'cancelled');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WorkflowTerminalError');
    expect(error.code).toBe('WORKFLOW_TERMINAL');
    expect(error.runId).toBe('run_1');
    expect(error.status).toBe('cancelled');
    expect(error.message).toContain('cancelled');
  });

  it('supports every terminal status', () => {
    for (const status of ['passed', 'failed', 'cancelled'] as const) {
      const error = new WorkflowTerminalError('run_1', status);
      expect(error.status).toBe(status);
      expect(error.code).toBe('WORKFLOW_TERMINAL');
    }
  });

  it('isWorkflowTerminalError guards the error type', () => {
    expect(
      isWorkflowTerminalError(new WorkflowTerminalError('run_1', 'passed')),
    ).toBe(true);

    expect(isWorkflowTerminalError(new Error('boom'))).toBe(false);
    expect(isWorkflowTerminalError('WORKFLOW_TERMINAL')).toBe(false);
    expect(isWorkflowTerminalError({ code: 'WORKFLOW_TERMINAL' })).toBe(false);
    expect(isWorkflowTerminalError(null)).toBe(false);
    expect(isWorkflowTerminalError(undefined)).toBe(false);
  });
});
