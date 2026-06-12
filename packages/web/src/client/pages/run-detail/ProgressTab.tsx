import { useParams } from 'react-router';
import type { ReactNode } from 'react';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import type {
  ProgressListOutput,
  ApiWorkReviewSurface,
} from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { StatusBadge } from '../../components/ui/StatusBadge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readinessLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// InfoNote — inline callout for architectural notes
// ---------------------------------------------------------------------------

function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '12px 16px',
        marginTop: '16px',
        borderRadius: '6px',
        background: 'var(--bg-card, #1a1f2e)',
        border: '1px solid var(--border, #2a2f3e)',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--text-t, #8b92a8)',
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: 'var(--pend, #e5a23a)',
          color: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 700,
        }}
      >
        i
      </span>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProgressTab — progress display using progress.list + review.get fallback
//
// Uses the dedicated `progress.list` endpoint to read *.progress.json files
// from the run directory. Falls back to review.get for gate/artifact summary
// when no progress files are found.
// ---------------------------------------------------------------------------

export function ProgressTab() {
  const { runId } = useParams<{ runId: string }>();

  // Primary data source: progress.list
  const progressQuery = useQuery<ProgressListOutput>(
    runId ? `progress:${runId}` : null,
    () => rpc.call('progress.list', { runId: runId! }),
  );

  // Fallback/supplementary: review.get for gate timeline
  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    runId ? `review:${runId}` : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  const isLoading = progressQuery.isLoading || reviewQuery.isLoading;
  const error = progressQuery.error ?? reviewQuery.error;

  if (isLoading)
    return <LoadingState message="Loading progress..." />;
  if (error)
    return (
      <ErrorBanner
        error={error}
        onRetry={() => {
          progressQuery.refetch();
          reviewQuery.refetch();
        }}
      />
    );

  const progress = progressQuery.data;
  const surface = reviewQuery.data;
  const progressFiles = progress?.progressFiles ?? [];
  const hasProgress = progressFiles.length > 0;

  // Gate stats from review surface (supplementary)
  const gates = surface?.gates ?? [];
  const totalGates = gates.length;
  const passedGates = gates.filter((g) => g.status === 'passed').length;
  const failedGates = gates.filter((g) => g.status === 'failed').length;
  const runningGates = gates.filter((g) => g.status === 'running').length;
  const pendingGates = totalGates - passedGates - failedGates - runningGates;
  const progressPct =
    totalGates > 0 ? Math.round((passedGates / totalGates) * 100) : 0;

  return (
    <>
      {/* ── Command Progress Files ── */}
      {hasProgress ? (
        <Card title="命令进度 Command Progress" className="mb-6">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Status</th>
                  <th>Command</th>
                  <th>Elapsed</th>
                  <th>Last Updated</th>
                  <th>Last Output</th>
                  <th>Last OutputDir</th>
                  <th>Bytes (out/err)</th>
                  <th>Files</th>
                  <th>HB</th>
                  <th>Timeout Risk</th>
                </tr>
              </thead>
              <tbody>
                {progressFiles.map((pf, idx) => (
                  <tr key={idx}>
                    <td className="cell-mono">{pf.nodeId ?? '—'}</td>
                    <td>
                      <StatusBadge status={pf.status} size="sm" />
                    </td>
                    <td
                      className="cell-mono"
                      style={{
                        maxWidth: '200px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={pf.redactedCommand}
                    >
                      {pf.redactedCommand}
                    </td>
                    <td className="cell-mono">
                      {formatElapsed(pf.elapsedMs)}
                    </td>
                    <td className="cell-mono">
                      {formatTimestamp(pf.updatedAt)}
                    </td>
                    <td className="cell-mono">
                      {formatTimestamp(pf.lastOutputAt)}
                    </td>
                    <td className="cell-mono">
                      {formatTimestamp(pf.lastOutputDirAt)}
                    </td>
                    <td className="cell-mono">
                      {formatBytes(pf.stdoutBytes)} / {formatBytes(pf.stderrBytes)}
                    </td>
                    <td className="cell-mono">{pf.outputDirFileCount}</td>
                    <td className="cell-mono">{pf.heartbeatCount}</td>
                    <td className="cell-mono">
                      {pf.approachingTimeout ? (
                        <span
                          style={{ color: 'var(--fail)', fontWeight: 600 }}
                          title={`Timeout reason: ${pf.timeoutReason ?? 'none'}`}
                        >
                          ⚠ {pf.secondsRemaining}s
                          {pf.timeoutReason ? ` (${pf.timeoutReason})` : ''}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--pass)' }}>
                          {pf.secondsRemaining}s
                          {pf.timeoutReason ? ` (${pf.timeoutReason})` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <InfoNote>
            <strong>Data source:</strong> Reading from{' '}
            <code>progress.list</code> (*.progress.json). Only redacted
            summaries are returned — raw stdout/stderr is never exposed.
          </InfoNote>
        </Card>
      ) : (
        <Card title="命令进度 Command Progress" className="mb-6">
          <EmptyState
            message="No progress files found"
            hint="Progress files (*.progress.json) will appear here when a command is actively running."
          />
        </Card>
      )}

      {/* ── Workflow Gate Summary ── */}
      {surface ? (
        <Card title="运行进度 Workflow Progress" className="mb-6">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              marginBottom: '16px',
              flexWrap: 'wrap',
            }}
          >
            <StatusBadge status={surface.workflowStatus} />
            <span className="text-sm text-muted">
              {passedGates}/{totalGates} gates passed
            </span>
          </div>

          <div className="readiness-bar" style={{ height: '8px' }}>
            <div
              className={`readiness-fill ${readinessLevel(progressPct / 100)}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: '16px',
              marginTop: '20px',
              textAlign: 'center',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-d)',
                  fontSize: '28px',
                  fontWeight: 500,
                  color: 'var(--pass)',
                }}
              >
                {passedGates}
              </div>
              <div className="stat-label">Passed</div>
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-d)',
                  fontSize: '28px',
                  fontWeight: 500,
                  color: failedGates > 0 ? 'var(--fail)' : 'var(--text-t)',
                }}
              >
                {failedGates}
              </div>
              <div className="stat-label">Failed</div>
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-d)',
                  fontSize: '28px',
                  fontWeight: 500,
                  color: runningGates > 0 ? 'var(--pend)' : 'var(--text-t)',
                }}
              >
                {runningGates}
              </div>
              <div className="stat-label">Running</div>
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-d)',
                  fontSize: '28px',
                  fontWeight: 500,
                  color: pendingGates > 0 ? 'var(--pend)' : 'var(--text-t)',
                }}
              >
                {pendingGates}
              </div>
              <div className="stat-label">Pending</div>
            </div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-d)',
                  fontSize: '28px',
                  fontWeight: 500,
                }}
              >
                {surface.artifacts.length}
              </div>
              <div className="stat-label">Artifacts</div>
            </div>
          </div>
        </Card>
      ) : null}

      {/* ── Gate Timeline ── */}
      {gates.length > 0 ? (
        <Card title="门禁时间线 Gate Timeline">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Gate Type</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Retries</th>
                </tr>
              </thead>
              <tbody>
                {gates
                  .slice()
                  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                  .map((gate) => (
                    <tr key={gate.id}>
                      <td className="cell-mono">{gate.nodeId}</td>
                      <td className="cell-primary">{gate.gateType}</td>
                      <td>
                        <StatusBadge status={gate.status} size="sm" />
                      </td>
                      <td className="cell-mono">
                        {gate.durationMs < 1000
                          ? `${gate.durationMs}ms`
                          : `${(gate.durationMs / 1000).toFixed(1)}s`}
                      </td>
                      <td className="cell-mono">
                        {gate.retries > 0 ? gate.retries : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
