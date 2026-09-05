import { useEffect, useRef, useState } from 'react';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';
import {
  AdmissionLedger,
  type AdmissionRecord,
} from '../lib/admission-ledger.js';
import { queryCache } from '../lib/query-cache.js';
import { ApiClientError, rpc } from '../lib/rpc-client.js';

export type RunPayload = Omit<
  RpcProcedureMap['project.run']['input'],
  'token' | 'requestId'
>;
type RunResult = RpcProcedureMap['project.run']['output'];
type IntentResult = RpcProcedureMap['project.admissionIntent']['output'];
type LookupResult = RpcProcedureMap['project.admission']['output'];
export interface AdmissionView extends Omit<AdmissionRecord, 'state'> {
  state: AdmissionRecord['state'] | 'accepted';
  lookupState?: 'not-found';
  runId?: string;
  sessionId?: string;
  /** 来自当前服务端响应，仅保留在内存；持久账本仍只保存请求身份。 */
  filesState?: RunResult['run']['filesState'];
}
interface Snapshot {
  isPending: boolean;
  scopeReady: boolean;
  error: Error | null;
  planExpired: boolean;
  records: AdmissionView[];
  checkingId: string | null;
  outcome: 'not-created' | 'unknown' | null;
  newIntent: boolean;
}
interface Options {
  ledger: AdmissionLedger;
  intent: (
    input: RpcProcedureMap['project.admissionIntent']['input'],
  ) => Promise<IntentResult>;
  run: (input: RpcProcedureMap['project.run']['input']) => Promise<RunResult>;
  lookup: (
    input: RpcProcedureMap['project.admission']['input'],
  ) => Promise<LookupResult>;
  onAccepted: (result: RunResult) => void | Promise<void>;
}
const LOCAL_RECEIPT_ERROR =
  '请求已受理，但浏览器请求记录更新或页面跳转未完成。请通过下方入口观察原运行，不要重复新建。';
class AdmissionIdentityConflict extends Error {
  constructor() {
    super(
      '浏览器请求记录与已确认身份冲突，已停止本次操作。请保留记录并观察原运行，恢复请求记录后再重试。',
    );
  }
}
type RequestIdentity = Pick<
  AdmissionRecord,
  'scope' | 'requestId' | 'fingerprint'
>;
const requestKey = (record: RequestIdentity) =>
  JSON.stringify([record.scope, record.requestId]);
const errorKey = (record: RequestIdentity) =>
  JSON.stringify([record.scope, record.requestId, record.fingerprint]);

const emptySnapshot = (): Snapshot => ({
  isPending: false,
  scopeReady: false,
  error: null,
  planExpired: false,
  records: [],
  checkingId: null,
  outcome: null,
  newIntent: false,
});

// Equality here only revokes local intent ownership; the server independently
// computes the persisted envelope fingerprint from its authoritative normalizer.
function payloadKey(payload: RunPayload): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(payload)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/** Shared submission state machine, also exercised without mocking React. */
export class RunAdmissionController {
  snapshot = emptySnapshot();
  private token: string | null = null;
  private payload: RunPayload = { demandText: '' };
  private contextKey = '';
  private epoch = 0;
  private authEpoch = 0;
  private scopeEpoch = 0;
  private scopeRequest = 0;
  private scope: string | null = null;
  private active: object | null = null;
  private live = true;
  private forceNew = false;
  private current: { fingerprint: string; requestId: string } | null = null;
  // Both receipts establish admission; only accepted makes recovery unnecessary.
  private confirmedRecords = new Map<string, AdmissionView>();
  private errorOwner: string | object | null = null;
  private readonly scopeErrorOwner = {};
  private listeners = new Set<() => void>();

  constructor(private readonly options: Options) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  activate(): void {
    this.live = true;
  }
  deactivate(): void {
    this.live = false;
    this.epoch++;
    this.authEpoch++;
    this.active = null;
  }

  setContext(context: { token: string | null; payload: RunPayload }): void {
    const nextKey = payloadKey(context.payload);
    const tokenChanged = this.token !== context.token;
    if (!tokenChanged && this.contextKey === nextKey) return;
    const planChanged = this.payload.planDigest !== context.payload.planDigest;
    this.epoch++;
    this.active = null;
    this.current = null;
    this.errorOwner = null;
    this.payload = { ...context.payload };
    this.contextKey = nextKey;
    this.snapshot = {
      ...this.snapshot,
      isPending: false,
      error: null,
      outcome: null,
      planExpired:
        tokenChanged || planChanged ? false : this.snapshot.planExpired,
    };
    if (tokenChanged) {
      this.authEpoch++;
      this.token = context.token;
      this.scope = null;
      this.forceNew = false;
      this.snapshot = emptySnapshot();
    }
    // Called during render: update ownership synchronously without notifying
    // React subscribers from within another component's render.
  }

