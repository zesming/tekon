import { describe, expect, it } from 'vitest';

import {
  artifactSchema,
  auditEventSchema,
  demandSchema,
  gateConfigSchema,
  gateResultSchema,
  projectSchema,
  workflowInstanceSchema,
} from '../../src/index.js';

describe('domain schemas', () => {
  it('exports public schemas for the phase 1 domain model', () => {
    expect(
      demandSchema.parse({
        id: 'demand_1',
        title: 'Add status command',
        body: 'Show the current Donkey run status.',
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ id: 'demand_1' });

    expect(
      projectSchema.parse({
        id: 'project_1',
        name: 'donkey',
        repoPath: '/tmp/donkey',
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ repoPath: '/tmp/donkey' });

    expect(
      workflowInstanceSchema.parse({
        id: 'run_1',
        projectId: 'project_1',
        demandId: 'demand_1',
        status: 'running',
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ status: 'running' });

    expect(
      artifactSchema.parse({
        id: 'artifact_1',
        runId: 'run_1',
        nodeId: 'node_1',
        type: 'prd',
        version: 1,
        path: '.donkey/runs/run_1/artifacts/node_1/prd.v1.md',
        sha256: 'abc123',
        sizeBytes: 42,
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ type: 'prd' });

    expect(
      gateResultSchema.parse({
        id: 'gate_1',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'schema',
        status: 'passed',
        durationMs: 3,
        retries: 0,
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ gateType: 'schema' });

    expect(
      auditEventSchema.parse({
        id: 'event_1',
        runId: 'run_1',
        type: 'gate.passed',
        payload: { gateType: 'schema' },
        prevHash: null,
        hash: 'hash_1',
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ).toMatchObject({ type: 'gate.passed' });
  });

  it('rejects unknown gate types', () => {
    expect(() =>
      gateConfigSchema.parse({
        type: 'deploy-production',
      }),
    ).toThrow();
  });
});
