export type LedgerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AdmissionRecord {
  scope: string;
  fingerprint: string;
  requestId: string;
  state: 'unknown' | 'recovery-required';
}

const PREFIX = 'tekon.run-admissions.v1.';
const STORAGE_ERROR =
  '浏览器会话存储不可用或请求账本损坏，已阻止创建运行。请恢复存储后重试，勿清除尚待确认的请求记录。';

function validRecord(value: unknown, scope: string): value is AdmissionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as AdmissionRecord;
  return (
    Object.keys(record).length === 4 &&
    record.scope === scope &&
    typeof record.fingerprint === 'string' &&
    record.fingerprint.length > 0 &&
    typeof record.requestId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(record.requestId) &&
    (record.state === 'unknown' || record.state === 'recovery-required')
  );
}

/** Only opaque server identities are persisted; neither credentials nor payloads. */
export class AdmissionLedger {
  constructor(
    private readonly storage: () => LedgerStorage = () => window.sessionStorage,
  ) {}

  list(scope: string): AdmissionRecord[] {
    try {
      const raw = this.storage().getItem(PREFIX + encodeURIComponent(scope));
      if (raw === null) return [];
      const records: unknown = JSON.parse(raw);
      if (
        !Array.isArray(records) ||
        !records.every((record) => validRecord(record, scope))
      )
        throw new Error('invalid ledger');
      return records;
    } catch {
      throw new Error(STORAGE_ERROR);
    }
  }

  upsert(record: AdmissionRecord): void {
    // Whitelist at the persistence boundary even if a caller passes extra fields.
    const value: AdmissionRecord = {
      scope: record.scope,
      fingerprint: record.fingerprint,
      requestId: record.requestId,
      state: record.state,
    };
    if (!validRecord(value, value.scope)) throw new Error(STORAGE_ERROR);
    const records = this.list(value.scope).filter(
      (entry) => entry.requestId !== value.requestId,
    );
    this.write(value.scope, [...records, value]);
  }

  remove(scope: string, requestId: string): void {
    this.write(
      scope,
      this.list(scope).filter((entry) => entry.requestId !== requestId),
    );
  }

  private write(scope: string, records: AdmissionRecord[]): void {
    try {
      const target = this.storage();
      const key = PREFIX + encodeURIComponent(scope);
      if (records.length) target.setItem(key, JSON.stringify(records));
      else target.removeItem(key);
    } catch {
      throw new Error(STORAGE_ERROR);
    }
  }
}
