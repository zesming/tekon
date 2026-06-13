import { useState, useMemo } from 'react';

import { useQuery, useMutation, useSessionToken } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import type {
  ProjectOverviewOutput,
  ApiWorkReviewSurface,
  DeliveryPrepareOutput,
  DeliveryCreatePrOutput,
  DeliveryCiStatusOutput,
  DeliveryDryRunOutput,
} from '../../shared/api-types.js';

import { Card } from '../components/ui/Card.js';
import { StatusBadge } from '../components/ui/StatusBadge.js';
import { LoadingState } from '../components/ui/LoadingState.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { CodeBlock } from '../components/ui/CodeBlock.js';
import { DeliveryPipeline } from '../components/delivery/DeliveryPipeline.js';
import { DiffViewer } from '../components/delivery/DiffViewer.js';

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

// ---------------------------------------------------------------------------
// DeliveryPage — full delivery pipeline view for the latest run
// ---------------------------------------------------------------------------

export function DeliveryPage() {
  const { token } = useSessionToken();
  const [showCreatePrConfirm, setShowCreatePrConfirm] = useState(false);
  const [prResult, setPrResult] = useState<DeliveryCreatePrOutput | null>(null);

  // ── 1. Project overview → latest run ───────────────────────────────────
  const overviewQuery = useQuery<ProjectOverviewOutput>(
    'delivery:overview',
    () => rpc.call('project.overview'),
  );

  const latestRunId = overviewQuery.data?.latestRun?.id ?? null;

  // ── 2. Review surface for latest run ───────────────────────────────────
  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    latestRunId ? `delivery:review:${latestRunId}` : null,
    () => rpc.call('review.get', { runId: latestRunId! }),
  );

  // ── 2b. CI status for latest run ──────────────────────────────────────
  const ciStatusQuery = useQuery<DeliveryCiStatusOutput>(
    latestRunId && token ? `delivery:ciStatus:${latestRunId}:${simpleHash(token)}` : null,
    () => rpc.call('delivery.ciStatus', { runId: latestRunId!, token: token! }),
  );

  const review = reviewQuery.data;
  const delivery = review?.delivery;
  const ciStatus = ciStatusQuery.data;

  // ── 3. Mutations ───────────────────────────────────────────────────────
  const prepareMutation = useMutation<
    { runId: string; token: string },
    DeliveryPrepareOutput
  >(
    (input) => rpc.call('delivery.prepare', input),
    { invalidateKeys: [`delivery:review:${latestRunId}`, `delivery:overview`] },
  );

  const createPrMutation = useMutation<
    { runId: string; token: string; approveHuman: true },
    DeliveryCreatePrOutput
  >(
    (input) => rpc.call('delivery.createPr', input),
    { invalidateKeys: [`delivery:review:${latestRunId}`, `delivery:overview`] },
  );

  const dryRunMutation = useMutation<
    { runId: string; token: string },
    DeliveryDryRunOutput
  >(
    (input) => rpc.call('delivery.dryRun', input),
    { invalidateKeys: [`delivery:review:${latestRunId}`] },
  );

  // ── Derived state ──────────────────────────────────────────────────────
  const canPrepare = useMemo(() => {
    if (!latestRunId || !token) return false;
    const wfStatus = review?.workflowStatus;
    return wfStatus === 'passed' || wfStatus === 'completed';
  }, [latestRunId, token, review?.workflowStatus]);

  const canCreatePr = useMemo(() => {
    if (!latestRunId || !token) return false;
    if (!delivery) return false;
    const hasPackage = delivery.package !== null && delivery.package.exists;
    const hasBody = delivery.prBody !== null && delivery.prBody.exists;
    if (!(hasPackage || hasBody) || delivery.prUrl !== null) return false;
    const wfStatus = review?.workflowStatus;
    if (wfStatus !== 'passed' && wfStatus !== 'completed') return false;
    if (review?.prePullRequestReadiness && !review.prePullRequestReadiness.ready) return false;
    return true;
  }, [latestRunId, token, delivery, review?.workflowStatus, review?.prePullRequestReadiness]);

  const canDryRun = useMemo(() => {
    if (!latestRunId || !token) return false;
    const wfStatus = review?.workflowStatus;
    return (
      wfStatus === 'passed' || wfStatus === 'completed' || wfStatus === 'paused'
    );
  }, [latestRunId, token, review?.workflowStatus]);

  const hasPrUrl = delivery?.prUrl !== null && delivery?.prUrl !== undefined;

  // ── Handlers ───────────────────────────────────────────────────────────
  const handlePrepare = async () => {
    if (!latestRunId || !token) return;
    try {
      await prepareMutation.mutate({ runId: latestRunId, token });
      reviewQuery.refetch();
    } catch {
      // error already captured in mutation state
    }
  };

  const handleCreatePr = async () => {
    if (!latestRunId || !token) return;
    try {
      const result = await createPrMutation.mutate({
        runId: latestRunId,
        token,
        approveHuman: true,
      });
      setPrResult(result);
      setShowCreatePrConfirm(false);
      overviewQuery.refetch();
      reviewQuery.refetch();
      ciStatusQuery.refetch();
    } catch {
      // error already captured in mutation state
    }
  };

  const handleDryRun = async () => {
    if (!latestRunId || !token) return;
    try {
      await dryRunMutation.mutate({ runId: latestRunId, token });
    } catch {
      // error already captured in mutation state
    }
  };

  // ── Loading state ──────────────────────────────────────────────────────
  if (overviewQuery.isLoading) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">交付管道</p>
          </div>
        </header>
        <LoadingState message="Loading project overview..." />
      </>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────
  if (overviewQuery.error) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">交付管道</p>
          </div>
        </header>
        <ErrorBanner error={overviewQuery.error} onRetry={overviewQuery.refetch} />
      </>
    );
  }

  // ── No run state ───────────────────────────────────────────────────────
  if (!latestRunId) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">交付管道</p>
          </div>
        </header>
        <EmptyState
          message="No workflow runs"
          hint="Start a workflow run to see delivery status here."
        />
      </>
    );
  }

  // ── Review loading / error ─────────────────────────────────────────────
  if (reviewQuery.isLoading) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">
              交付管道 · {overviewQuery.data?.project.name ?? 'Tekon'}
            </p>
          </div>
        </header>
        <LoadingState message="Loading delivery surface..." />
      </>
    );
  }

  if (reviewQuery.error) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">
              交付管道 · {overviewQuery.data?.project.name ?? 'Tekon'}
            </p>
          </div>
        </header>
        <ErrorBanner error={reviewQuery.error} onRetry={reviewQuery.refetch} />
      </>
    );
  }

  if (!review || !delivery) {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Delivery</h1>
            <p className="page-subtitle">
              交付管道 · {overviewQuery.data?.project.name ?? 'Tekon'}
            </p>
          </div>
        </header>
        <EmptyState message="No delivery data available" />
      </>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Header ── */}
      <header className="page-header">
        <div>
          <h1 className="page-title">Delivery</h1>
          <p className="page-subtitle">
            交付管道 · {review.demand.title}
            {latestRunId ? ` — ${latestRunId.slice(0, 8)}…` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              overviewQuery.refetch();
              reviewQuery.refetch();
              ciStatusQuery.refetch();
            }}
          >
            ↻ 刷新
          </button>
        </div>
      </header>

      {/* ── Delivery Pipeline Stepper ── */}
      <Card
        title="交付管道 Delivery Pipeline"
        headerRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <StatusBadge status={review.workflowStatus} size="sm" />
            <StatusBadge status={delivery.status} size="sm" />
          </div>
        }
        compact
        className="mb-6"
      >
        <DeliveryPipeline
          delivery={delivery}
          workflowStatus={review.workflowStatus}
        />

        {/* PR URL link */}
        {hasPrUrl ? (
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
              href={delivery.prUrl!}
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

      {/* ── Mutation feedback ── */}
      {prepareMutation.error ? (
        <ErrorBanner error={prepareMutation.error} />
      ) : null}
      {createPrMutation.error ? (
        <ErrorBanner error={createPrMutation.error} />
      ) : null}
      {dryRunMutation.error ? (
        <ErrorBanner error={dryRunMutation.error} />
      ) : null}

      {/* PR creation result */}
      {prResult !== null ? (
        <div
          style={{
            padding: '16px 20px',
            marginBottom: '24px',
            background: prResult.prUrl ? 'var(--pass-bg)' : 'var(--pend-bg)',
            border: `1px solid ${prResult.prUrl ? '#a7f3d0' : '#fde68a'}`,
            borderRadius: 'var(--r-md)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '4px' }}>
            {prResult.prUrl ? 'PR Created Successfully' : 'PR Creation In Progress'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-s)' }}>
            Status: {prResult.deliveryStatus}
            {prResult.branch ? ` · Branch: ${prResult.branch}` : ''}
            {prResult.failureStage ? ` · Failure: ${prResult.failureStage}` : ''}
          </div>
          {prResult.prUrl ? (
            <a
              href={prResult.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                marginTop: '8px',
                color: 'var(--accent)',
                fontFamily: 'var(--font-m)',
                fontSize: '12px',
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              {prResult.prUrl} →
            </a>
          ) : null}
          {prResult.lastError ? (
            <div
              style={{
                marginTop: '8px',
                fontSize: '12px',
                color: 'var(--fail)',
                fontFamily: 'var(--font-m)',
              }}
            >
              {prResult.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── CI Status (from delivery.ciStatus) ── */}
      <div className="section">
        <div className="section-title">
          CI Status
          {ciStatus ? (
            <span className="count">{ciStatus.checks.length}</span>
          ) : null}
        </div>
        <Card compact>
          {ciStatusQuery.isLoading ? (
            <div style={{ padding: '16px 20px' }}>
              <LoadingState message="Loading CI status..." />
            </div>
          ) : ciStatus && ciStatus.checks.length > 0 ? (
            <div>
              {/* CI summary bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 20px',
                  borderBottom: '1px solid var(--border-l)',
                  fontSize: '12px',
                  color: 'var(--text-s)',
                }}
              >
                <StatusBadge status={ciStatus.status} size="sm" />
                <span style={{ fontWeight: 600 }}>
                  {ciStatus.checks.length} check{ciStatus.checks.length !== 1 ? 's' : ''}
                </span>
                {ciStatusQuery.error ? (
                  <span style={{ color: 'var(--fail)' }}>
                    (failed to refresh)
                  </span>
                ) : null}
              </div>
              {/* CI checks table */}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th>State</th>
                      <th>Bucket</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ciStatus.checks.map((check, idx) => (
                      <tr key={idx}>
                        <td className="cell-primary">{check.name}</td>
                        <td>
                          <StatusBadge
                            status={check.state ?? 'unknown'}
                            size="sm"
                          />
                        </td>
                        <td className="cell-mono">
                          {check.bucket ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : ciStatusQuery.error ? (
            <div style={{ padding: '16px 20px' }}>
              <div style={{ color: 'var(--fail)', fontSize: '13px', fontWeight: 600 }}>
                CI status error: {ciStatusQuery.error.message}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => ciStatusQuery.refetch()}
              >
                Retry
              </button>
            </div>
          ) : (
            <div style={{ padding: '16px 20px' }}>
              <div style={{ color: 'var(--text-t)', fontSize: '13px' }}>
                No CI status available. CI checks will appear after a PR is
                created.
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ── Dry-Run Result ── */}
      {dryRunMutation.data ? (
        <Card title="Dry-Run Preview" className="mb-6">
          <div style={{ fontSize: '13px', lineHeight: 1.6 }}>
            <div style={{ marginBottom: '8px' }}>
              <strong>Workflow status:</strong>{' '}
              <StatusBadge
                status={dryRunMutation.data.workflowStatus}
                size="sm"
              />
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong>Artifacts:</strong>{' '}
              {dryRunMutation.data.artifacts}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong>Gates:</strong>{' '}
              {dryRunMutation.data.gates.passed}/{dryRunMutation.data.gates.total} passed
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong>Pending human decisions:</strong>{' '}
              {dryRunMutation.data.pendingHumanDecisions}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong>Delivery status:</strong>{' '}
              {dryRunMutation.data.deliveryStatus}
            </div>
            <div>
              <strong>Ready for prepare:</strong>{' '}
              {dryRunMutation.data.readyForPrepare ? (
                <span style={{ color: 'var(--ok, #2da44e)', fontWeight: 600 }}>
                  Yes
                </span>
              ) : (
                <span style={{ color: 'var(--pend, #bf8700)', fontWeight: 600 }}>
                  No
                </span>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ── Diff Summary ── */}
      <div className="section">
        <div className="section-title">变更 Diff</div>
        <Card>
          <DiffViewer diff={delivery.diff} />
        </Card>
      </div>

      {/* ── PR Package + Body Preview ── */}
      <div className="panel-grid">
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
            <CodeBlock
              content={delivery.prBody.content}
              truncated={delivery.prBody.truncated}
              maxHeight={280}
            />
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
      </div>

      {/* ── Action Buttons ── */}
      <div className="section">
        <div className="section-title">操作 Actions</div>
        <Card>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            {/* Dry Run */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canDryRun || dryRunMutation.isPending}
              onClick={handleDryRun}
            >
              {dryRunMutation.isPending ? 'Running…' : 'Dry Run'}
            </button>

            {/* Prepare PR */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canPrepare || prepareMutation.isPending}
              onClick={handlePrepare}
            >
              {prepareMutation.isPending ? 'Preparing…' : 'Prepare PR'}
            </button>

            {/* Create PR */}
            {!hasPrUrl ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canCreatePr || createPrMutation.isPending}
                onClick={() => setShowCreatePrConfirm(true)}
              >
                {createPrMutation.isPending ? 'Creating…' : 'Create PR'}
              </button>
            ) : null}

            {/* Token hint */}
            {!token ? (
              <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                Session token required for delivery actions
              </span>
            ) : null}
          </div>

          {/* Prepare result */}
          {prepareMutation.data ? (
            <div
              style={{
                marginTop: '12px',
                padding: '10px 14px',
                background: 'var(--pass-bg)',
                borderRadius: 'var(--r-sm)',
                fontSize: '12px',
                color: 'var(--text-s)',
                fontFamily: 'var(--font-m)',
              }}
            >
              Prepared branch{' '}
              <strong style={{ color: 'var(--text)' }}>
                {prepareMutation.data.branch}
              </strong>{' '}
              → {prepareMutation.data.baseBranch}
              {prepareMutation.data.requiresHumanApproval ? (
                <span style={{ color: 'var(--pend)', marginLeft: '8px' }}>
                  (requires human approval)
                </span>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      {/* ── Create PR Confirmation Dialog ── */}
      {showCreatePrConfirm ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 500,
            animation: 'viewFadeIn 0.15s ease',
          }}
          onClick={() => setShowCreatePrConfirm(false)}
        >
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 'var(--r-lg)',
              padding: '28px',
              maxWidth: '520px',
              width: '90vw',
              boxShadow: 'var(--sh-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '18px',
                fontWeight: 600,
                marginBottom: '16px',
              }}
            >
              ⚠ Create Pull Request
            </h3>

            <div
              style={{
                padding: '14px 16px',
                background: 'var(--fail-bg)',
                border: '1px solid #fecaca',
                borderRadius: 'var(--r-sm)',
                marginBottom: '16px',
                fontSize: '13px',
                lineHeight: 1.6,
                color: '#991b1b',
              }}
            >
              <strong>Warning:</strong> This action will push the branch{' '}
              <code
                style={{
                  fontFamily: 'var(--font-m)',
                  fontSize: '12px',
                  background: 'rgba(0,0,0,0.06)',
                  padding: '1px 4px',
                  borderRadius: '3px',
                }}
              >
                {delivery.diff.branch || '<branch>'}
              </code>{' '}
              to the remote repository and create a pull request via the GitHub CLI
              (<code style={{ fontFamily: 'var(--font-m)', fontSize: '12px' }}>
                gh pr create
              </code>
              ). This operation cannot be undone.
            </div>

            <div
              style={{
                fontSize: '13px',
                color: 'var(--text-s)',
                marginBottom: '20px',
                lineHeight: 1.6,
              }}
            >
              <div style={{ marginBottom: '8px' }}>
                <strong>Branch:</strong>{' '}
                <span className="text-mono">
                  {delivery.diff.branch || 'unknown'} →{' '}
                  {delivery.diff.baseBranch || 'unknown'}
                </span>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <strong>Changed files:</strong> {delivery.diff.changedFiles.length}
              </div>
              <div>
                <strong>Run:</strong>{' '}
                <span className="text-mono">{latestRunId}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowCreatePrConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={createPrMutation.isPending}
                onClick={handleCreatePr}
              >
                {createPrMutation.isPending
                  ? 'Creating PR…'
                  : 'Confirm & Create PR'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
