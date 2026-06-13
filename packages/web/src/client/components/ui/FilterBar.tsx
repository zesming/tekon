import { useSearchParams } from 'react-router';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterBarProps {
  /** The search-param key to use (default "status"). */
  paramKey?: string;
  /** Available filter options. */
  options: FilterOption[];
  /** Value to use when no param is present (default: first option). */
  defaultValue?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Horizontal row of filter chips backed by a URL search parameter.
 */
export function FilterBar({
  paramKey = 'status',
  options,
  defaultValue,
}: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const active =
    searchParams.get(paramKey) ?? defaultValue ?? options[0]?.value ?? '';

  return (
    <div className="filter-group">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`filter-chip${opt.value === active ? ' active' : ''}`}
          onClick={() => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              if (opt.value === (defaultValue ?? options[0]?.value ?? '')) {
                next.delete(paramKey);
              } else {
                next.set(paramKey, opt.value);
              }
              // Reset to first page when filter changes
              next.delete('page');
              return next;
            });
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
