import { describe, expect, it } from 'vitest';

import type {
  GateResult,
  HumanDecision,
  Node,
} from '../../src/types/domain.js';
import { resolveHumanReworkTrigger } from '../../src/workflow/human-rework.js';
import type { ExecutableNode } from '../../src/workflow/workflow-runtime.js';

const RUN_ID = 'run_1';

function reviewNode(): ExecutableNode {
  return {
    id: `${RUN_ID}_reviewer-node`,
    role: 'reviewer',
    workspace: 'worktree',
    inputs: [],
    outputs: [],
    gates: [
      {
        type: 'human',
        gateKey: '00.human',
        requiresHumanApproval: true,
        reworkTargetNodeId: 'rd-node',
        maxRetries: 0,
        retryPolicy: {
          maxRetries: 0,
          maxAttempts: 1,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
      },
    ],
  };
}

function node(id: string, status: Node['status']): Node {
  return {
    id: `${RUN_ID}_${id}`,
    runId: RUN_ID,
    role: 'rd',
    status,
    inputs: [],
    outputs: [],
    gates: [],
    dependencies: [],
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  };
}

function rejectedDecision(note = '请补充边界处理'): HumanDecision {
  return {
    id: 'decision_1',
    runId: RUN_ID,
    nodeId: `${RUN_ID}_reviewer-node`,
    gateResultId: 'gate_1',
    status: 'rejected',
    actor: 'reviewer',
    note,
    requestNote: 'request: review',
    createdAt: '2026-11-17T00:00:00Z',
    decidedAt: '2026-11-17T00:01:00Z',
  };
}

function humanRejectedGate(): GateResult {
  return {
    id: 'gate_1',
    runId: RUN_ID,
    nodeId: `${RUN_ID}_reviewer-node`,
    gateType: 'human',
    gateKey: '00.human',
    status: 'failed',
    failureClassification: 'human-rejected',
    durationMs: 0,
    retries: 0,
    createdAt: '2026-11-17T00:01:00Z',
  };
}

describe('PD-18 resolveHumanReworkTrigger', () => {
  const base = {
    runId: RUN_ID,
    node: reviewNode(),
    nodes: [node('rd-node', 'passed'), node('reviewer-node', 'blocked')],
    gateResults: [humanRejectedGate()],
    decisions: [rejectedDecision()],
    reworkAttemptEvents: [],
  };

  it('resolves the target node and feedback note for a fresh rejection', () => {
    const trigger = resolveHumanReworkTrigger(base);
    expect(trigger).toMatchObject({
      targetNodeId: `${RUN_ID}_rd-node`,
      attempt: 1,
      gateResult: expect.objectContaining({ id: 'gate_1' }),
      feedbackNote: '请补充边界处理',
    });
  });

  it('returns null when the human gate declares no rework target', () => {
    const noTarget = reviewNode();
    delete noTarget.gates[0]!.reworkTargetNodeId;
    expect(resolveHumanReworkTrigger({ ...base, node: noTarget })).toBeNull();
  });

  it('returns null without a rejected decision', () => {
    const pending = {
      ...rejectedDecision(),
      status: 'pending' as const,
      decidedAt: null,
    };
    expect(
      resolveHumanReworkTrigger({ ...base, decisions: [pending] }),
    ).toBeNull();
  });

  it('returns null without a human-rejected gate result', () => {
    const other = {
      ...humanRejectedGate(),
      failureClassification: 'human-approval',
      status: 'blocked' as const,
    };
    expect(
      resolveHumanReworkTrigger({ ...base, gateResults: [other] }),
    ).toBeNull();
  });

  it('returns null when the same gate result already triggered a rework', () => {
    expect(
      resolveHumanReworkTrigger({
        ...base,
        reworkAttemptEvents: [{ payload: { gateResultId: 'gate_1' } }],
      }),
    ).toBeNull();
  });

  it('returns null when the declared target node does not exist in the run', () => {
    expect(
      resolveHumanReworkTrigger({
        ...base,
        nodes: [node('reviewer-node', 'blocked')],
      }),
    ).toBeNull();
  });

  it('falls back to a generic note when the rejection carries no note', () => {
    const trigger = resolveHumanReworkTrigger({
      ...base,
      decisions: [rejectedDecision('   ')],
    });
    expect(trigger?.feedbackNote).toContain('without a note');
  });
});
