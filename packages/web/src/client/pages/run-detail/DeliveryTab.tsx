import type { CSSProperties, ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { useQuery, useAuthScope } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { ApiWorkReviewSurface } from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { StatusBadge } from '../../components/ui/StatusBadge.js';
import { DeliveryPipeline } from '../../components/delivery/DeliveryPipeline.js';
import { DiffViewer } from '../../components/delivery/DiffViewer.js';
import { CodeBlock } from '../../components/ui/CodeBlock.js';
import { useEvidenceTarget } from '../../hooks/use-evidence-target.js';
import { checkLabel, getCheckSuggestion } from '../../lib/check-labels.js';

// ---------------------------------------------------------------------------
// DeliveryTab — pipeline stepper, delivery locations guidance, diff summary,
// PR package/body preview (PD-21: declaration-driven delivery surface)
// ---------------------------------------------------------------------------

const monoRowStyle: CSSProperties = {
  fontFamily: 'var(--font-m)',
  fontSize: '12px',
  color: 'var(--text-s)',
  wordBreak: 'break-all',
};

const labelStyle: CSSProperties = {
  color: 'var(--text-m)',
  fontSize: '12px',
  minWidth: '92px',
  flexShrink: 0,
};

function GuidanceRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: '8px', padding: '4px 0', alignItems: 'baseline' }}>
      <span style={labelStyle}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  );
}

