import { Link } from 'react-router';
import type { RunAdmission } from '../../hooks/use-run-admission.js';
import { routes } from '../../lib/route-paths.js';

export function AdmissionNotice({
  admission,
  refetchPlan,
  errorId,
}: {
  admission: RunAdmission;
  refetchPlan: () => void;
  errorId?: string;
}) {
  if (
    admission.scopeReady &&
    !admission.error &&
    admission.records.length === 0
  )
    return null;
  return (
    <section
      data-testid="admission-notice"
      aria-label="运行受理记录"
      className="text-sm"
      style={{ marginTop: 12, overflowWrap: 'anywhere' }}
    >
      {!admission.scopeReady && !admission.error ? (
        <p className="text-muted">正在读取当前仓库的请求身份…</p>
      ) : null}
      {admission.error ? (
        <p id={errorId} className="text-danger" role="alert">
          {admission.outcome === 'not-created'
            ? '本次未创建：'
            : admission.outcome === 'unknown'
              ? '受理状态待确认：'
              : ''}
          {admission.error.message}
        </p>
      ) : null}
      {admission.planExpired ? (
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          onClick={() => admission.refreshPlan(refetchPlan)}
        >
          刷新执行计划
        </button>
      ) : null}
      {!admission.scopeReady && admission.error ? (
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          onClick={() => void admission.retryScope()}
        >
          重新读取请求记录
        </button>
      ) : null}
      {admission.records.map((record) => (
        <div
          key={record.requestId}
          style={{
            padding: '10px 0',
            borderBottom: '1px solid var(--border-l)',
          }}
        >
          <p>
            <strong>
              {record.state === 'accepted'
                ? '已受理'
                : record.state === 'recovery-required'
                  ? admissionReadinessLabel(record)
                  : '受理状态待确认'}
            </strong>{' '}
            · 请求 <code>{record.requestId}</code>
          </p>
          {record.state === 'unknown' ? (
            <p className="text-muted">
              可查询受理结果，或用相同内容重试原请求。尚未查到记录不代表未受理，请保留原请求身份。
            </p>
          ) : null}
          {record.lookupState === 'not-found' ? (
            <p>当前尚未查到记录，原请求仍可能在处理中。</p>
          ) : null}
          {record.state === 'recovery-required' ? (
            <p>{admissionReadinessGuidance(record)}</p>
          ) : null}
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            {record.state !== 'accepted' ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={Boolean(admission.checkingId)}
                onClick={() => void admission.lookup(record.requestId)}
              >
                {admission.checkingId === record.requestId
                  ? '正在查询…'
                  : '查询受理结果'}
              </button>
            ) : null}
            {record.sessionId ? (
              <Link
                className="btn btn-ghost btn-xs"
                to={routes.session(record.sessionId)}
              >
                观察原会话
              </Link>
            ) : record.runId ? (
              <Link
                className="btn btn-ghost btn-xs"
                to={routes.run(record.runId)}
              >
                观察原运行
              </Link>
            ) : null}
          </div>
        </div>
      ))}
      {admission.records.some((record) => record.state !== 'accepted') ? (
        <p className="text-muted">
          如需另建任务，旧请求记录仍会保留。
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={admission.isPending}
            onClick={admission.beginNew}
          >
            明确新建另一个任务
          </button>
        </p>
      ) : null}
      {admission.newIntent ? (
        <p>已选择另建任务；下次提交将使用新请求身份，旧请求仍可查询。</p>
      ) : null}
    </section>
  );
}

interface AdmissionReadiness {
  admissionState?: 'accepted' | 'recovery-required';
  filesState?: 'pending' | 'ready' | 'recovery_required';
}
export function admissionNeedsRecovery(
  value: AdmissionReadiness | undefined,
): boolean {
  return (
    value?.admissionState === 'recovery-required' ||
    value?.filesState === 'pending' ||
    value?.filesState === 'recovery_required'
  );
}
export function admissionReadinessLabel(value: AdmissionReadiness): string {
  if (value.filesState === 'pending') return '已受理，等待目录就绪';
  if (value.filesState === 'recovery_required') return '已受理，等待目录恢复';
  return '已受理，目录状态待确认';
}
function admissionReadinessGuidance(value: AdmissionReadiness): string {
  if (value.filesState === 'pending') {
    return '请求已受理，运行目录尚未就绪，任务尚未执行。请稍后查询受理结果或刷新目录状态，无需另建任务。';
  }
  if (value.filesState === 'recovery_required') {
    return '请求已受理，运行目录准备失败，任务尚未执行。修复目录后按原请求重试，或重启 UI 服务恢复；查询本身不会修复目录。';
  }
  return '请求已受理；当前目录细分状态尚未确认，请先查询受理结果或刷新状态，再按结果处理。';
}
/** 查询失败不撤销已经从权威快照读到的受理事实。 */
export function knownAdmissionLabel(value: AdmissionReadiness | undefined): string | null {
  if (admissionNeedsRecovery(value)) return admissionReadinessLabel(value!);
  return value?.admissionState === 'accepted' || value?.filesState === 'ready' ? '已受理' : null;
}
export function AdmissionReadinessBanner({
  value,
}: {
  value: AdmissionReadiness;
}) {
  if (!admissionNeedsRecovery(value)) return null;
  return (
    <p
      role="status"
      data-testid="admission-readiness"
      className="text-sm"
      style={{
        padding: 12,
        background: 'var(--surface-h)',
        overflowWrap: 'anywhere',
      }}
    >
      {admissionReadinessLabel(value)}
      ：{admissionReadinessGuidance(value)}
    </p>
  );
}
