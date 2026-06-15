import { useState, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { useQuery, useAuthScope } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type {
  ArtifactListOutput,
  ApiWorkReviewSurface,
} from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { CodeBlock } from '../../components/ui/CodeBlock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const typeIconMap: Record<string, string> = {
  'demand-card': '📋',
  prd: '📐',
  'tech-design': '🔧',
  'code-changes': '💻',
  'test-report': '🧪',
  'test-plan': '📝',
  'implementation-plan': '📊',
  'review-report': '🔍',
  'process-checkpoint': '✅',
  'delivery-package': '📦',
  'qa-release-signoff': '🏁',
};

function getArtifactIcon(type: string): string {
  return typeIconMap[type] ?? '📄';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// ArtifactsTab
// ---------------------------------------------------------------------------

export function ArtifactsTab() {
  const { runId } = useParams<{ runId: string }>();
  const scope = useAuthScope();

  // Fetch artifact list from the dedicated endpoint
  const artifactQuery = useQuery<ArtifactListOutput>(
    runId ? queryKeys.artifacts(runId) : null,
    () => rpc.call('artifact.list', { runId: runId! }),
  );

  // Also fetch review surface to get artifact content previews
  const reviewQuery = useQuery<ApiWorkReviewSurface>(
    runId ? queryKeys.reviewDetail(runId, scope) : null,
    () => rpc.call('review.get', { runId: runId! }),
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const nodeFilter = searchParams.get('node') ?? '';
  const typeFilter = searchParams.get('type') ?? '';

  const setNodeFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set('node', value);
      } else {
        next.delete('node');
      }
      return next;
    });
  };

  const setTypeFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set('type', value);
      } else {
        next.delete('type');
      }
      return next;
    });
  };

  const artifacts = artifactQuery.data?.artifacts ?? [];
  const reviewArtifacts = reviewQuery.data?.artifacts ?? [];

  // Build a map of artifact id → content preview from review surface
  const contentMap = useMemo(() => {
    const map = new Map<string, { content: string; truncated: boolean }>();
    for (const ra of reviewArtifacts) {
      map.set(ra.id, {
        content: ra.content.content,
        truncated: ra.content.truncated,
      });
    }
    return map;
  }, [reviewArtifacts]);

  // Compute unique node and type values for filters
  const nodes = useMemo(
    () => [...new Set(artifacts.map((a) => a.nodeId))].sort(),
    [artifacts],
  );
  const types = useMemo(
    () => [...new Set(artifacts.map((a) => a.type))].sort(),
    [artifacts],
  );

  // Filter artifacts
  const filtered = useMemo(
    () =>
      artifacts.filter(
        (a) =>
          (nodeFilter === '' || a.nodeId === nodeFilter) &&
          (typeFilter === '' || a.type === typeFilter),
      ),
    [artifacts, nodeFilter, typeFilter],
  );

  // ── Loading ──
  if (artifactQuery.isLoading)
    return <LoadingState message="Loading artifacts..." />;
  if (artifactQuery.error)
    return <ErrorBanner error={artifactQuery.error} onRetry={artifactQuery.refetch} />;

  return (
    <>
      {/* ── Filters ── */}
      <div className="toolbar">
        <div className="filter-group">
          <button
            type="button"
            className={`filter-chip${nodeFilter === '' ? ' active' : ''}`}
            onClick={() => setNodeFilter('')}
          >
            All Nodes
          </button>
          {nodes.map((n) => (
            <button
              key={n}
              type="button"
              className={`filter-chip${nodeFilter === n ? ' active' : ''}`}
              onClick={() => setNodeFilter(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {types.length > 1 ? (
          <select
            className="select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={{ width: 'auto', minWidth: '140px' }}
          >
            <option value="">All Types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}

        <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
          {filtered.length} artifact{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Artifact List ── */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            message="No artifacts found"
            hint={
              artifacts.length === 0
                ? 'Artifacts will appear here as the workflow produces them.'
                : 'Try adjusting your filters.'
            }
          />
        </Card>
      ) : (
        <Card compact>
          <div className="artifact-list">
            {filtered.map((artifact) => {
              const isExpanded = expandedId === artifact.id;
              const preview = contentMap.get(artifact.id);

              return (
                <div key={artifact.id}>
                  <div
                    className="artifact-item"
                    tabIndex={0}
                    role="button"
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpandedId(isExpanded ? null : artifact.id)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedId(isExpanded ? null : artifact.id);
                      }
                    }}
                  >
                    <div className="artifact-icon">
                      {getArtifactIcon(artifact.type)}
                    </div>
                    <div className="artifact-info">
                      <div className="artifact-name">{artifact.type}</div>
                      <div className="artifact-path">{artifact.path}</div>
                    </div>
                    <div className="artifact-meta">
                      v{artifact.version} · {formatSize(artifact.sizeBytes)}
                    </div>
                  </div>

                  {/* Expanded content preview */}
                  {isExpanded ? (
                    <div
                      style={{
                        padding: '0 20px 16px 64px',
                      }}
                    >
                      {preview ? (
                        <CodeBlock
                          content={preview.content}
                          truncated={preview.truncated}
                          maxHeight={320}
                        />
                      ) : (
                        <div className="preview-block">
                          <div
                            className="text-mono text-muted"
                            style={{ fontSize: '12px' }}
                          >
                            path: {artifact.path}
                          </div>
                          <div
                            className="text-mono text-muted"
                            style={{ fontSize: '12px' }}
                          >
                            sha256: {artifact.sha256.slice(0, 16)}…
                          </div>
                          {artifact.summary ? (
                            <div
                              style={{
                                fontSize: '13px',
                                color: 'var(--text-s)',
                                marginTop: '8px',
                              }}
                            >
                              {artifact.summary}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
