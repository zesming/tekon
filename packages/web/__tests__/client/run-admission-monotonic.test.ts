import { describe, expect, it, vi } from 'vitest';
import { AdmissionLedger } from '../../src/client/lib/admission-ledger.js';
import { RunAdmissionController } from '../../src/client/hooks/use-run-admission.js';
import type { RpcProcedureMap } from '../../src/shared/rpc-contract.js';

type RunInput = RpcProcedureMap['project.run']['input'];
type RunResult = RpcProcedureMap['project.run']['output'];
type LookupResult = RpcProcedureMap['project.admission']['output'];
type FilesState = 'pending' | 'recovery_required' | 'ready';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function receipt(
  requestId: string,
  filesState: FilesState = 'recovery_required',
): RunResult {
  return {
    requestId,
    replayed: false,
    admissionState: filesState === 'ready' ? 'accepted' : 'recovery-required',
    sessionId: `session-${requestId}`,
    jobId: `job-${requestId}`,
    run: {
      id: `run-${requestId}`,
      projectId: 'project',
      demandId: 'demand',
      demandTitle: null,
      provider: 'mock',
      status: 'running',
      currentNodeId: null,
      createdAt: '',
      updatedAt: '',
      filesState,
    },
  };
}

function setup() {
  let scope = 'scope-A';
  let nextId = 0;
  const data = new Map<string, string>();
  const storage = {
    fail: '' as '' | 'get' | 'set' | 'remove',
    getItem(key: string) {
      if (this.fail === 'get') throw new Error('private storage detail');
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (this.fail === 'set') throw new Error('private storage detail');
      data.set(key, value);
    },
    removeItem(key: string) {
      if (this.fail === 'remove') throw new Error('private storage detail');
      data.delete(key);
    },
  };
  const ledger = new AdmissionLedger(() => storage);
  const intent = vi.fn(
    async (input: RpcProcedureMap['project.admissionIntent']['input']) => ({
      scope,
      ...(input.run
        ? {
            fingerprint: `fp-${input.run.demandText}`,
            requestId: `request-${++nextId}`,
          }
        : {}),
    }),
  );
  const run = vi.fn(
    async (input: RunInput): Promise<RunResult> => receipt(input.requestId!),
  );
  const lookup = vi.fn(
    async (
      input: RpcProcedureMap['project.admission']['input'],
    ): Promise<LookupResult> => ({
      state: 'not-found',
      requestId: input.requestId,
    }),
  );
  const onAccepted = vi.fn((_result: RunResult): void | Promise<void> => {});
  const controller = new RunAdmissionController({
    ledger,
    intent,
    run,
    lookup,
    onAccepted,
  });
  const edit = (demandText: string, token = 'token-A') =>
    controller.setContext({
      token,
      payload: { demandText, planDigest: 'plan' },
    });
  edit('A');
  return {
    controller,
    ledger,
    storage,
    run,
    lookup,
    intent,
    onAccepted,
    edit,
    setScope: (value: string) => {
      scope = value;
    },
  };
}

function expectKnown(
  ctx: ReturnType<typeof setup>,
  requestId: string,
  filesState: FilesState = 'recovery_required',
) {
  expect(
    ctx.controller.snapshot.records.find(
      (record) => record.requestId === requestId,
    ),
  ).toMatchObject({
    state: filesState === 'ready' ? 'accepted' : 'recovery-required',
    runId: `run-${requestId}`,
    sessionId: `session-${requestId}`,
    filesState,
  });
}