function DeliveryGuidanceCard({ surface }: { surface: ApiWorkReviewSurface }) {
  const { delivery, nextCommands, prePullRequestReadiness } = surface;
  const packagePath = delivery.package?.exists ? delivery.package.path : null;
  const bodyPath = delivery.prBody?.exists ? delivery.prBody.path : null;

  // PD-21：不可交付运行（无声明/快照不可用/证据未满足）不展示尚未创建的
  // 交付分支与 worktree——diff.branch 只是约定名而非真实 ref，展示会造成
  // 「幻影分支」误导。与 CLI delivery-guidance 的 not-ready 提前返回对齐。
  if (!prePullRequestReadiness.ready) {
    const firstFailed = prePullRequestReadiness.checks.find(
      (check) => !check.passed,
    );
    return (
      <Card title="交付落点与下一步" compact className="mb-6">
        <div style={{ padding: '12px 24px' }}>
          <GuidanceRow label="交付状态">
            <span style={{ color: 'var(--fail)' }}>当前不可进入 PR 准备</span>
          </GuidanceRow>
          {firstFailed ? (
            <GuidanceRow label="原因">
              <span>{checkLabel(firstFailed.id)}</span>
              {getCheckSuggestion(firstFailed.id) ? (
                <span className="text-sm text-muted">
                  {' '}
                  — {getCheckSuggestion(firstFailed.id)}
                </span>
              ) : null}
            </GuidanceRow>
          ) : null}
        </div>
      </Card>
    );
  }

  return (
    <Card title="交付落点与下一步" compact className="mb-6">
      <div style={{ padding: '12px 24px' }}>
        <GuidanceRow label="交付分支">
          <span style={monoRowStyle}>{delivery.diff.branch}</span>
          <span className="text-sm text-muted">（基线 {delivery.diff.baseBranch}）</span>
        </GuidanceRow>

        {delivery.worktrees.length > 0 ? (
          <GuidanceRow label="Worktree">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {delivery.worktrees.map((lease) => (
                <div key={lease.id}>
                  <span style={monoRowStyle}>{lease.worktreePath}</span>
                  <span className="text-sm text-muted">
                    {' '}
                    — {lease.role}/{lease.nodeId} 分支 {lease.branchName}（
                    {lease.releasedAt ? '已释放' : '使用中'}）
                  </span>
                </div>
              ))}
            </div>
          </GuidanceRow>
        ) : null}

        {packagePath ? (
          <GuidanceRow label="PR 包路径">
            <span style={monoRowStyle}>{packagePath}</span>
          </GuidanceRow>
        ) : null}
        {bodyPath ? (
          <GuidanceRow label="PR Body 路径">
            <span style={monoRowStyle}>{bodyPath}</span>
          </GuidanceRow>
        ) : null}

        {nextCommands.length > 0 ? (
          <div style={{ marginTop: '10px', borderTop: '1px solid var(--border-l)', paddingTop: '8px' }}>
            <div style={{ fontWeight: 600, marginBottom: '6px' }}>下一步</div>
            {nextCommands.map((cmd, idx) => (
              <div
                key={idx}
                style={{
                  fontFamily: 'var(--font-m)',
                  fontSize: '12px',
                  padding: '6px 12px',
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
        ) : null}
      </div>
    </Card>
  );
}

export function DeliveryTab() {
  const { runId } = useParams<{ runId: string }>();
  const scope = useAuthScope();
  const [searchParams] = useSearchParams();
  const section = searchParams.get('section');
  const sectionIds = { 'pr-body': 'pr-body', 'pr-package': 'pr-package', diff: 'delivery-diff' };
  const targetId = section && Object.hasOwn(sectionIds, section) ? sectionIds[section as keyof typeof sectionIds] : null;

  const query = useQuery<ApiWorkReviewSurface>(
    runId ? queryKeys.reviewDetail(runId, scope) : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  useEvidenceTarget(targetId, !query.isLoading && !query.error && !!query.data, runId);

  if (query.isLoading)
    return <LoadingState message="Loading delivery status..." />;
  if (query.error)
    return <ErrorBanner error={query.error} onRetry={query.refetch} />;
  if (!query.data)
    return <EmptyState message="No delivery data available" />;

  const { delivery } = query.data;
  const workflowStatus = query.data.workflowStatus;

  return (
    <>
      {section && !targetId ? <p role="status">未找到该交付章节</p> : null}
      {/* ── Delivery Pipeline Stepper ── */}
      <Card
        title="交付管道 Delivery Pipeline"
        headerRight={<StatusBadge status={delivery.status} size="sm" />}
        compact
        className="mb-6"
      >
        <DeliveryPipeline
          delivery={delivery}
          workflowStatus={workflowStatus}
        />

        {delivery.prUrl ? (
          <div
            style={{
              padding: '12px 24px',
              borderTop: '1px solid var(--border-l)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span className="text-sm text-muted">PR URL:</span>
            <a
              href={delivery.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--accent)',
                fontFamily: 'var(--font-m)',
                fontSize: '12px',
                textDecoration: 'none',
              }}
            >
              {delivery.prUrl}
            </a>
          </div>
        ) : null}
      </Card>

      {/* ── Delivery locations & next steps (PD-21) ── */}
      <DeliveryGuidanceCard surface={query.data} />

      {/* ── Diff Summary ── */}
      <div className="section evidence-target" id="delivery-diff" tabIndex={-1}>
        <div className="section-title">变更 Diff</div>
        <Card>
          <DiffViewer diff={delivery.diff} />
        </Card>
      </div>

      {/* ── PR Package Preview ── */}
      <div className="panel-grid">
        <section id="pr-package" tabIndex={-1} className="evidence-target">
        <Card
          title="PR Package"
          headerRight={
            delivery.package ? (
              <span className="text-mono text-muted">
                {delivery.package.truncated ? 'truncated' : 'complete'}
              </span>
            ) : null
          }
        >
          {delivery.package !== null && delivery.package.exists ? (
            <CodeBlock
              content={delivery.package.content}
              truncated={delivery.package.truncated}
              maxHeight={280}
            />
          ) : (
            <EmptyState
              message="No package"
              hint={
                delivery.package?.exists === false
                  ? 'Package file does not exist'
                  : 'Package will appear when prepared'
              }
            />
          )}
        </Card>
        </section>

        <section id="pr-body" tabIndex={-1} className="evidence-target">
        <Card
          title="PR Body"
          headerRight={
            delivery.prBody ? (
              <span className="text-mono text-muted">
                {delivery.prBody.truncated ? 'truncated' : 'complete'}
              </span>
            ) : null
          }
        >
          {delivery.prBody !== null && delivery.prBody.exists ? (
            <div style={{ padding: '0' }}>
              <CodeBlock
                content={delivery.prBody.content}
                truncated={delivery.prBody.truncated}
                maxHeight={280}
              />
            </div>
          ) : (
            <EmptyState
              message="No PR body"
              hint={
                delivery.prBody?.exists === false
                  ? 'PR body file does not exist'
                  : 'PR body will appear when prepared'
              }
            />
          )}
        </Card>
        </section>
      </div>
    </>
  );
}
