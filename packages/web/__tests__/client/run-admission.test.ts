import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AdmissionLedger } from '../../src/client/lib/admission-ledger.js';
import {
  RunAdmissionController,
  type RunPayload,
} from '../../src/client/hooks/use-run-admission.js';
import { ApiClientError } from '../../src/client/lib/rpc-client.js';
import type { RpcProcedureMap } from '../../src/shared/rpc-contract.js';

type RunResult = RpcProcedureMap['project.run']['output'];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
const payload: RunPayload = {
  demandText: '私密需求正文',
  planDigest: 'digest-one',
};
const accepted = (
  requestId: string,
  state: 'accepted' | 'recovery-required' = 'accepted',
): RunResult => ({
  requestId,
  replayed: false,
  admissionState: state,
  sessionId: 'session-one',
  jobId: 'job-one',
  run: {
    id: 'run-one',
    projectId: 'project-one',
    demandId: 'demand-one',
    demandTitle: null,
    provider: 'mock',
    status: 'running',
    currentNodeId: null,
    createdAt: '',
    updatedAt: '',
  },
});
function setup(s = storage()) {
  const ledger = new AdmissionLedger(() => s);
  let counter = 0;
  let repository = 'repo-one';
  const intent = vi.fn(
    async (input: RpcProcedureMap['project.admissionIntent']['input']) => ({
      scope: `${repository}-${input.token === 'secret-A' ? 'A' : 'B'}`,
      ...(input.run
        ? {
            fingerprint: createHash('sha256')
              .update(JSON.stringify(input.run))
              .digest('hex'),
            requestId: `request-${++counter}`,
          }
        : {}),
    }),
  );
  const run = vi.fn(async (input: RpcProcedureMap['project.run']['input']) =>
    accepted(input.requestId!),
  );
  const lookup = vi.fn(
    async (
      input: RpcProcedureMap['project.admission']['input'],
    ): Promise<RpcProcedureMap['project.admission']['output']> => ({
      state: 'not-found',
      requestId: input.requestId,
    }),
  );
  const onAccepted = vi.fn();
  const controller = new RunAdmissionController({
    ledger,
    intent,
    run,
    lookup,
    onAccepted,
  });
  controller.setContext({ token: 'secret-A', payload });
  return {
    controller,
    ledger,
    intent,
    run,
    lookup,
    onAccepted,
    s,
    changeRepo: (value: string) => {
      repository = value;
    },
  };
}

