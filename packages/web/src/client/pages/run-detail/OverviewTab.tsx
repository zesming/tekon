import { useParams } from 'react-router';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import type {
  ApiWorkReviewSurface,
} from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { StatusBadge } from '../../components/ui/StatusBadge.js';
import { CheckList } from '../../components/eval/CheckList.js';
import { buildFailedChecksSummary } from '../../lib/check-labels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readinessLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// OverviewTab — readiness, failed checks, evidence groups, next commands,
//               gate failure triage
// ---------------------------------------------------------------------------

export function OverviewTab() {
  const { runId } = useParams<{ runId: string }>();

  const query = useQuery<ApiWorkReviewSurface>(
    runId ? `review:${runId}` : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  if (query.isLoading) return <LoadingState message="加载概览中..." />;
  if (query.error)
    return <ErrorBanner error={query.error} onRetry={query.refetch} />;
  if (!query.data)
    return <EmptyState message="暂无审阅数据" />;

  const surface = query.data;
  const readiness = surface.readiness;
  const scorePercent = Math.round(readiness.score * 100);
  const failedChecks = readiness.checks.filter((c) => !c.passed);
  const passedChecks = readiness.checks.filter((c) => c.passed);

  return (
    <>
      {/* ── Readiness Score Card ── */}
      <Card
        title="工作就绪"
        headerRight={
          <div className="flex items-center gap-2">
            <span
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '24px',
                fontWeight: 500,
                color:
                  readinessLevel(readiness.score) === 'high'
                    ? 'var(--pass)'
                    : readinessLevel(readiness.score) === 'medium'
                      ? 'var(--pend)'
                      : 'var(--fail)',
              }}
            >
              {readiness.score.toFixed(2)}
            </span>
            <StatusBadge
              status={readiness.ready ? 'passed' : 'failed'}
              size="sm"
            />
          </div>
        }
        className="mb-6"
      >
        <div style={{ padding: '12px 20px', background: readiness.ready ? 'var(--pass-bg)' : 'var(--fail-bg)', borderBottom: '1px solid var(--border-l)' }}>
          <div className="readiness-bar" style={{ height: '8px' }}>
            <div
              className={`readiness-fill ${readinessLevel(readiness.score)}`}
              style={{ width: `${scorePercent}%` }}
            />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-around',
            padding: '16px 20px',
            fontSize: '13px',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '22px',
                fontWeight: 500,
                color: 'var(--pass)',
              }}
            >
              {passedChecks.length}
            </div>
            <div className="text-sm text-muted">通过</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '22px',
                fontWeight: 500,
                color: failedChecks.length > 0 ? 'var(--fail)' : 'var(--text-t)',
              }}
            >
              {failedChecks.length}
            </div>
            <div className="text-sm text-muted">失败</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '22px',
                fontWeight: 500,
              }}
            >
              {readiness.checks.length}
            </div>
            <div className="text-sm text-muted">检查总数</div>
          </div>
        </div>
      </Card>

      {/* ── Failed Checks ── */}
      {failedChecks.length > 0 ? (
        <Card
          title="失败检查"
          headerRight={
            <span className="badge badge-failed badge-sm">
              {failedChecks.length} 失败
            </span>
          }
          compact
          className="mb-6"
        >
          <div className="failed-checks-summary">
            {buildFailedChecksSummary(
              failedChecks.map((c) => ({ id: c.id, severity: c.severity })),
            )}
          </div>
          <CheckList
            items={failedChecks.map((c) => ({
              id: c.id,
              passed: c.passed,
              evidence: c.evidence,
              severity: c.severity,
            }))}
          />
        </Card>
      ) : null}

      {/* ── All Checks ── */}
      <Card
        title="全部检查"
        headerRight={
          <span className="text-sm text-muted">
            {passedChecks.length}/{readiness.checks.length} 通过
          </span>
        }
        compact
        className="mb-6"
      >
        <CheckList
          items={readiness.checks.map((c) => ({
            id: c.id,
            passed: c.passed,
            evidence: c.evidence,
            severity: c.severity,
          }))}
        />
      </Card>

      {/* ── Evidence Groups ── */}
      <div className="section">
        <div className="section-title">
          证据组{' '}
          <span className="count">{surface.evidenceGroups.length}</span>
        </div>
        {surface.evidenceGroups.length === 0 ? (
          <Card>
            <EmptyState
              message="暂无证据组"
              hint="工作流执行过程中证据将在此显示。"
            />
          </Card>
        ) : (
          <div className="panel-grid">
            {surface.evidenceGroups.map((group) => (
              <Card
                key={group.id}
                title={group.title}
                headerRight={
                  <StatusBadge status={group.status} size="sm" />
                }
              >
                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--text-s)',
                    marginBottom: '12px',
                    lineHeight: 1.6,
                  }}
                >
                  {group.summary}
                </div>
                {group.links.length > 0 ? (
                  <div
                    className="link-strip"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
                  >
                    {group.links.map((link, idx) => (
                      <a
                        key={idx}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: 'var(--accent)',
                          fontSize: '12px',
                          fontWeight: 600,
                          textDecoration: 'none',
                        }}
                      >
                        {link.label} →
                      </a>
                    ))}
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* ── Next Commands ── */}
      {surface.nextCommands.length > 0 ? (
        <div className="section">
          <div className="section-title">
            后续操作{' '}
            <span className="count">{surface.nextCommands.length}</span>
          </div>
          <Card compact>
            <div style={{ padding: '16px 20px' }}>
              {surface.nextCommands.map((cmd, idx) => (
                <div
                  key={idx}
                  style={{
                    fontFamily: 'var(--font-m)',
                    fontSize: '12px',
                    padding: '8px 12px',
                    background: 'var(--surface-h)',
                    border: '1px solid var(--border-l)',
                    borderRadius: 'var(--r-sm)',
                    marginBottom: '6px',
                  }}
                >
                  $ {cmd}
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {/* ── Gate Failure Triage ── */}
      {surface.gateFailureTriage.length > 0 ? (
        <div className="section">
          <div className="section-title">
            门禁故障诊断{' '}
            <span className="count">{surface.gateFailureTriage.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {surface.gateFailureTriage.map((triage) => (
              <Card
                key={triage.gateId}
                headerRight={
                  <StatusBadge status={triage.status} size="sm" />
                }
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr',
                    gap: '8px 12px',
                    fontSize: '13px',
                  }}
                >
                  <span className="text-muted" style={{ fontWeight: 500 }}>
                    门禁
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {triage.gateType}
                    <span className="text-mono text-muted"> ({triage.nodeId})</span>
                  </span>
                  <span className="text-muted" style={{ fontWeight: 500 }}>
                    分类
                  </span>
                  <span
                    className="badge badge-sm"
                    style={{
                      background: 'var(--fail-bg)',
                      color: '#991b1b',
                      display: 'inline-flex',
                      width: 'fit-content',
                    }}
                  >
                    {triage.classification}
                  </span>
                  <span className="text-muted" style={{ fontWeight: 500 }}>
                    重试
                  </span>
                  <span>{triage.retry}</span>
                  <span className="text-muted" style={{ fontWeight: 500 }}>
                    摘要
                  </span>
                  <span style={{ color: 'var(--text-s)' }}>
                    {triage.summary}
                  </span>
                  <span className="text-muted" style={{ fontWeight: 500 }}>
                    建议操作
                  </span>
                  <span
                    className="text-mono"
                    style={{ fontSize: '12px', color: 'var(--accent)' }}
                  >
                    $ {triage.suggestedCommand}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
