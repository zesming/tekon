import { useState, useEffect, useCallback, useRef } from 'react';
import { queryCache } from '../lib/query-cache.js';

export interface UseQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

/**
 * React hook for fetching and caching data.
 *
 * @param key - Cache key (null to disable fetching)
 * @param fetcher - Async function to fetch data
 * @returns Query result with data, error, loading state, and refetch function
 */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): UseQueryResult<T> {
  const initialCache = key ? queryCache.get<T>(key) : undefined;
  const [data, setData] = useState<T | undefined>(initialCache?.data);
  const [error, setError] = useState<Error | null>(
    initialCache?.error ?? null,
  );
  const [isLoading, setIsLoading] = useState(() => {
    if (!key) return false;
    return (
      !initialCache ||
      (initialCache.data === undefined && initialCache.error === null) ||
      initialCache.stale
    );
  });

  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // The state variables above belong to this key. A key-changing render occurs
  // before the effect can reset them, so the returned projection masks the old
  // key synchronously instead of briefly showing or acting on stale data.
  const stateKeyRef = useRef<string | null>(key);

  // Stale-request protection: monotonically increasing generation counter.
  const generationRef = useRef(0);
  // Abort controller for the current in-flight request.
  const abortRef = useRef<AbortController | null>(null);

  const doFetch = useCallback(async () => {
    if (!key) return;

    // Bump generation so any in-flight request becomes stale.
    const myGeneration = ++generationRef.current;

    // Abort the previous in-flight request (best-effort cancellation).
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Join an existing request for this cache key. Generation guards still
    // prevent a result from writing into a later key.
    const inFlight = queryCache.getInFlight<T>(key);
    if (inFlight) {
      try {
        const result = await inFlight;
        if (
          mountedRef.current &&
          stateKeyRef.current === key &&
          generationRef.current === myGeneration
        ) {
          setData(result);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (
          mountedRef.current &&
          stateKeyRef.current === key &&
          generationRef.current === myGeneration
        ) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
      return;
    }

    setIsLoading(true);

    const promise = (async () => {
      try {
        const result = await fetcherRef.current();
        queryCache.set(key, result, null);
        if (
          mountedRef.current &&
          stateKeyRef.current === key &&
          generationRef.current === myGeneration
        ) {
          setData(result);
          setError(null);
          setIsLoading(false);
        }
        return result;
      } catch (err) {
        const fetchError =
          err instanceof Error ? err : new Error(String(err));
        queryCache.set(key, undefined, fetchError);
        if (
          mountedRef.current &&
          stateKeyRef.current === key &&
          generationRef.current === myGeneration
        ) {
          setData(undefined);
          setError(fetchError);
          setIsLoading(false);
        }
        throw fetchError;
      }
    })();

    queryCache.setInFlight(key, promise);

    try {
      await promise;
    } catch {
      // Error already handled above.
    }
  }, [key]);

  useEffect(() => {
    mountedRef.current = true;
    stateKeyRef.current = key;

    if (!key) {
      // Bump generation to invalidate any in-flight request from the previous key.
      ++generationRef.current;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      setData(undefined);
      setError(null);
      setIsLoading(false);
      return;
    }

    const cached = queryCache.get<T>(key);
    // Reset state to the new key before fetching. Without this, a plan or
    // credential-scoped query can briefly display the previous key's data.
    setData(cached?.data);
    setError(cached?.error ?? null);
    setIsLoading(
      !cached ||
        (cached.data === undefined && cached.error === null) ||
        cached.stale,
    );

    // Subscribe to cache updates.
    const unsubscribe = queryCache.subscribe(key, () => {
      const next = queryCache.get<T>(key);
      if (next && mountedRef.current && stateKeyRef.current === key) {
        setData(next.data);
        setError(next.error);
        setIsLoading(false);
        if (next.stale) {
          void doFetch();
        }
      }
    });

    // Fetch if not cached or stale.
    if (
      !cached ||
      (cached.data === undefined && cached.error === null) ||
      cached.stale
    ) {
      void doFetch();
    }

    return () => {
      mountedRef.current = false;
      // Bump generation to invalidate any in-flight request so it cannot
      // write stale data if it resolves after the next key mounts.
      ++generationRef.current;
      unsubscribe();
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [key, doFetch]);

  const refetch = useCallback(() => {
    if (key) {
      queryCache.invalidate(key);
      void doFetch();
    }
  }, [key, doFetch]);

  // During the key-changing render, the effect has not reset React state yet.
  // Project directly from the new key's cache (or an empty loading state) so
  // consumers never see the previous query's payload under the new key.
  if (stateKeyRef.current !== key) {
    if (!key) {
      return { data: undefined, error: null, isLoading: false, refetch };
    }
    const cached = queryCache.get<T>(key);
    return {
      data: cached?.data,
      error: cached?.error ?? null,
      isLoading:
        !cached ||
        (cached.data === undefined && cached.error === null) ||
        cached.stale,
      refetch,
    };
  }

  return { data, error, isLoading, refetch };
}
