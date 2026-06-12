import { useState, useCallback, useRef } from 'react';
import { queryCache } from '../lib/query-cache.js';

export interface UseMutationOptions {
  invalidateKeys?: string[];
}

export interface UseMutationResult<TIn, TOut> {
  mutate: (input: TIn) => Promise<TOut>;
  data: TOut | undefined;
  error: Error | null;
  isPending: boolean;
}

/**
 * React hook for mutations with optional cache invalidation.
 *
 * @param fetcher - Async function to perform the mutation
 * @param options - Optional configuration (e.g., keys to invalidate after success)
 * @returns Mutation result with mutate function, data, error, and pending state
 */
export function useMutation<TIn, TOut>(
  fetcher: (input: TIn) => Promise<TOut>,
  options?: UseMutationOptions,
): UseMutationResult<TIn, TOut> {
  const [data, setData] = useState<TOut | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutate = useCallback(async (input: TIn): Promise<TOut> => {
    setIsPending(true);
    setError(null);

    try {
      const result = await fetcherRef.current(input);
      setData(result);
      setIsPending(false);

      // Invalidate specified cache keys
      const keys = optionsRef.current?.invalidateKeys;
      if (keys && keys.length > 0) {
        for (const key of keys) {
          queryCache.invalidate(key);
        }
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setIsPending(false);
      throw error;
    }
  }, []);

  return { mutate, data, error, isPending };
}
