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

// ---------------------------------------------------------------------------
// DeliveryTab — pipeline stepper, diff summary, PR package/body preview
// ---------------------------------------------------------------------------

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