  async loadScope(): Promise<void> {
    const token = this.token;
    if (!token) return;
    const authEpoch = this.authEpoch;
    let scopeEpoch = this.scopeEpoch;
    const request = ++this.scopeRequest;
    const current = () =>
      this.live &&
      this.token === token &&
      this.authEpoch === authEpoch &&
      this.scopeEpoch === scopeEpoch &&
      this.scopeRequest === request;
    try {
      const result = await this.options.intent({ token });
      if (!current()) return;
      // Revoke the old scope before local I/O, which can fail independently.
      this.changeScope(result.scope);
      scopeEpoch = this.scopeEpoch;
      const records = this.mergeRecords(this.options.ledger.list(result.scope));
      this.patch({ scopeReady: true, records });
      this.clearError(this.scopeErrorOwner);
    } catch (error) {
      if (current()) {
        this.errorOwner = this.scopeErrorOwner;
        this.patch({ scopeReady: false, error: asError(error), outcome: null });
      }
    }
  }

  async submit(): Promise<void> {
    if (this.active || !this.live || !this.token || this.snapshot.planExpired)
      return;
    const owner = {};
    this.active = owner;
    const epoch = this.epoch;
    const token = this.token;
    const payload = Object.freeze({ ...this.payload });
    const current = () =>
      this.live &&
      this.active === owner &&
      this.epoch === epoch &&
      this.token === token;
    let dispatched = false;
    let submittedRecord: RequestIdentity | undefined =
      this.scope && this.current
        ? { scope: this.scope, ...this.current }
        : undefined;
    let localOperation = false;
    this.errorOwner = owner;
    this.patch({ isPending: true, error: null, outcome: null });
    try {
      if (!this.snapshot.scopeReady) await this.loadScope();
      if (!current() || !this.snapshot.scopeReady || !this.scope) return;
      this.errorOwner = owner;
      const scope = this.scope;
      const intent = await this.options.intent({ token, run: payload });
      if (!current()) return;
      if (intent.scope !== scope) {
        this.changeScope(intent.scope);
        this.errorOwner = this.scopeErrorOwner;
        this.patch({
          error: new Error('仓库或连接凭据已变化，请重新读取请求记录后确认。'),
        });
        return;
      }
      if (!intent.fingerprint || !intent.requestId) {
        throw new Error('仓库或连接凭据已变化，请刷新页面后重新确认请求。');
      }
      // This candidate is already bound to the current input. Preserve its
      // receipt even if the first ledger read fails before request preparation.
      submittedRecord =
        this.current?.fingerprint === intent.fingerprint
          ? { scope, ...this.current }
          : undefined;
      localOperation = true;
      const records = this.options.ledger.list(scope);
      this.mergeRecords(records); // Validate conflicts before any write or POST.
      const existing =
        this.current?.fingerprint === intent.fingerprint
          ? this.current
          : !this.forceNew
            ? [...records]
                .reverse()
                .find((record) => record.fingerprint === intent.fingerprint)
            : undefined;
      const requestId = existing?.requestId ?? intent.requestId;
      const record: AdmissionRecord = {
        scope,
        fingerprint: intent.fingerprint,
        requestId,
        state: 'unknown',
      };
      submittedRecord = record;
      this.errorOwner = errorKey(record);
      if (!current()) return;
      const resolved = this.checkIdentity(record);
      if (resolved?.state === 'accepted') {
        this.updateRecord(resolved);
        return;
      }
      if (resolved) record.state = 'recovery-required';
      this.options.ledger.upsert(record);
      this.current = { fingerprint: record.fingerprint, requestId };
      this.forceNew = false;
      this.patch({
        records: this.mergeRecords(this.options.ledger.list(scope)),
        newIntent: false,
      });
      if (!current()) return;
      dispatched = true;
      localOperation = false;
      const result = await this.options.run({ ...payload, token, requestId });
      if (!current()) return;
      if (result.requestId !== requestId)
        throw new Error('服务端返回的请求身份不一致，请查询原请求。');
      const alreadyAccepted = this.confirmedFor(record);
      if (alreadyAccepted?.state === 'accepted') {
        this.updateRecord(alreadyAccepted);
        return;
      }
      // A matching server receipt is stronger evidence than subsequent browser
      // storage or navigation failures. Publish its identity before local I/O.
      this.updateRecord({
        ...record,
        state: result.admissionState,
        runId: result.run.id,
        sessionId: result.sessionId,
        filesState: result.run.filesState,
      });
      this.clearError(errorKey(record));
      localOperation = true;
      if (result.admissionState === 'recovery-required') {
        this.options.ledger.upsert({ ...record, state: 'recovery-required' });
      } else {
        this.options.ledger.remove(scope, requestId);
        if (current()) await this.options.onAccepted(result);
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof AdmissionIdentityConflict) {
        this.errorOwner = submittedRecord ? errorKey(submittedRecord) : owner;
        this.patch({ error, planExpired: false, outcome: null });
        return;
      }
      const known = this.confirmedFor(submittedRecord);
      if (known) {
        // A concurrent lookup can confirm the POST before its response fails.
        // Neither that transport error nor local receipt handling can undo it.
        if (localOperation) {
          this.errorOwner = errorKey(known);
          this.patch({
            error: new Error(LOCAL_RECEIPT_ERROR),
            planExpired: false,
            outcome: null,
          });
        } else if (this.snapshot.outcome !== null)
          this.clearError(errorKey(known));
        return;
      }
      const failure = asError(error);
      const planExpired =
        (failure instanceof ApiClientError &&
          failure.code === 'PLAN_DIGEST_MISMATCH') ||
        /^PLAN_DIGEST_MISMATCH\b/.test(failure.message);
      // Bind only a failure we actually publish. An ignored late transport
      // error must not reassign an unrelated request's visible error.
      this.errorOwner = submittedRecord ? errorKey(submittedRecord) : owner;
      this.patch({
        error: planExpired
          ? new Error('计划已变化，请刷新预览后重试')
          : failure,
        planExpired,
        outcome:
          !dispatched ||
          planExpired ||
          (failure instanceof ApiClientError &&
            ['BAD_REQUEST', 'UNAUTHORIZED', 'CONFLICT'].includes(failure.code))
            ? 'not-created'
            : 'unknown',
      });
    } finally {
      if (this.active === owner) {
        this.active = null;
        this.patch({ isPending: false });
      }
    }
  }

