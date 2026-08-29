import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('project.run unrestricted network verification (P1-SEC-01)', () => {
  it('hard-rejects dsh-headless run when unrestricted network is not acknowledged', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'test dsh unacknowledged',
        token: fixture.sessionToken,
        agent: 'dsh-headless',
        mode: 'goal',
      }),
    ).rejects.toThrow('联网不受限需知情确认');
  });

  it('admits dsh-headless run when unrestricted network is explicitly acknowledged', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'test dsh acknowledged',
      token: fixture.sessionToken,
      agent: 'dsh-headless',
      mode: 'goal',
      acknowledgeUnrestrictedNetwork: true,
    });

    expect(result.sessionId).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.run.status).toBe('running');

    // Verify audit contains the network acknowledgment event
    const auditRes = await api.audit.list({ runId: result.run.id });
    const netAckEvent = auditRes.events.find(
      (e) => e.type === 'run.network-acknowledged',
    );
    expect(netAckEvent).toBeDefined();
    expect(netAckEvent?.payload).toMatchObject({
      agent: 'dsh-headless',
      acknowledgeUnrestrictedNetwork: true,
    });
  });

  it('admits codex run without unrestricted network acknowledgment', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'test codex normal run',
      token: fixture.sessionToken,
      agent: 'codex',
      mode: 'goal',
    });

    expect(result.sessionId).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.run.status).toBe('running');
  });
  it("does not record run.network-acknowledged audit for codex even if acknowledgedNetwork flag is passed", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: "test codex with ack flag",
      token: fixture.sessionToken,
      agent: "codex",
      mode: "goal",
      acknowledgeUnrestrictedNetwork: true,
    });

    const auditRes = await api.audit.list({ runId: result.run.id });
    const netAckEvent = auditRes.events.find(
      (e) => e.type === "run.network-acknowledged",
    );
    expect(netAckEvent).toBeUndefined();
  });
});
