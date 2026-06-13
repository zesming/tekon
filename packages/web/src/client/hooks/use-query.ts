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
  const [data, setData] = useState<T | undefined>(() => {
    if (!key) return undefined;
    const cached = queryCache.get<T>(key);
    return cached?.data;
  });

  const [error, setError] = useState<Error | null>(() => {
    if (!key) return null;
    const cached = queryCache.get<T>(key);
    return cached?.error ?? null;
  });

  const [isLoading, setIsLoading] = useState(() => {
    if (!key) return false;
    const cached = queryCache.get<T>(key);
    return !cached || (cached.data === undefined && cached.error === null) || cached.stale;
  });

  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Stale-request protection: monotonically increasing generation counter
  const generationRef = useRef(0);
  // Abort controller for the current in-flight request
  const abortRef = useRef<AbortController | null>(null);

  const doFetch = useCallback(async () => {
    if (!key) return;

    // Bump generation so any in-flight request becomes stale
    const myGeneration = ++generationRef.current;

    // Abort the previous in-flight request (best-effort cancellation)
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Check for in-flight request (only join if same generation)
    const inFlight = queryCache.getInFlight<T>(key);
    if (inFlight) {
      try {
        const result = await inFlight;
        if (mountedRef.current && generationRef.current === myGeneration) {
          setData(result);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (mountedRef.current && generationRef.current === myGeneration) {
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
        if (mountedRef.current && generationRef.current === myGeneration) {
          setData(result);
          setError(null);
          setIsLoading(false);
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        queryCache.set(key, undefined, error);
        if (mountedRef.current && generationRef.current === myGeneration) {
          setError(error);
          setIsLoading(false);
        }
        throw error;
      }
    })();

    queryCache.setInFlight(key, promise);

    try {
      await promise;
    } catch {
      // Error already handled above
    }
  }, [key]);

  useEffect(() => {
    mountedRef.current = true;

    if (!key) {
      // Bump generation to invalidate any in-flight request from the previous key
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

    // Subscribe to cache updates
    const unsubscribe = queryCache.subscribe(key, () => {
      const cached = queryCache.get<T>(key);
      if (cached && mountedRef.current) {
        setData(cached.data);
        setError(cached.error);
        setIsLoading(false);
        if (cached.stale) {
          doFetch();  // Trigger refetch when entry is marked stale
        }
      }
    });

    // Fetch if not cached or stale
    const cached = queryCache.get<T>(key);
    if (!cached || (cached.data === undefined && cached.error === null) || cached.stale) {
      doFetch();
    } else {
      setData(cached.data);
      setError(cached.error);
      setIsLoading(false);
    }

    return () => {
      mountedRef.current = false;
      // Bump generation to invalidate any in-flight request so it cannot
      // write stale data if it resolves after the next key mounts.
      ++generationRef.current;
      unsubscribe();
      // Abort any in-flight request when the key changes or component unmounts
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [key, doFetch]);

  const refetch = useCallback(() => {
    if (key) {
      queryCache.invalidate(key);
      doFetch();
    }
  }, [key, doFetch]);

  return { data, error, isLoading, refetch };
}