describe('persistent admission identity and request lifetime', () => {
  it('writes only server scope/fingerprint/request identity before dispatch and blocks same-turn double submission', async () => {
    const ctx = setup();
    const pending = deferred<RunResult>();
    ctx.run.mockImplementationOnce(async (input) => {
      expect(ctx.ledger.list('repo-one-A')).toEqual([
        {
          scope: 'repo-one-A',
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          requestId: input.requestId,
          state: 'unknown',
        },
      ]);
      expect([...ctx.s.data.values()].join('')).not.toContain(
        payload.demandText,
      );
      expect([...ctx.s.data.values()].join('')).not.toContain('secret-A');
      return pending.promise;
    });
    await ctx.controller.loadScope();
    const first = ctx.controller.submit();
    const second = ctx.controller.submit();
    await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(1));
    pending.resolve(accepted('request-1'));
    await Promise.all([first, second]);
    expect(ctx.onAccepted).toHaveBeenCalledTimes(1);
    expect(ctx.ledger.list('repo-one-A')).toEqual([]);
  });

  it('retains an unknown request and reuses it after not-found, reload, and input A→B→A', async () => {
    const ctx = setup();
    ctx.run.mockRejectedValue(new Error('connection lost'));
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    const id = ctx.run.mock.calls[0][0].requestId!;
    await ctx.controller.lookup(id);
    expect(ctx.controller.snapshot.records[0]).toMatchObject({
      requestId: id,
      state: 'unknown',
      lookupState: 'not-found',
    });
    ctx.controller.setContext({
      token: 'secret-A',
      payload: { ...payload, demandText: 'B' },
    });
    ctx.controller.setContext({ token: 'secret-A', payload });
    await ctx.controller.submit();
    expect(ctx.run.mock.calls[1][0].requestId).toBe(id);
    const reloaded = setup(ctx.s);
    await reloaded.controller.loadScope();
    expect(reloaded.controller.snapshot.records[0].requestId).toBe(id);
    await reloaded.controller.submit();
    expect(reloaded.run.mock.calls[0][0].requestId).toBe(id);
  });

  it('explicit new intent creates another identity while preserving the old unknown record', async () => {
    const ctx = setup();
    ctx.run.mockRejectedValue(new Error('lost'));
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.controller.beginNew();
    await ctx.controller.submit();
    const records = ctx.ledger.list('repo-one-A');
    expect(records).toHaveLength(2);
    expect(records[0].requestId).not.toBe(records[1].requestId);
  });

  for (const change of ['input', 'token', 'unmount'] as const) {
    it(`does not dispatch a prepared request after ${change} changes during the intent RPC`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      const prepared =
        deferred<RpcProcedureMap['project.admissionIntent']['output']>();
      ctx.intent.mockImplementationOnce(() => prepared.promise);
      const submission = ctx.controller.submit();
      if (change === 'input')
        ctx.controller.setContext({
          token: 'secret-A',
          payload: { ...payload, demandText: 'new content' },
        });
      if (change === 'token')
        ctx.controller.setContext({ token: 'secret-B', payload });
      if (change === 'unmount') ctx.controller.deactivate();
      prepared.resolve({
        scope: 'repo-one-A',
        fingerprint: 'opaque-fp',
        requestId: 'request-old',
      });
      await submission;
      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.ledger.list('repo-one-A')).toEqual([]);
      expect(ctx.onAccepted).not.toHaveBeenCalled();
    });
  }

  it('captures the original payload before awaiting identity preparation', async () => {
    const ctx = setup();
    const mutable = { ...payload };
    ctx.controller.setContext({ token: 'secret-A', payload: mutable });
    await ctx.controller.loadScope();
    const submission = ctx.controller.submit();
    mutable.demandText = 'mutated outside React';
    await submission;
    expect(ctx.run.mock.calls[0][0].demandText).toBe(payload.demandText);
  });

  for (const outcome of ['success', 'error'] as const) {
    it(`preserves new input and old unknown identity after a late ${outcome}`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      const pending = deferred<RunResult>();
      ctx.run.mockReturnValueOnce(pending.promise);
      const first = ctx.controller.submit();
      await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(1));
      ctx.controller.setContext({
        token: 'secret-B',
        payload: { ...payload, demandText: 'new text' },
      });
      await ctx.controller.loadScope();
      if (outcome === 'success') pending.resolve(accepted('request-1'));
      else pending.reject(new Error('stale failure'));
      await first;
      expect(ctx.onAccepted).not.toHaveBeenCalled();
      expect(ctx.controller.snapshot.error).toBeNull();
      expect(ctx.controller.snapshot.records).toEqual([]);
      expect(ctx.ledger.list('repo-one-A')).toHaveLength(1);
    });
  }

  it('does not clear a newer submission lock when the old request settles', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    const old = deferred<RunResult>();
    const fresh = deferred<RunResult>();
    ctx.run.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = ctx.controller.submit();
    await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(1));
    ctx.controller.setContext({
      token: 'secret-A',
      payload: { ...payload, demandText: 'new text' },
    });
    const second = ctx.controller.submit();
    await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(2));
    old.resolve(accepted('request-1'));
    await first;
    expect(ctx.controller.snapshot.isPending).toBe(true);
    fresh.resolve(accepted('request-2'));
    await second;
    expect(ctx.controller.snapshot.isPending).toBe(false);
    expect(ctx.onAccepted).toHaveBeenCalledTimes(1);
  });

  it('scope-only lookup restores records without old demand text and isolates repository switches', async () => {
    const ctx = setup();
    ctx.ledger.upsert({
      scope: 'repo-one-A',
      fingerprint: 'server-hash',
      requestId: 'request-old',
      state: 'unknown',
    });
    ctx.controller.setContext({
      token: 'secret-A',
      payload: { demandText: '' },
    });
    await ctx.controller.loadScope();
    expect(ctx.intent.mock.calls[0][0]).toEqual({ token: 'secret-A' });
    expect(ctx.controller.snapshot.records).toHaveLength(1);
    ctx.changeRepo('repo-two');
    await ctx.controller.loadScope();
    expect(ctx.controller.snapshot.records).toEqual([]);
    expect(ctx.ledger.list('repo-one-A')).toHaveLength(1);
  });

  it('shows accepted lookup observation identities before clearing its persistent pending record', async () => {
    const ctx = setup();
    ctx.ledger.upsert({
      scope: 'repo-one-A',
      fingerprint: 'server-hash',
      requestId: 'request-old',
      state: 'unknown',
    });
    await ctx.controller.loadScope();
    ctx.lookup.mockResolvedValueOnce({
      state: 'accepted',
      requestId: 'request-old',
      runId: 'run-old',
      sessionId: 'session-old',
      filesState: 'ready',
    });
    await ctx.controller.lookup('request-old');
    expect(ctx.ledger.list('repo-one-A')).toEqual([]);
    expect(ctx.controller.snapshot.records[0]).toMatchObject({
      state: 'accepted',
      runId: 'run-old',
      sessionId: 'session-old',
    });
  });

  it('keeps recovery-required identities for observation and same-payload retry', async () => {
    const ctx = setup();
    ctx.run.mockImplementationOnce(async (input) =>
      accepted(input.requestId!, 'recovery-required'),
    );
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    const id = ctx.run.mock.calls[0][0].requestId!;
    expect(ctx.controller.snapshot.records[0]).toMatchObject({
      state: 'recovery-required',
      sessionId: 'session-one',
      runId: 'run-one',
    });
    expect(ctx.onAccepted).not.toHaveBeenCalled();
    await ctx.controller.submit();
    expect(ctx.run.mock.calls[1][0].requestId).toBe(id);
  });

  for (const lateState of ['not-found', 'recovery-required'] as const) {
    it(`keeps POST accepted monotonic when an older lookup returns ${lateState}`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      const post = deferred<RunResult>();
      const lookup = deferred<RpcProcedureMap['project.admission']['output']>();
      ctx.run.mockReturnValueOnce(post.promise);
      ctx.lookup.mockReturnValueOnce(lookup.promise);
      const submitting = ctx.controller.submit();
      await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(1));
      const requestId = ctx.run.mock.calls[0][0].requestId!;
      const checking = ctx.controller.lookup(requestId);
      post.resolve(accepted(requestId));
      await submitting;
      expect(ctx.ledger.list('repo-one-A')).toEqual([]);
      lookup.resolve(
        lateState === 'not-found'
          ? { state: 'not-found', requestId }
          : {
              state: 'recovery-required',
              requestId,
              runId: 'old-run',
              sessionId: 'old-session',
              filesState: 'recovery_required',
            },
      );
      await checking;
      expect(ctx.controller.snapshot.records).toEqual([
        expect.objectContaining({
          requestId,
          state: 'accepted',
          runId: 'run-one',
          sessionId: 'session-one',
        }),
      ]);
      expect(ctx.ledger.list('repo-one-A')).toEqual([]);
      const reloaded = setup(ctx.s);
      await reloaded.controller.loadScope();
      expect(reloaded.controller.snapshot.records).toEqual([]);
    });
  }

  it('does not recreate a pending disk record when the same accepted intent is activated again', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    await ctx.controller.submit();
    expect(ctx.ledger.list('repo-one-A')).toEqual([]);
    expect(ctx.run).toHaveBeenCalledTimes(1);
    expect(ctx.controller.snapshot.records[0]).toMatchObject({
      state: 'accepted',
      runId: 'run-one',
      sessionId: 'session-one',
    });
  });

  it('reports expired plans and refreshes without auto-submitting', async () => {
    const ctx = setup();
    ctx.run.mockRejectedValueOnce(
      new ApiClientError('BAD_REQUEST', 'PLAN_DIGEST_MISMATCH: changed'),
    );
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    expect(ctx.controller.snapshot.planExpired).toBe(true);
    const refetch = vi.fn();
    ctx.controller.refreshPlan(refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(ctx.run).toHaveBeenCalledTimes(1);
    ctx.controller.setContext({
      token: 'secret-A',
      payload: { ...payload, planDigest: 'digest-new' },
    });
    await ctx.controller.submit();
    expect(ctx.run.mock.calls[1][0].requestId).not.toBe(
      ctx.run.mock.calls[0][0].requestId,
    );
  });
});