describe('confirmed receipt merges and recovery retries', () => {
  for (const lateState of ['not-found', 'pending'] as const) {
    it(`ignores an older ${lateState} lookup after a POST recovery receipt`, async () => {
      const ctx = setup();
      const post = deferred<RunResult>();
      const get = deferred<LookupResult>();
      ctx.run.mockReturnValueOnce(post.promise);
      ctx.lookup.mockReturnValueOnce(get.promise);
      await ctx.controller.loadScope();
      const submitting = ctx.controller.submit();
      await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledOnce());
      const checking = ctx.controller.lookup('request-1');
      post.resolve(receipt('request-1'));
      await submitting;
      get.resolve(
        lateState === 'not-found'
          ? { state: 'not-found', requestId: 'request-1' }
          : {
              state: 'recovery-required',
              requestId: 'request-1',
              runId: 'run-request-1',
              sessionId: 'session-request-1',
              filesState: 'pending',
            },
      );
      await checking;
      expectKnown(ctx, 'request-1');
      expect(ctx.controller.snapshot.outcome).toBeNull();
      expect(ctx.controller.snapshot.checkingId).toBeNull();
    });
  }

  it('keeps a recovery receipt during retry and after transport failure, then upgrades the original request', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    const retry = deferred<RunResult>();
    ctx.run.mockReturnValueOnce(retry.promise);
    const submitting = ctx.controller.submit();
    await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(2));
    expectKnown(ctx, 'request-1');
    expect(ctx.ledger.list('scope-A')[0].state).toBe('recovery-required');
    retry.reject(new Error('retry transport lost'));
    await submitting;
    expectKnown(ctx, 'request-1');
    expect(ctx.controller.snapshot.outcome).toBeNull();
    expect(ctx.controller.snapshot.error?.message ?? '').not.toContain(
      '浏览器',
    );
    ctx.run.mockResolvedValueOnce(receipt('request-1', 'ready'));
    await ctx.controller.submit();
    expect(ctx.run.mock.calls.map(([input]) => input.requestId)).toEqual([
      'request-1',
      'request-1',
      'request-1',
    ]);
    expectKnown(ctx, 'request-1', 'ready');
    expect(ctx.ledger.list('scope-A')).toEqual([]);
    expect(ctx.onAccepted).toHaveBeenCalledOnce();
  });

  it('accepts later recovery directory updates and ready, even when ready comes from an older lookup', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.lookup.mockResolvedValueOnce({
      state: 'recovery-required',
      requestId: 'request-1',
      runId: 'run-request-1',
      filesState: 'pending',
    });
    await ctx.controller.lookup('request-1');
    expectKnown(ctx, 'request-1', 'pending');
    const get = deferred<LookupResult>();
    ctx.lookup.mockReturnValueOnce(get.promise);
    const checking = ctx.controller.lookup('request-1');
    await ctx.controller.submit();
    expectKnown(ctx, 'request-1');
    get.resolve({
      state: 'accepted',
      requestId: 'request-1',
      runId: 'run-request-1',
      sessionId: 'session-request-1',
      filesState: 'ready',
    });
    await checking;
    expectKnown(ctx, 'request-1', 'ready');
  });

  for (const filesState of ['ready', 'recovery_required'] as const) {
    it(`preserves ${filesState} identities when reloading the same scope`, async () => {
      const ctx = setup();
      ctx.run.mockResolvedValueOnce(receipt('request-1', filesState));
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      await ctx.controller.loadScope();
      expectKnown(ctx, 'request-1', filesState);
    });
  }

  it('merges stale accepted disk identity with another unknown request without dropping either', async () => {
    const ctx = setup();
    ctx.run.mockImplementationOnce(async () => {
      ctx.storage.fail = 'remove';
      return receipt('request-1', 'ready');
    });
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.storage.fail = '';
    ctx.edit('B');
    ctx.run.mockRejectedValueOnce(new Error('B is unknown'));
    await ctx.controller.submit();
    expectKnown(ctx, 'request-1', 'ready');
    expect(
      ctx.controller.snapshot.records.find(
        (record) => record.requestId === 'request-2',
      ),
    ).toMatchObject({ state: 'unknown' });
    await ctx.controller.loadScope();
    expectKnown(ctx, 'request-1', 'ready');
    expect(ctx.controller.snapshot.records).toHaveLength(2);
  });

  it('keeps confirmed recovery on the first retry ledger read failure, before another POST', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.storage.fail = 'get';
    await ctx.controller.submit();
    expectKnown(ctx, 'request-1');
    expect(ctx.run).toHaveBeenCalledOnce();
    expect(ctx.controller.snapshot.outcome).toBeNull();
    expect(ctx.controller.snapshot.error?.message).toMatch(/^请求已受理/);
  });

  it('does not borrow a prior receipt when another intent fails its first ledger read', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.edit('B');
    ctx.storage.fail = 'get';
    await ctx.controller.submit();
    expectKnown(ctx, 'request-1');
    expect(ctx.controller.snapshot.outcome).toBe('not-created');
    expect(ctx.run).toHaveBeenCalledOnce();
  });

  for (const failure of ['ledger', 'intent'] as const) {
    it(`clears the original unknown request's retry ${failure} error when its lookup confirms admission`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      ctx.run.mockRejectedValueOnce(new Error('original POST transport lost'));
      await ctx.controller.submit();
      expect(ctx.controller.snapshot.outcome).toBe('unknown');
      if (failure === 'ledger') ctx.storage.fail = 'get';
      else ctx.intent.mockRejectedValueOnce(new Error('retry intent offline'));
      await ctx.controller.submit();
      expect(ctx.controller.snapshot.error).not.toBeNull();
      expect(ctx.controller.snapshot.outcome).toBe('not-created');
      expect(ctx.run).toHaveBeenCalledOnce();
      ctx.storage.fail = '';
      ctx.lookup.mockResolvedValueOnce({
        state: 'accepted',
        requestId: 'request-1',
        runId: 'run-request-1',
        sessionId: 'session-request-1',
        filesState: 'ready',
      });
      await ctx.controller.lookup('request-1');
      expectKnown(ctx, 'request-1', 'ready');
      expect(ctx.controller.snapshot.error).toBeNull();
      expect(ctx.controller.snapshot.outcome).toBeNull();
      expect(ctx.run).toHaveBeenCalledOnce();
    });
  }

  for (const surface of ['submit', 'scope'] as const) {
    it(`fails closed on a known request fingerprint conflict during ${surface}`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      ctx.ledger.upsert({
        scope: 'scope-A',
        requestId: 'request-1',
        fingerprint: 'fp-B',
        state: 'unknown',
      });
      if (surface === 'submit') {
        ctx.edit('B');
        await ctx.controller.submit();
      } else await ctx.controller.loadScope();
      expectKnown(ctx, 'request-1');
      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.controller.snapshot.error?.message).toContain('冲突');
      expect(ctx.controller.snapshot.error?.message).not.toContain('fp-');
    });
  }

  it('isolates the old scope before a new scope ledger read fails, including an outstanding lookup', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    const get = deferred<LookupResult>();
    ctx.lookup.mockReturnValueOnce(get.promise);
    const checking = ctx.controller.lookup('request-1');
    ctx.setScope('scope-B');
    ctx.storage.fail = 'get';
    await ctx.controller.loadScope();
    expect(ctx.controller.snapshot.records).toEqual([]);
    expect(ctx.controller.snapshot.scopeReady).toBe(false);
    expect(ctx.controller.snapshot.checkingId).toBeNull();
    get.resolve({
      state: 'accepted',
      requestId: 'request-1',
      runId: 'run-request-1',
      filesState: 'ready',
    });
    await checking;
    await ctx.controller.lookup('request-1');
    expect(ctx.lookup).toHaveBeenCalledOnce();
    expect(ctx.controller.snapshot.records).toEqual([]);
    expect(ctx.controller.snapshot.error?.message).toContain('浏览器');
  });

  it('isolates a scope change first discovered by the submission intent', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.setScope('scope-B');
    await ctx.controller.submit();
    expect(ctx.run).toHaveBeenCalledOnce();
    expect(ctx.controller.snapshot.records).toEqual([]);
    expect(ctx.controller.snapshot.scopeReady).toBe(false);
    expect(ctx.controller.snapshot.error?.message).toContain('仓库');
    await ctx.controller.lookup('request-1');
    expect(ctx.lookup).not.toHaveBeenCalled();
  });

  it('cannot restore an old scope from a late scope response after submission discovers a new one', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    const old =
      deferred<RpcProcedureMap['project.admissionIntent']['output']>();
    ctx.intent.mockReturnValueOnce(old.promise);
    const loading = ctx.controller.loadScope();
    ctx.setScope('scope-B');
    await ctx.controller.submit();
    old.resolve({ scope: 'scope-A' });
    await loading;
    expect(ctx.controller.snapshot.records).toEqual([]);
    expect(ctx.controller.snapshot.scopeReady).toBe(false);
    expect(ctx.controller.snapshot.error?.message).toContain('仓库');
    expect(ctx.run).toHaveBeenCalledOnce();
  });

  for (const field of ['runId', 'sessionId'] as const) {
    it(`preserves the first receipt when a later response conflicts on ${field}`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      ctx.lookup.mockResolvedValueOnce({
        state: 'accepted',
        requestId: 'request-1',
        runId: 'run-request-1',
        sessionId: 'session-request-1',
        filesState: 'ready',
        [field]: 'different-private-identity',
      });
      await ctx.controller.lookup('request-1');
      expectKnown(ctx, 'request-1');
      expect(ctx.controller.snapshot.error?.message).toContain('冲突');
      expect(ctx.controller.snapshot.error?.message).not.toContain('private');
      expect(ctx.ledger.list('scope-A')).toHaveLength(1);
    });
  }

  it('allows explicit new intent with the same fingerprint without lending its prior receipt', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    ctx.controller.beginNew();
    ctx.run.mockRejectedValueOnce(new Error('new request transport lost'));
    await ctx.controller.submit();
    expect(ctx.run.mock.calls.map(([input]) => input.requestId)).toEqual([
      'request-1',
      'request-2',
    ]);
    expectKnown(ctx, 'request-1');
    expect(
      ctx.controller.snapshot.records.find(
        (record) => record.requestId === 'request-2',
      ),
    ).toMatchObject({ state: 'unknown' });
    expect(ctx.controller.snapshot.outcome).toBe('unknown');
  });

  for (const result of ['success', 'error'] as const) {
    it(`querying confirmed A does not erase unknown B's error on ${result}`, async () => {
      const ctx = setup();
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      ctx.edit('B');
      ctx.run.mockRejectedValueOnce(new Error('B transport lost'));
      await ctx.controller.submit();
      const error = ctx.controller.snapshot.error;
      const get = deferred<LookupResult>();
      ctx.lookup.mockReturnValueOnce(get.promise);
      const checking = ctx.controller.lookup('request-1');
      expect(ctx.controller.snapshot.error).toBe(error);
      expect(ctx.controller.snapshot.outcome).toBe('unknown');
      if (result === 'error') get.reject(new Error('A lookup lost'));
      else
        get.resolve({
          state: 'accepted',
          requestId: 'request-1',
          runId: 'run-request-1',
          sessionId: 'session-request-1',
          filesState: 'ready',
        });
      await checking;
      expect(ctx.controller.snapshot.error).toBe(error);
      expect(ctx.controller.snapshot.outcome).toBe('unknown');
      expectKnown(
        ctx,
        'request-1',
        result === 'success' ? 'ready' : 'recovery_required',
      );
    });
  }

  it('does not retag B lookup errors when confirmed A ignores its late POST failure', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    ctx.edit('B');
    ctx.run.mockRejectedValueOnce(new Error('B original POST unknown'));
    await ctx.controller.submit();
    ctx.edit('A');
    const postA = deferred<RunResult>();
    ctx.run.mockReturnValueOnce(postA.promise);
    const submittingA = ctx.controller.submit();
    await vi.waitFor(() => expect(ctx.run).toHaveBeenCalledTimes(2));
    ctx.lookup.mockResolvedValueOnce({
      state: 'accepted',
      requestId: 'request-2',
      runId: 'run-request-2',
      sessionId: 'session-request-2',
      filesState: 'ready',
    });
    await ctx.controller.lookup('request-2');
    const bError = new Error('B lookup network failure');
    ctx.lookup.mockRejectedValueOnce(bError);
    await ctx.controller.lookup('request-1');
    expect(ctx.controller.snapshot.error).toBe(bError);
    postA.reject(new Error('A late POST transport failure'));
    await submittingA;
    expectKnown(ctx, 'request-2', 'ready');
    expect(ctx.controller.snapshot.error).toBe(bError);
    ctx.lookup.mockResolvedValueOnce({
      state: 'accepted',
      requestId: 'request-1',
      runId: 'run-request-1',
      sessionId: 'session-request-1',
      filesState: 'ready',
    });
    await ctx.controller.lookup('request-1');
    expectKnown(ctx, 'request-1', 'ready');
    expect(ctx.controller.snapshot.error).toBeNull();
    expect(ctx.controller.snapshot.outcome).toBeNull();
    expect(ctx.run).toHaveBeenCalledTimes(2);
  });

  for (const surface of ['post', 'lookup'] as const) {
    // The original receipt suite already covers accepted remove and recovery set.
    for (const [filesState, fail] of [
      ['ready', 'get'],
      ['ready', 'set'],
      ['recovery_required', 'get'],
    ] as const) {
      it(`${surface} ${filesState} receipt survives ${fail} failure with its real ledger write path`, async () => {
        const ctx = setup();
        if (fail === 'set')
          ctx.ledger.upsert({
            scope: 'scope-A',
            requestId: 'older-unknown',
            fingerprint: 'older',
            state: 'unknown',
          });
        await ctx.controller.loadScope();
        if (surface === 'post')
          ctx.run.mockImplementationOnce(async () => {
            ctx.storage.fail = fail;
            return receipt('request-1', filesState);
          });
        else ctx.run.mockRejectedValueOnce(new Error('transport lost'));
        await ctx.controller.submit();
        if (surface === 'lookup') {
          ctx.lookup.mockImplementationOnce(async () => {
            ctx.storage.fail = fail;
            return {
              state: filesState === 'ready' ? 'accepted' : 'recovery-required',
              requestId: 'request-1',
              runId: 'run-request-1',
              sessionId: 'session-request-1',
              filesState,
            };
          });
          await ctx.controller.lookup('request-1');
        }
        expectKnown(ctx, 'request-1', filesState);
        expect(ctx.controller.snapshot.outcome).toBeNull();
        expect(ctx.controller.snapshot.error?.message).toMatch(/^请求已受理/);
        expect(ctx.controller.snapshot.error?.message).not.toContain('private');
        expect(ctx.run).toHaveBeenCalledOnce();
      });
    }
  }

  for (const phase of ['scope', 'intent'] as const) {
    it(`does not dispatch or manufacture acceptance after ${phase} network failure`, async () => {
      const ctx = setup();
      if (phase === 'intent') await ctx.controller.loadScope();
      ctx.intent.mockRejectedValueOnce(new Error('identity service offline'));
      await ctx.controller.submit();
      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.controller.snapshot.records).toEqual([]);
      expect(ctx.controller.snapshot.outcome).not.toBe('unknown');
      expect(ctx.controller.snapshot.error?.message).toContain('offline');
    });
  }
});