  async lookup(requestId: string): Promise<void> {
    if (!this.token || !this.scope || this.snapshot.checkingId) return;
    const token = this.token;
    const scope = this.scope;
    const authEpoch = this.authEpoch;
    const scopeEpoch = this.scopeEpoch;
    const epoch = this.epoch;
    const record = this.snapshot.records.find(
      (entry) => entry.scope === scope && entry.requestId === requestId,
    );
    if (!record) return;
    const current = () =>
      this.live &&
      this.token === token &&
      this.scope === scope &&
      this.scopeEpoch === scopeEpoch &&
      this.authEpoch === authEpoch;
    const knownAtStart = this.confirmedFor(record);
    const key = errorKey(record);
    const mayReport = () =>
      this.epoch === epoch &&
      (this.errorOwner === null || this.errorOwner === key);
    let receiptObserved = false;
    this.patch({ checkingId: requestId });
    if (this.errorOwner === key) this.patch({ error: null });
    try {
      const result = await this.options.lookup({ token, requestId });
      if (!current()) return;
      if (result.requestId !== requestId)
        throw new Error('服务端返回的请求身份不一致，请保留原请求。');
      const known = this.confirmedFor(record);
      if (known?.state === 'accepted') return;
      if (result.state === 'not-found') {
        if (known) return;
        this.updateRecord({
          ...record,
          state: 'unknown',
          lookupState: 'not-found',
        });
      } else {
        // A newer POST receipt wins over an older non-ready GET. Ready may
        // still advance the same request, regardless of response ordering.
        if (result.state !== 'accepted' && known && known !== knownAtStart)
          return;
        this.updateRecord({
          ...record,
          state: result.state,
          lookupState: undefined,
          runId: result.runId,
          sessionId: result.sessionId,
          filesState: result.filesState,
        });
        receiptObserved = true;
        this.clearError(key);
        if (result.state === 'accepted')
          this.options.ledger.remove(scope, requestId);
        else
          this.options.ledger.upsert({
            scope,
            fingerprint: record.fingerprint,
            requestId,
            state: 'recovery-required',
          });
      }
    } catch (error) {
      if (!current() || !mayReport()) return;
      if (receiptObserved) {
        this.errorOwner = key;
        this.patch({ error: new Error(LOCAL_RECEIPT_ERROR), outcome: null });
      } else if (
        error instanceof AdmissionIdentityConflict ||
        !this.confirmedFor(record)
      ) {
        this.errorOwner = key;
        this.patch({ error: asError(error) });
      }
    } finally {
      if (current()) this.patch({ checkingId: null });
    }
  }

