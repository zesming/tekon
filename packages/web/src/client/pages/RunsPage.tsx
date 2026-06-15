import { useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { useQuery, useAuthScope } from '../hooks/index.js';
import { rpc } from '../lib/rpc-client.js';
import { queryKeys } from '../lib/query-keys.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { FilterBar } from '../components/ui/FilterBar.js';
import type { FilterOption } from '../components/ui/FilterBar.js';
import { ErrorBanner } from '../components/ui/ErrorBanner.js';
import { StartRunForm } from '../components/runs/StartRunForm.js';
import { RunTable } from '../components/runs/RunTable.js';

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

const STATUS_FILTERS: FilterOption[] = [
  { value: 'all', label: '全部 All' },
  { value: 'running', label: '运行中 Running' },
  { value: 'passed', label: '已通过 Passed' },
  { value: 'failed', label: '已失败 Failed' },
  { value: 'paused', label: '已暂停 Paused' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function RunsPage() {
  const [searchParams] = useSearchParams();
  const scope = useAuthScope();

  // ── Fetch project overview (for header stats) ──
  const { data: overview, isLoading: overviewLoading, error: overviewError, refetch: refetchOverview } = useQuery<
    RpcProcedureMap['project.overview']['output']
  >(queryKeys.projectOverview(scope), () => rpc.call('project.overview'));

  // ── Fetch project detail (for runs list) ──
  // We use the project ID from overview to fetch detail.
  const projectId = overview?.project.id ?? null;

  const { data: detail, isLoading: detailLoading, error: detailError, refetch: refetchDetail } = useQuery<
    RpcProcedureMap['project.detail']['output']
  >(
    projectId ? queryKeys.projectDetail(projectId, scope) : null,
    () => rpc.call('project.detail', { projectId: projectId! }),
  );

  // ── Derive filtered runs ──
  const allRuns = detail?.runs ?? [];
  const statusFilter = searchParams.get('status') ?? 'all';
  const searchQuery = searchParams.get('q') ?? '';
  const sortParam = searchParams.get('sort') ?? 'newest';

  const filteredRuns = useMemo(() => {
    let runs = allRuns;

    // Status filter
    if (statusFilter !== 'all') {
      runs = runs.filter((r) => r.status === statusFilter);
    }

    // Text search (search across id, demandId, status)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      runs = runs.filter(
        (r) =>
          r.id.toLowerCase().includes(q) ||
          r.demandId.toLowerCase().includes(q) ||
          r.status.toLowerCase().includes(q),
      );
    }

    // Sort
    const sorted = [...runs];
    switch (sortParam) {
      case 'oldest':
        sorted.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        break;
      case 'status':
        sorted.sort((a, b) => a.status.localeCompare(b.status));
        break;
      case 'newest':
      default:
        sorted.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        break;
    }
    return sorted;
  }, [allRuns, statusFilter, searchQuery, sortParam]);

  // ── Counts for subtitle ──
  const totalRuns = allRuns.length;
  const runningCount = allRuns.filter((r) => r.status === 'running').length;

  return (
    <>
      {/* ── Page Header ── */}
      <header className="page-header">
        <div>
          <h1 className="page-title">运行管理 Runs</h1>
          <p className="page-subtitle">
            管理工作流运行 · Start, monitor, and control runs
            {overviewLoading ? '' : ` · ${totalRuns} runs`}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              refetchOverview();
              refetchDetail();
            }}
          >
            ↻ 刷新
          </button>
        </div>
      </header>

      {/* ── Error Banner ── */}
      {(overviewError || detailError) && (
        <ErrorBanner
          error={(overviewError ?? detailError)!}
          onRetry={() => {
            refetchOverview();
            refetchDetail();
          }}
        />
      )}

      {/* ── New Run Form ── */}
      <StartRunForm />

      {/* ── Toolbar: Search + Filters ── */}
      <div className="toolbar">
        <div className="toolbar-search">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <SearchInput />
        </div>
        <FilterBar options={STATUS_FILTERS} paramKey="status" defaultValue="all" />
        <SortSelect />
      </div>

      {/* ── Running indicator ── */}
      {runningCount > 0 && (
        <div
          className="flex items-center gap-2 mb-4"
          style={{ fontSize: 12, color: 'var(--text-s)' }}
        >
          <span className="badge badge-running badge-sm">running</span>
          <span>
            {runningCount} run{runningCount !== 1 ? 's' : ''} in progress
          </span>
        </div>
      )}

      {/* ── Runs Table ── */}
      <RunTable runs={filteredRuns} isLoading={detailLoading} />

      {/* ── Error state ── */}
      {detail && allRuns.length === 0 && !detailLoading && !detailError && (
        <div
          className="card"
          style={{ marginTop: 16 }}
        >
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              No runs yet. Use the form above to start your first run.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Search Input (reads/writes "q" URL search param)
// ---------------------------------------------------------------------------

function SearchInput() {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get('q') ?? '';

  return (
    <input
      className="input"
      aria-label="搜索运行"
      placeholder="Search runs…"
      value={value}
      onChange={(e) => {
        const q = e.target.value;
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          if (q) {
            next.set('q', q);
          } else {
            next.delete('q');
          }
          return next;
        });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sort Select (reads/writes "sort" URL search param)
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Status' },
] as const;

function SortSelect() {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get('sort') ?? 'newest';

  return (
    <select
      className="select"
      aria-label="Sort runs"
      value={value}
      onChange={(e) => {
        const sort = e.target.value;
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          if (sort && sort !== 'newest') {
            next.set('sort', sort);
          } else {
            next.delete('sort');
          }
          return next;
        });
      }}
    >
      {SORT_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