describe('asynchronous accepted follow-up ownership', () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`holds the same intent lock until callback ${outcome} and handles its result`, async () => {
      const ctx = setup();
      const callback = deferred<void>();
      // A test-local observer keeps the pre-fix rejection from polluting other tests.
      // Only the controller can produce the expected warning and pending lifetime.
      void callback.promise.catch(() => {});
      ctx.onAccepted.mockReturnValueOnce(callback.promise);
      ctx.run.mockResolvedValueOnce(receipt('request-1', 'ready'));
      await ctx.controller.loadScope();
      const submitting = ctx.controller.submit();
      await vi.waitFor(() => expect(ctx.onAccepted).toHaveBeenCalledOnce());
      const wasPending = ctx.controller.snapshot.isPending;
      await ctx.controller.submit();
      if (outcome === 'reject')
        callback.reject(new Error('private async navigation'));
      else callback.resolve();
      await submitting;
      expect(wasPending).toBe(true);
      expect(ctx.controller.snapshot.isPending).toBe(false);
      expectKnown(ctx, 'request-1', 'ready');
      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.onAccepted).toHaveBeenCalledOnce();
      if (outcome === 'reject')
        expect(ctx.controller.snapshot.error?.message).toMatch(/^请求已受理/);
      else expect(ctx.controller.snapshot.error).toBeNull();
    });
  }

  for (const change of ['input', 'new', 'token', 'unmount'] as const) {
    it(`does not publish an old callback rejection after ${change}`, async () => {
      const ctx = setup();
      const callback = deferred<void>();
      void callback.promise.catch(() => {});
      ctx.onAccepted.mockReturnValueOnce(callback.promise);
      ctx.run.mockResolvedValueOnce(receipt('request-1', 'ready'));
      await ctx.controller.loadScope();
      const submitting = ctx.controller.submit();
      await vi.waitFor(() => expect(ctx.onAccepted).toHaveBeenCalledOnce());
      if (change === 'input') ctx.edit('B');
      if (change === 'new') ctx.controller.beginNew();
      if (change === 'token') ctx.edit('B', 'token-B');
      if (change === 'unmount') ctx.controller.deactivate();
      callback.reject(new Error('stale callback failure'));
      await submitting;
      expect(ctx.controller.snapshot.error).toBeNull();
      expect(ctx.controller.snapshot.outcome).toBeNull();
      expect(ctx.onAccepted).toHaveBeenCalledOnce();
    });
  }
});