  beginNew(): void {
    this.epoch++;
    this.active = null;
    this.current = null;
    this.errorOwner = null;
    this.forceNew = true;
    this.patch({
      isPending: false,
      error: null,
      outcome: null,
      newIntent: true,
    });
  }

  refreshPlan(refetch: () => void): void {
    this.epoch++;
    this.active = null;
    this.current = null;
    this.errorOwner = null;
    this.patch({
      isPending: false,
      planExpired: false,
      error: null,
      outcome: null,
    });
    refetch();
  }

  private changeScope(scope: string): void {
    if (this.scope === scope) return;
    if (this.scope !== null) {
      this.epoch++;
      this.active = null;
      this.current = null;
    }
    this.scopeEpoch++;
    this.scope = scope;
    this.errorOwner = null;
    this.forceNew = false;
    this.patch({
      ...emptySnapshot(),
      isPending: Boolean(this.active),
      records: this.mergeRecords([]),
    });
  }
  private clearError(owner: string | object): void {
    if (this.errorOwner !== owner) return;
    this.errorOwner = null;
    this.patch({ error: null, outcome: null, planExpired: false });
  }
  private confirmedFor(
    record: RequestIdentity | undefined,
  ): AdmissionView | undefined {
    if (!record) return;
    const known = this.confirmedRecords.get(requestKey(record));
    return known?.fingerprint === record.fingerprint ? known : undefined;
  }
  private checkIdentity(record: AdmissionView): AdmissionView | undefined {
    const known = this.confirmedRecords.get(requestKey(record));
    if (
      known &&
      (known.fingerprint !== record.fingerprint ||
        (record.runId && known.runId !== record.runId) ||
        (record.sessionId &&
          known.sessionId &&
          known.sessionId !== record.sessionId))
    ) {
      throw new AdmissionIdentityConflict();
    }
    return known;
  }
  private mergeRecords(records: AdmissionView[]): AdmissionView[] {
    const merged = new Map<string, AdmissionView>();
    for (const record of records) {
      if (record.scope === this.scope)
        merged.set(record.requestId, this.checkIdentity(record) ?? record);
    }
    for (const record of this.confirmedRecords.values()) {
      if (record.scope === this.scope) merged.set(record.requestId, record);
    }
    return [...merged.values()];
  }
  private updateRecord(record: AdmissionView): void {
    const known = this.checkIdentity(record);
    if (
      known &&
      (known.state === 'accepted' ||
        record.state === 'unknown' ||
        !record.runId)
    ) {
      record = known;
    } else if (record.state !== 'unknown' && record.runId) {
      record = { ...record, sessionId: record.sessionId ?? known?.sessionId };
      this.confirmedRecords.set(requestKey(record), record);
    }
    this.patch({
      records: this.mergeRecords([
        ...this.snapshot.records.filter(
          (entry) => entry.requestId !== record.requestId,
        ),
        record,
      ]),
    });
  }
  private patch(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useRunAdmission(options: {
  token: string | null;
  payload: RunPayload;
  onAccepted: (result: RunResult) => void | Promise<void>;
}) {
  const acceptedRef = useRef(options.onAccepted);
  acceptedRef.current = options.onAccepted;
  const [, rerender] = useState(0);
  const controllerRef = useRef<RunAdmissionController | null>(null);
  if (!controllerRef.current)
    controllerRef.current = new RunAdmissionController({
      ledger: new AdmissionLedger(),
      intent: (input) => rpc.call('project.admissionIntent', input),
      run: (input) => rpc.call('project.run', input),
      lookup: (input) => rpc.call('project.admission', input),
      onAccepted: (result) => {
        for (const key of [
          'session.list',
          'project.detail',
          'project.overview',
        ])
          queryCache.invalidate(key);
        return acceptedRef.current(result);
      },
    });
  const controller = controllerRef.current;
  controller.setContext(options);
  useEffect(() => {
    controller.activate();
    const unsubscribe = controller.subscribe(() =>
      rerender((value) => value + 1),
    );
    void controller.loadScope();
    return () => {
      unsubscribe();
      controller.deactivate();
    };
  }, [controller, options.token]);
  return {
    ...controller.snapshot,
    submit: () => controller.submit(),
    lookup: (requestId: string) => controller.lookup(requestId),
    beginNew: () => controller.beginNew(),
    refreshPlan: (refetch: () => void) => controller.refreshPlan(refetch),
    retryScope: () => controller.loadScope(),
  };
}

export type RunAdmission = ReturnType<typeof useRunAdmission>;
