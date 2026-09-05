import { useState, useEffect, useCallback, useRef } from 'react';
import { queryCache } from '../lib/query-cache.js';

export interface UseQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

function readSnapshot<T>(key: string | null) {
  const cached = key ? queryCache.get<T>(key) : undefined;
  return {
    data: cached?.data,
    error: cached?.error ?? null,
    isLoading:
      !!key &&
      (!cached ||
        cached.isFetching ||
        cached.stale ||
        (cached.data === undefined && cached.error === null)),
  };
}

/** Subscribers only project owner-checked cache publications, never raw results. */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): UseQueryResult<T> {
  const [snapshot, setSnapshot] = useState(() => readSnapshot<T>(key));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stateKeyRef = useRef(key);

  const doFetch = useCallback(() => {
    if (!key) return;
    // Capture this render's fetcher before the async boundary. Cache owns the
    // request lifetime, so an initiating component may safely unmount.
    void queryCache.fetch(key, fetcherRef.current).catch(() => {
      // The cache publishes only errors belonging to the current request owner.
    });
  }, [key]);

  useEffect(() => {
    stateKeyRef.current = key;
    setSnapshot(readSnapshot<T>(key));
    if (!key) return;

    let active = true;
    const unsubscribe = queryCache.subscribe(key, () => {
      if (!active) return;
      setSnapshot(readSnapshot<T>(key));
      const cached = queryCache.get<T>(key);
      if (cached?.stale && !cached.isFetching) doFetch();
    });
    const cached = queryCache.get<T>(key);
    if (
      !cached ||
      cached.stale ||
      (cached.data === undefined && cached.error === null)
    ) {
      doFetch();
    }
    return () => {
      active = false;
      unsubscribe();
      // This only ends the subscription; no shared network request is aborted.
    };
  }, [key, doFetch]);

  const refetch = useCallback(() => {
    if (!key) return;
    queryCache.invalidate(key);
    doFetch();
  }, [key, doFetch]);

  // A key-changing render precedes effect cleanup. Hide the previous key's
  // payload synchronously, including during an A → B → A credential switch.
  return {
    ...(stateKeyRef.current === key ? snapshot : readSnapshot<T>(key)),
    refetch,
  };
}
