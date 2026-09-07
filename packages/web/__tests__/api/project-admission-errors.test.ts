import { RunAdmissionError } from '@tekon/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createProjectContext } from '../../src/server/project-context.js';
import { createProjectRouter } from '../../src/server/api/routers/project.js';
import { ApiError } from '../../src/server/api/errors.js';
import type { ServerContext } from '../../src/server/api/context.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

async function setup() {
  const fixture = await createWebFixtureProject();
  cleanup.push(fixture.cleanup);
  const lookupRun = vi.fn();
  const startRun = vi.fn();
  const router = createProjectRouter({
    projectContext: createProjectContext({ projectRoot: fixture.projectRoot }),
    sessionService: { lookupRun, startRun },
  } as unknown as ServerContext);
  const input = { token: fixture.sessionToken, requestId: 'router-error-01',
    mode: 'goal' as const, agent: 'mock' as const, allowDirtyBase: true, demandText: '分类错误' };
  return { router, input, lookupRun, startRun };
}

describe('受理边界错误分类与身份映射', () => {
  it('提交前的可信Provider拒绝保留400分类及用户指引', async () => {
    const { router, input, lookupRun, startRun } = await setup();
    lookupRun.mockResolvedValue(null);
    startRun.mockRejectedValue(new RunAdmissionError(input.requestId,
      new ApiError('BAD_REQUEST', 'Provider配置无效，请重新配置后重试')));
    await expect(router.run(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST', message: expect.stringContaining('Provider配置无效'),
    });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('初查失败后二查才发现持久赢家，恢复错误保留其全部身份并脱敏', async () => {
    const { router, input, lookupRun, startRun } = await setup();
    lookupRun.mockRejectedValueOnce(new Error('initial database unavailable'))
      .mockRejectedValueOnce(new RunAdmissionError(input.requestId, new Error('PRIVATE_DB_SENTINEL'), {
        runId: 'run_persisted', sessionId: 'sess_persisted', jobId: 'job_persisted', filesState: 'pending',
      }));
    let failure: unknown;
    try { await router.run(input); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' });
    const message = (failure as Error).message;
    for (const value of [input.requestId, 'run_persisted', 'sess_persisted', 'job_persisted', 'recovery-required']) {
      expect(message).toContain(value);
    }
    expect(message).not.toContain('PRIVATE_DB_SENTINEL');
    expect(lookupRun).toHaveBeenCalledTimes(2);
    expect(startRun).not.toHaveBeenCalled();
  });
});