describe('admission ledger storage boundary', () => {
  it('persists only validated identity fields, never demand or credentials', () => {
    const s = storage();
    const ledger = new AdmissionLedger(() => s);
    const recordWithSecrets = {
      scope: 'server-scope',
      fingerprint: 'server-fingerprint',
      requestId: 'request-123',
      state: 'unknown' as const,
      token: 'secret-A',
      demandText: payload.demandText,
    };
    ledger.upsert(recordWithSecrets);
    const serialized = [...s.data.values()].join('');
    expect(JSON.parse(serialized)).toEqual([
      {
        scope: 'server-scope',
        fingerprint: 'server-fingerprint',
        requestId: 'request-123',
        state: 'unknown',
      },
    ]);
    expect(serialized).not.toContain('secret-A');
    expect(serialized).not.toContain(payload.demandText);
  });

  for (const failure of ['read', 'write', 'corrupt'] as const) {
    it(`blocks Run dispatch when sessionStorage has a ${failure} failure`, async () => {
      const ctx = setup();
      if (failure === 'read')
        ctx.s.getItem = () => {
          throw new Error('denied');
        };
      if (failure === 'write')
        ctx.s.setItem = () => {
          throw new Error('quota');
        };
      if (failure === 'corrupt') ctx.s.getItem = () => '{bad json';
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.controller.snapshot.error?.message).toContain(
        '浏览器会话存储',
      );
    });
  }
});
