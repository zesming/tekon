import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { AdmissionLedger } from '../../src/client/lib/admission-ledger.js';
import { RunAdmissionController } from '../../src/client/hooks/use-run-admission.js';
import type { RpcProcedureMap } from '../../src/shared/rpc-contract.js';

type RunInput = RpcProcedureMap['project.run']['input'];
type RunResult = RpcProcedureMap['project.run']['output'];
type LookupResult = RpcProcedureMap['project.admission']['output'];
const REQUEST_ID = 'receipt-request-01';

function receipt(state: 'accepted' | 'recovery-required' = 'accepted'): RunResult {
  return {
    requestId: REQUEST_ID,
    replayed: false,
    admissionState: state,
    sessionId: 'session-receipt',
    jobId: 'job-receipt',
    run: {
      id: 'run-receipt', projectId: 'project-receipt', demandId: 'demand-receipt',
      demandTitle: null, provider: 'mock', status: 'running', currentNodeId: null,
      createdAt: '', updatedAt: '',
      filesState: state === 'accepted' ? 'ready' : 'recovery_required',
    },
  };
}

function setup() {
  const data = new Map<string, string>();
  const storage = {
    failWrites: false,
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.failWrites) throw new Error('private storage diagnostic');
      data.set(key, value);
    },
    removeItem(key: string) {
      if (this.failWrites) throw new Error('private storage diagnostic');
      data.delete(key);
    },
  };
  const ledger = new AdmissionLedger(() => storage);
  let runCalls = 0;
  let acceptedCalls = 0;
  const actions = {
    run: async (_input: RunInput): Promise<RunResult> => receipt(),
    lookup: async (): Promise<LookupResult> => ({ state: 'accepted', requestId: REQUEST_ID,
      runId: 'run-receipt', sessionId: 'session-receipt', filesState: 'ready' }),
    onAccepted: (_result: RunResult): void => {},
  };
  const controller = new RunAdmissionController({
    ledger,
    intent: async input => ({ scope: 'scope-receipt', ...(input.run
      ? { fingerprint: 'fingerprint-receipt', requestId: REQUEST_ID } : {}) }),
    run: async input => { runCalls++; return actions.run(input); },
    lookup: async () => actions.lookup(),
    onAccepted: result => { acceptedCalls++; actions.onAccepted(result); },
  });
  controller.setContext({ token: 'test-token', payload: { demandText: 'test demand', planDigest: 'plan' } });
  return { controller, actions, storage, ledger, counts: () => ({ runCalls, acceptedCalls }) };
}

function assertKnown(ctx: ReturnType<typeof setup>, state: 'accepted' | 'recovery-required') {
  const view = ctx.controller.snapshot;
  const record = view.records.find(item => item.requestId === REQUEST_ID);
  assert.equal(record?.state, state);
  assert.equal(record?.runId, 'run-receipt');
  assert.equal(record?.sessionId, 'session-receipt');
  assert.equal(view.outcome, null, 'a verified receipt is neither unknown nor not-created');
  assert.equal(view.planExpired, false);
  assert.equal(view.isPending, false);
}

function assertLocalWarning(ctx: ReturnType<typeof setup>) {
  const message = ctx.controller.snapshot.error?.message;
  assert.match(message ?? '', /^请求已受理/);
  assert.doesNotMatch(message ?? '', /已阻止创建|private|secret/);
}

describe('server admission receipts survive local follow-up failures', () => {
  for (const state of ['accepted', 'recovery-required'] as const) {
    it(`keeps the ${state} receipt when storage fails after POST`, async () => {
      const ctx = setup();
      ctx.actions.run = async () => {
        ctx.storage.failWrites = true;
        return receipt(state);
      };
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      assertKnown(ctx, state);
      assertLocalWarning(ctx);
      assert.equal(ctx.counts().runCalls, 1);
      assert.equal(ctx.counts().acceptedCalls, 0);
      assert.equal(ctx.ledger.list('scope-receipt')[0]?.requestId, REQUEST_ID);
    });
  }

  it('does not reinterpret navigation failure as failed admission or duplicate the POST', async () => {
    const ctx = setup();
    ctx.actions.onAccepted = () => { throw new Error('secret navigation detail'); };
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    assertKnown(ctx, 'accepted');
    assertLocalWarning(ctx);
    await ctx.controller.submit();
    assert.equal(ctx.counts().runCalls, 1);
    assertKnown(ctx, 'accepted');
  });

  it('keeps a lookup-confirmed acceptance when the original POST later rejects', async () => {
    const ctx = setup();
    let reject!: (error: Error) => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    ctx.actions.run = async () => {
      started();
      return new Promise<RunResult>((_resolve, fail) => { reject = fail; });
    };
    await ctx.controller.loadScope();
    const pending = ctx.controller.submit();
    await start;
    await ctx.controller.lookup(REQUEST_ID);
    reject(new Error('POST connection lost after server commit'));
    await pending;
    assertKnown(ctx, 'accepted');
    assert.equal(ctx.controller.snapshot.error, null);
    assert.equal(ctx.counts().runCalls, 1);
  });

  for (const state of ['accepted', 'recovery-required'] as const) {
    it(`keeps the ${state} lookup receipt when its ledger update fails`, async () => {
      const ctx = setup();
      ctx.actions.run = async () => { throw new Error('unknown POST outcome'); };
      await ctx.controller.loadScope();
      await ctx.controller.submit();
      assert.equal(ctx.controller.snapshot.outcome, 'unknown');
      ctx.actions.lookup = async () => {
        ctx.storage.failWrites = true;
        return { state, requestId: REQUEST_ID, runId: 'run-receipt', sessionId: 'session-receipt',
          filesState: state === 'accepted' ? 'ready' : 'recovery_required' };
      };
      await ctx.controller.lookup(REQUEST_ID);
      assertKnown(ctx, state);
      assertLocalWarning(ctx);
      assert.equal(ctx.controller.snapshot.checkingId, null);
    });
  }

  it('still blocks before dispatch when the initial ledger cannot be persisted', async () => {
    const ctx = setup();
    await ctx.controller.loadScope();
    ctx.storage.failWrites = true;
    await ctx.controller.submit();
    assert.equal(ctx.counts().runCalls, 0);
    assert.equal(ctx.controller.snapshot.outcome, 'not-created');
    assert.equal(ctx.controller.snapshot.records.length, 0);
  });

  it('retains uncertainty when no verified server receipt exists', async () => {
    const ctx = setup();
    ctx.actions.run = async () => { throw new Error('offline'); };
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    assert.equal(ctx.controller.snapshot.outcome, 'unknown');
    assert.equal(ctx.controller.snapshot.records[0]?.state, 'unknown');
    assert.equal(ctx.controller.snapshot.records[0]?.runId, undefined);
  });

  it('does not trust a response for another request', async () => {
    const ctx = setup();
    ctx.actions.run = async () => ({ ...receipt(), requestId: 'other-request-01' });
    await ctx.controller.loadScope();
    await ctx.controller.submit();
    assert.equal(ctx.controller.snapshot.outcome, 'unknown');
    assert.equal(ctx.controller.snapshot.records[0]?.runId, undefined);
    assert.equal(ctx.counts().acceptedCalls, 0);
  });
});
