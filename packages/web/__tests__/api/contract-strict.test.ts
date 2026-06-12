import { describe, expect, it } from 'vitest';

import {
  roleItemSchema,
  roleListOutputSchema,
  apiWorkflowSchema,
  apiAuditEventSchema,
  apiHumanDecisionSchema,
  apiHumanDecisionContextSchema,
  apiArtifactSchema,
  apiGateSchema,
} from '../../src/shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Regression tests for P2: strict output schemas detect field drift.
//
// Security-sensitive DTOs use .strict() so that any handler accidentally
// returning an extra field (e.g. systemPrompt leaking into role.list) causes
// a parse error instead of silently passing the field through to the client.
// ---------------------------------------------------------------------------

describe('strict output schemas — field drift detection', () => {
  // --- roleItemSchema -------------------------------------------------------

  it('roleItemSchema rejects extra systemPrompt field', () => {
    const valid = {
      id: 'role_1',
      name: 'coder',
      hasSystemPrompt: true,
    };
    expect(() => roleItemSchema.parse(valid)).not.toThrow();

    const leaked = {
      ...valid,
      systemPrompt: 'You are a senior engineer…',
    };
    expect(() => roleItemSchema.parse(leaked)).toThrow();
  });

  it('roleListOutputSchema rejects roles with extra fields', () => {
    const output = {
      roles: [
        {
          id: 'role_1',
          name: 'coder',
          hasSystemPrompt: true,
          systemPrompt: 'leaked!',
        },
      ],
    };
    expect(() => roleListOutputSchema.parse(output)).toThrow();
  });

  // --- apiWorkflowSchema ----------------------------------------------------

  it('apiWorkflowSchema rejects extra fields', () => {
    const valid = {
      id: 'run_1',
      projectId: 'proj_1',
      demandId: 'dem_1',
      status: 'running',
      currentNodeId: 'node_1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(() => apiWorkflowSchema.parse(valid)).not.toThrow();

    expect(() =>
      apiWorkflowSchema.parse({ ...valid, internalState: 'secret' }),
    ).toThrow();
  });

  // --- apiAuditEventSchema --------------------------------------------------

  it('apiAuditEventSchema rejects extra fields', () => {
    const valid = {
      id: 'evt_1',
      runId: 'run_1',
      type: 'gate.started',
      payload: {},
      nodeId: 'node_1',
      gateId: null,
      role: null,
      prevHash: null,
      hash: 'abc123',
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(() => apiAuditEventSchema.parse(valid)).not.toThrow();

    expect(() =>
      apiAuditEventSchema.parse({ ...valid, rawSecret: 'should-not-leak' }),
    ).toThrow();
  });

  // --- apiHumanDecisionSchema -----------------------------------------------

  it('apiHumanDecisionSchema rejects extra fields', () => {
    const context = {
      request: 'approve deployment',
      exactCommand: 'tekon gate approve …',
      riskLabel: 'high',
      nodeRole: 'reviewer',
      approvalSummary: null,
      approvalEvaluation: null,
      gate: null,
    };
    // Validate the context sub-schema first
    expect(() => apiHumanDecisionContextSchema.parse(context)).not.toThrow();

    const valid = {
      id: 'dec_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: null,
      status: 'pending',
      actor: null,
      note: null,
      createdAt: '2026-01-01T00:00:00Z',
      decidedAt: null,
      context,
    };
    expect(() => apiHumanDecisionSchema.parse(valid)).not.toThrow();

    expect(() =>
      apiHumanDecisionSchema.parse({ ...valid, secretToken: 'leaked' }),
    ).toThrow();
  });

  // --- Generic: any hypothetical extra sensitive field is caught ------------

  it.each([
    {
      name: 'apiArtifactSchema',
      schema: apiArtifactSchema,
      valid: {
        id: 'art_1',
        runId: 'run_1',
        nodeId: 'node_1',
        type: 'package',
        version: 1,
        path: '/tmp/art',
        sha256: 'deadbeef',
        sizeBytes: 100,
        summary: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      name: 'apiGateSchema',
      schema: apiGateSchema,
      valid: {
        id: 'gate_1',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'review',
        status: 'passed',
        outputPath: null,
        durationMs: 500,
        retries: 0,
        fixAttemptId: null,
        failureClassification: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    },
  ] as const)(
    '$name rejects hypothetical extra sensitive field',
    ({ schema, valid }) => {
      expect(() => (schema as any).parse(valid)).not.toThrow();
      expect(() =>
        (schema as any).parse({ ...valid, sensitiveInternal: 'leak' }),
      ).toThrow();
    },
  );
});
