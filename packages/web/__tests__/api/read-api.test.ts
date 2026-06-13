import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('web read API', () => {
  it('returns overview, artifacts, gates, audit, roles, and workflows', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const overview = await api.project.overview();
    expect(overview.project).toMatchObject({ id: 'project_1' });
    expect(overview.latestRun).toMatchObject({ id: 'run_1' });
    expect(overview.counts).toMatchObject({
      artifacts: 1,
      gates: 1,
      audit: 2,
      pendingApprovals: 1,
      roles: 1,
      workflows: 1,
    });
    await expect(
      api.project.detail({ projectId: 'project_1' }),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({ id: 'run_1' }),
        expect.objectContaining({ id: 'run_0' }),
      ],
    });

    await expect(api.artifact.list({ runId: 'run_1' })).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ id: 'artifact_1' })],
    });
    await expect(api.review.get({ runId: 'run_0' })).resolves.toMatchObject({
      artifacts: [
        expect.objectContaining({
          id: 'artifact_0',
          content: expect.objectContaining({
            content: expect.stringContaining('Older run review body'),
          }),
        }),
      ],
      gates: [
        expect.objectContaining({
          id: 'gate_0',
          output: expect.objectContaining({
            content: expect.stringContaining('older build passed'),
          }),
        }),
      ],
    });
    await expect(api.gate.list({ runId: 'run_1' })).resolves.toMatchObject({
      pendingDecisions: [
        expect.objectContaining({
          id: 'decision_1',
          context: expect.objectContaining({
            exactCommand:
              'tekon run --template standard-delivery --agent codex',
            riskLabel: 'high',
            nodeRole: 'reviewer',
            gate: expect.objectContaining({ id: 'gate_1', type: 'human' }),
          }),
        }),
      ],
    });
    await expect(api.audit.list({ runId: 'run_1' })).resolves.toMatchObject({
      verification: { valid: true },
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'human.decision.pending',
          nodeId: 'node_1',
          gateId: 'gate_1',
          role: 'reviewer',
          hash: expect.any(String),
        }),
      ]),
    });
    await expect(api.review.get({ runId: 'run_1' })).resolves.toMatchObject({
      readiness: expect.objectContaining({
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'workflow-passed', passed: false }),
        ]),
      }),
      artifacts: [
        expect.objectContaining({
          id: 'artifact_1',
          content: expect.objectContaining({
            exists: true,
            content: expect.stringContaining('Review report body'),
          }),
        }),
      ],
      gates: [
        expect.objectContaining({
          id: 'gate_1',
          output: expect.objectContaining({
            content: expect.stringContaining('human approval is required'),
          }),
        }),
      ],
      delivery: expect.objectContaining({
        package: expect.objectContaining({
          content: expect.stringContaining('PR Preparation'),
        }),
        prBody: expect.objectContaining({
          content: expect.stringContaining('Add dashboard'),
        }),
      }),
      evidenceGroups: expect.arrayContaining([
        expect.objectContaining({
          id: 'review-route',
          links: expect.arrayContaining([
            expect.objectContaining({ href: '#pr-package' }),
          ]),
        }),
        expect.objectContaining({
          id: 'readiness-workflow-passed',
          links: expect.arrayContaining([
            expect.objectContaining({ kind: 'audit-event' }),
          ]),
        }),
      ]),
    });
    await expect(
      api.audit.list({ runId: 'run_1', nodeId: 'node_1', gateId: 'gate_1' }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ id: expect.any(String) })],
    });
    await expect(
      api.audit.list({ runId: 'run_1', role: 'reviewer' }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ role: 'reviewer' })],
    });
    await expect(
      api.audit.list({ runId: 'run_1', role: 'qa' }),
    ).resolves.toMatchObject({
      events: [],
    });
    await expect(api.role.list()).resolves.toMatchObject({
      roles: [expect.objectContaining({ id: 'rd' })],
    });
    await expect(api.workflow.list()).resolves.toMatchObject({
      workflows: [expect.objectContaining({ id: 'project-feature' })],
    });

    await api.close();
  });

  it('role.list does NOT expose systemPrompt (security fix verified)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.role.list();

    expect(result.roles).toHaveLength(1);
    const rd = result.roles[0]!;
    expect(rd).toMatchObject({ id: 'rd', name: 'RD' });

    // SECURITY: systemPrompt must never be leaked through the read API.
    // The field is removed from the schema entirely, so the parsed output
    // must not contain it at all.
    expect(rd).not.toHaveProperty('systemPrompt');
    expect(rd.hasSystemPrompt).toBe(true);

    await api.close();
  });

  it('workflow.list returns workflow templates from .tekon/workflows/', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.workflow.list();

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      id: 'project-feature',
      name: 'Project Feature',
      path: expect.stringContaining('.tekon/workflows/project-feature.yaml'),
    });

    await api.close();
  });

  it('audit.list returns events with hash chain verification and supports nodeId/gateId/role filters', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Full list for run_1: verification passes and events carry hash chain fields
    const full = await api.audit.list({ runId: 'run_1' });
    expect(full.verification).toEqual({ valid: true });
    expect(full.events.length).toBeGreaterThanOrEqual(2);

    for (const event of full.events) {
      expect(event.hash).toEqual(expect.any(String));
      expect(event.hash.length).toBeGreaterThan(0);
      expect(event.id).toEqual(expect.any(String));
      expect(event.runId).toBe('run_1');
      expect(event.createdAt).toEqual(expect.any(String));
    }

    // The second event must reference the first event's hash as prevHash
    const [first, second] = full.events;
    expect(first!.prevHash).toBeNull();
    expect(second!.prevHash).toBe(first!.hash);

    // Filter by nodeId
    const byNode = await api.audit.list({
      runId: 'run_1',
      nodeId: 'node_1',
    });
    expect(byNode.events.length).toBeGreaterThanOrEqual(1);
    for (const event of byNode.events) {
      expect(event.nodeId).toBe('node_1');
    }

    // Filter by gateId
    const byGate = await api.audit.list({
      runId: 'run_1',
      gateId: 'gate_1',
    });
    expect(byGate.events.length).toBeGreaterThanOrEqual(1);
    for (const event of byGate.events) {
      expect(event.gateId).toBe('gate_1');
    }

    // Filter by role – matching
    const byRole = await api.audit.list({
      runId: 'run_1',
      role: 'reviewer',
    });
    expect(byRole.events.length).toBeGreaterThanOrEqual(1);
    for (const event of byRole.events) {
      expect(event.role).toBe('reviewer');
    }

    // Filter by role – non-matching returns empty
    const byMissingRole = await api.audit.list({
      runId: 'run_1',
      role: 'qa',
    });
    expect(byMissingRole.events).toEqual([]);

    // Combined nodeId + gateId filter
    const combined = await api.audit.list({
      runId: 'run_1',
      nodeId: 'node_1',
      gateId: 'gate_1',
    });
    expect(combined.events.length).toBeGreaterThanOrEqual(1);
    for (const event of combined.events) {
      expect(event.nodeId).toBe('node_1');
      expect(event.gateId).toBe('gate_1');
    }

    await api.close();
  });

  it('review.get returns aggregated review surface and respects maxContentChars truncation', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Full review surface for run_1 (default maxContentChars)
    const review = await api.review.get({ runId: 'run_1' });
    expect(review).toMatchObject({
      runId: 'run_1',
      workflowStatus: 'paused',
      demand: expect.objectContaining({
        id: 'demand_1',
        title: 'Add dashboard',
      }),
      readiness: expect.objectContaining({
        ready: false,
      }),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          id: 'artifact_1',
          content: expect.objectContaining({
            exists: true,
            truncated: false,
            content: expect.stringContaining('Review report body'),
          }),
        }),
      ]),
      gates: expect.arrayContaining([
        expect.objectContaining({
          id: 'gate_1',
          output: expect.objectContaining({
            exists: true,
            content: expect.stringContaining('human approval is required'),
          }),
        }),
      ]),
      delivery: expect.objectContaining({
        package: expect.objectContaining({
          exists: true,
          content: expect.stringContaining('PR Preparation'),
        }),
        prBody: expect.objectContaining({
          exists: true,
          content: expect.stringContaining('Add dashboard'),
        }),
      }),
      evidenceGroups: expect.any(Array),
      nextCommands: expect.any(Array),
    });

    // Truncated review: maxContentChars=5 must truncate all text previews
    const truncated = await api.review.get({
      runId: 'run_1',
      maxContentChars: 5,
    });

    // Artifact content must be truncated to at most 5 characters
    const truncatedArtifact = truncated.artifacts.find(
      (a) => a.id === 'artifact_1',
    );
    expect(truncatedArtifact).toBeDefined();
    expect(truncatedArtifact!.content.content.length).toBeLessThanOrEqual(5);
    expect(truncatedArtifact!.content.truncated).toBe(true);

    // Gate output must also be truncated
    const truncatedGate = truncated.gates.find((g) => g.id === 'gate_1');
    expect(truncatedGate).toBeDefined();
    expect(truncatedGate!.output).not.toBeNull();
    expect(truncatedGate!.output!.content.length).toBeLessThanOrEqual(5);
    expect(truncatedGate!.output!.truncated).toBe(true);

    // Delivery previews must also be truncated
    expect(truncated.delivery.prBody).not.toBeNull();
    expect(truncated.delivery.prBody!.content.length).toBeLessThanOrEqual(5);
    expect(truncated.delivery.prBody!.truncated).toBe(true);

    expect(truncated.delivery.package).not.toBeNull();
    expect(truncated.delivery.package!.content.length).toBeLessThanOrEqual(5);
    expect(truncated.delivery.package!.truncated).toBe(true);

    await api.close();
  });
});
