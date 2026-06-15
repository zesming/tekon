import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { AuditListOutput } from '../../../shared/api-types.js';

import { Card } from '../../components/ui/Card.js';
import { LoadingState } from '../../components/ui/LoadingState.js';
import { ErrorBanner } from '../../components/ui/ErrorBanner.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { AuditTimeline } from '../../components/audit/AuditTimeline.js';
import { HashChainStatus } from '../../components/audit/HashChainStatus.js';

// ---------------------------------------------------------------------------
// AuditTab — hash chain verification, filters, timeline
// ---------------------------------------------------------------------------

export function AuditTab() {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const nodeFilter = searchParams.get('node') ?? '';
  const gateFilter = searchParams.get('gate') ?? '';
  const roleFilter = searchParams.get('role') ?? '';

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

  const setGateFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set('gate', value);
      } else {
        next.delete('gate');
      }
      return next;
    });
  };

  const setRoleFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set('role', value);
      } else {
        next.delete('role');
      }
      return next;
    });
  };

  const auditQuery = useQuery<AuditListOutput>(
    runId ? queryKeys.auditLog(runId) : null,
    () => rpc.call('audit.list', { runId: runId! }),
  );

  // Compute unique filter values
  const nodes = useMemo(() => {
    if (!auditQuery.data) return [];
    return [
      ...new Set(
        auditQuery.data.events
          .map((e) => e.nodeId)
          .filter((n): n is string => n !== null),
      ),
    ].sort();
  }, [auditQuery.data]);

  const gates = useMemo(() => {
    if (!auditQuery.data) return [];
    return [
      ...new Set(
        auditQuery.data.events
          .map((e) => e.gateId)
          .filter((g): g is string => g !== null),
      ),
    ].sort();
  }, [auditQuery.data]);

  const roles = useMemo(() => {
    if (!auditQuery.data) return [];
    return [
      ...new Set(
        auditQuery.data.events
          .map((e) => e.role)
          .filter((r): r is string => r !== null),
      ),
    ].sort();
  }, [auditQuery.data]);

  // Filter events
  const filteredEvents = useMemo(() => {
    if (!auditQuery.data) return [];
    return auditQuery.data.events.filter((e) => {
      if (nodeFilter && e.nodeId !== nodeFilter) return false;
      if (gateFilter && e.gateId !== gateFilter) return false;
      if (roleFilter && e.role !== roleFilter) return false;
      return true;
    });
  }, [auditQuery.data, nodeFilter, gateFilter, roleFilter]);

  if (auditQuery.isLoading)
    return <LoadingState message="Loading audit events..." />;
  if (auditQuery.error)
    return <ErrorBanner error={auditQuery.error} onRetry={auditQuery.refetch} />;
  if (!auditQuery.data)
    return <EmptyState message="No audit data available" />;

  const { verification, events } = auditQuery.data;
  const hasActiveFilter = nodeFilter || gateFilter || roleFilter;

  return (
    <>
      {/* ── Hash Chain Verification ── */}
      <Card
        title="审计链 Audit Chain"
        headerRight={
          <HashChainStatus
            verification={verification}
            eventCount={events.length}
          />
        }
        className="mb-6"
      >
        <div
          style={{
            padding: '12px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: verification.valid
              ? 'var(--pass-bg)'
              : 'var(--fail-bg)',
            fontSize: '13px',
          }}
        >
          {verification.valid ? (
            <>
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="var(--pass)"
                strokeWidth="2"
              >
                <path d="M2 9l5 5L16 4" />
              </svg>
              <span style={{ fontWeight: 600, color: '#065f46' }}>
                Chain integrity verified
              </span>
              <span className="text-muted">
                {events.length} events · all hashes match
              </span>
            </>
          ) : (
            <>
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="var(--fail)"
                strokeWidth="2"
              >
                <path d="M4 4l10 10M14 4L4 14" />
              </svg>
              <span style={{ fontWeight: 600, color: '#991b1b' }}>
                Chain integrity broken
              </span>
              <span className="text-muted">
                Broken at event:{' '}
                <span className="text-mono">
                  {'brokenEventId' in verification
                    ? verification.brokenEventId.slice(0, 12)
                    : '—'}
                </span>
              </span>
            </>
          )}
        </div>
      </Card>

      {/* ── Filter Inputs ── */}
      <div className="toolbar">
        <div className="form-row" style={{ flex: 1 }}>
          <div>
            <label className="form-label">Node</label>
            <select
              className="select"
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
            >
              <option value="">All Nodes</option>
              {nodes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">Gate</label>
            <select
              className="select"
              value={gateFilter}
              onChange={(e) => setGateFilter(e.target.value)}
            >
              <option value="">All Gates</option>
              {gates.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">Role</label>
            <select
              className="select"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="">All Roles</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: '8px',
            paddingTop: '22px',
          }}
        >
          {hasActiveFilter ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete('node');
                  next.delete('gate');
                  next.delete('role');
                  return next;
                });
              }}
            >
              ✕ Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Event count ── */}
      <div
        className="text-sm text-muted"
        style={{ marginBottom: '12px' }}
      >
        {hasActiveFilter
          ? `${filteredEvents.length} of ${events.length} events (filtered)`
          : `${events.length} events`}
      </div>

      {/* ── Timeline ── */}
      {filteredEvents.length === 0 ? (
        <Card>
          <EmptyState
            message="No events match"
            hint={
              hasActiveFilter
                ? 'Try adjusting your filter criteria.'
                : 'Audit events will appear here as the workflow progresses.'
            }
          />
        </Card>
      ) : (
        <Card compact>
          <AuditTimeline events={filteredEvents} />
        </Card>
      )}
    </>
  );
}
