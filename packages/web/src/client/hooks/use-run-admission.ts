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
  onAccepted: (result: RunResult) => void;
}
const LOCAL_RECEIPT_ERROR =
  '请求已受理，但浏览器请求记录更新或页面跳转未完成。请通过下方入口观察原运行，不要重复新建。';

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
  private scopeRequest = 0;
  private scope: string | null = null;
  private active: object | null = null;
  private live = true;
  private forceNew = false;
  private current: { fingerprint: string; requestId: string } | null = null;
  // Acceptance is monotonic for a scope/request identity. Keep its observation
  // route even when an older lookup settles after the POST has cleared disk.
  private acceptedRecords = new Map<string, AdmissionView>();
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
    const request = ++this.scopeRequest;
    const current = () =>
      this.live &&
      this.token === token &&
      this.authEpoch === authEpoch &&
      this.scopeRequest === request;
    try {
      const result = await this.options.intent({ token });
      if (!current()) return;
      const records = this.options.ledger.list(result.scope);
      if (this.scope && this.scope !== result.scope) {
        this.epoch++;
        this.active = null;
        this.current = null;
        this.snapshot = { ...this.snapshot, isPending: false };
      }
      this.scope = result.scope;
      this.patch({ scopeReady: true, records, error: null });
    } catch (error) {
      if (current()) this.patch({ scopeReady: false, error: asError(error) });
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
    let submittedRecord: AdmissionRecord | undefined;
    let receiptObserved = false;
    this.patch({ isPending: true, error: null, outcome: null });
    try {
      if (!this.snapshot.scopeReady) await this.loadScope();
      if (!current() || !this.snapshot.scopeReady || !this.scope) return;
      const scope = this.scope;
      const intent = await this.options.intent({ token, run: payload });
      if (!current()) return;
      if (intent.scope !== scope || !intent.fingerprint || !intent.requestId) {
        throw new Error('仓库或连接凭据已变化，请刷新页面后重新确认请求。');
      }
      const records = this.options.ledger.list(scope);
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
      if (!current()) return;
      const resolved = this.acceptedRecords.get(`${scope}\0${requestId}`);
      if (resolved) {
        this.updateRecord(resolved);
        return;
      }
      this.options.ledger.upsert(record);
      this.current = { fingerprint: record.fingerprint, requestId };
      this.forceNew = false;
      this.patch({
        records: this.mergeRecords(this.options.ledger.list(scope)),
        newIntent: false,
      });
      if (!current()) return;
      dispatched = true;
      const result = await this.options.run({ ...payload, token, requestId });
      if (!current()) return;
      if (result.requestId !== requestId)
        throw new Error('服务端返回的请求身份不一致，请查询原请求。');
      const alreadyAccepted = this.acceptedRecords.get(
        `${scope}\0${requestId}`,
      );
      if (alreadyAccepted) {
        this.updateRecord(alreadyAccepted);
        return;
      }
      // A matching server receipt is stronger evidence than subsequent browser
      // storage or navigation failures. Publish its identity before local I/O.
      receiptObserved = true;
      this.updateRecord({
        ...record,
        state: result.admissionState,
        runId: result.run.id,
        sessionId: result.sessionId,
        filesState: result.run.filesState,
      });
      this.patch({ outcome: null });
      if (result.admissionState === 'recovery-required') {
        this.options.ledger.upsert({ ...record, state: 'recovery-required' });
      } else {
        this.options.ledger.remove(scope, requestId);
        if (current()) this.options.onAccepted(result);
      }
    } catch (error) {
      if (!current()) return;
      const submitted = submittedRecord;
      const known = submitted && this.snapshot.records.find(record =>
        record.scope === submitted.scope &&
        record.requestId === submitted.requestId &&
        record.fingerprint === submitted.fingerprint &&
        record.state !== 'unknown' && record.runId,
      );
      if (known) {
        // A concurrent lookup can confirm the POST before its response fails.
        // Neither that transport error nor local receipt handling can undo it.
        this.patch({
          error: receiptObserved ? new Error(LOCAL_RECEIPT_ERROR) : null,
          planExpired: false,
          outcome: null,
        });
        return;
      }
      const failure = asError(error);
      const planExpired =
        (failure instanceof ApiClientError &&
          failure.code === 'PLAN_DIGEST_MISMATCH') ||
        /^PLAN_DIGEST_MISMATCH\b/.test(failure.message);
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
    const record = this.snapshot.records.find(
      (entry) => entry.requestId === requestId,
    );
    if (!record) return;
    const current = () =>
      this.live &&
      this.token === token &&
      this.scope === scope &&
      this.authEpoch === authEpoch;
    const alreadyAccepted = () =>
      this.acceptedRecords.has(`${scope}\0${requestId}`);
    let receiptObserved = false;
    this.patch({ checkingId: requestId, error: null });
    try {
      const result = await this.options.lookup({ token, requestId });
      if (!current() || alreadyAccepted()) return;
      if (result.requestId !== requestId)
        throw new Error('服务端返回的请求身份不一致，请保留原请求。');
      if (result.state === 'not-found') {
        this.updateRecord({
          ...record,
          state: 'unknown',
          lookupState: 'not-found',
        });
      } else {
        receiptObserved = true;
        this.updateRecord({
          ...record,
          state: result.state,
          lookupState: undefined,
          runId: result.runId,
          sessionId: result.sessionId,
          filesState: result.filesState,
        });
        this.patch({ outcome: null, planExpired: false });
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
      if (!current()) return;
      if (receiptObserved) {
        this.patch({ error: new Error(LOCAL_RECEIPT_ERROR), outcome: null });
      } else if (!alreadyAccepted()) {
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
    this.patch({
      isPending: false,
      planExpired: false,
      error: null,
      outcome: null,
    });
    refetch();
  }

  private mergeRecords(records: AdmissionRecord[]): AdmissionView[] {
    return [
      ...this.snapshot.records.filter(
        (record) =>
          record.state === 'accepted' &&
          !records.some((entry) => entry.requestId === record.requestId),
      ),
      ...records,
    ];
  }
  private updateRecord(record: AdmissionView): void {
    const key = `${record.scope}\0${record.requestId}`;
    record = this.acceptedRecords.get(key) ?? record;
    if (record.state === 'accepted') this.acceptedRecords.set(key, record);
    this.patch({
      records: [
        ...this.snapshot.records.filter(
          (entry) => entry.requestId !== record.requestId,
        ),
        record,
      ],
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
  onAccepted: (result: RunResult) => void;
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
        acceptedRef.current(result);
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
