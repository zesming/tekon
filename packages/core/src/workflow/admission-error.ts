import type { RunAdmissionRow } from '../db/admission-store.js';

/** 恢复身份来自已校验的持久记录；绝不暴露本次未提交的候选 ID。 */
export class RunAdmissionError extends Error {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly admissionState: 'unknown' | 'accepted' | 'recovery-required';

  constructor(
    readonly requestId: string,
    cause: unknown,
    admission?: Pick<RunAdmissionRow, 'runId' | 'sessionId' | 'jobId' | 'filesState'>,
  ) {
    const admissionState = admission
      ? admission.filesState === 'ready' ? 'accepted' : 'recovery-required'
      : 'unknown';
    const identity = [
      `requestId=${requestId}`,
      ...(admission ? [`runId=${admission.runId}`] : []),
      ...(admission?.sessionId ? [`sessionId=${admission.sessionId}`] : []),
      ...(admission?.jobId ? [`jobId=${admission.jobId}`] : []),
      `admissionState=${admissionState}`,
    ].join(' ');
    super(`${cause instanceof Error ? cause.message : 'RUN_ADMISSION_FAILED'} (${identity})`, { cause });
    this.name = 'RunAdmissionError';
    this.runId = admission?.runId;
    this.sessionId = admission?.sessionId ?? undefined;
    this.jobId = admission?.jobId ?? undefined;
    this.admissionState = admissionState;
  }
}
