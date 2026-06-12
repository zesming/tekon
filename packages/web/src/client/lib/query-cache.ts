// ---------------------------------------------------------------------------
// Lightweight query cache with in-flight deduplication
// ---------------------------------------------------------------------------

type Subscriber = () => void;

interface CacheEntry<T = unknown> {
  data: T | undefined;
  error: Error | null;
  timestamp: number;
  stale: boolean;
  subscribers: Set<Subscriber>;
}

export class QueryCache {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<unknown>>();

  /**
   * Get cached data for a key, or undefined if not present.
   */
  get<T>(key: string): { data: T | undefined; error: Error | null; stale: boolean } | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    return { data: entry.data as T | undefined, error: entry.error, stale: entry.stale };
  }

  /**
   * Set cached data for a key and notify subscribers.
   */
  set<T>(key: string, data: T | undefined, error: Error | null = null): void {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {
        data,
        error,
        timestamp: Date.now(),
        stale: false,
        subscribers: new Set(),
      };
      this.cache.set(key, entry);
    } else {
      entry.data = data;
      entry.error = error;
      entry.timestamp = Date.now();
      entry.stale = false;
    }
    this.notify(key);
  }

  /**
   * Subscribe to changes for a key. Returns an unsubscribe function.
   */
  subscribe(key: string, callback: Subscriber): () => void {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {
        data: undefined,
        error: null,
        timestamp: Date.now(),
        stale: false,
        subscribers: new Set(),
      };
      this.cache.set(key, entry);
    }
    entry.subscribers.add(callback);
    return () => {
      entry.subscribers.delete(callback);
    };
  }

  /**
   * Invalidate all keys that start with the given prefix, marking them as stale
   * and notifying subscribers. Data is preserved so pages don't flash empty;
   * subscribers are expected to trigger a refetch when they see a stale entry.
   */
  invalidate(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        const entry = this.cache.get(key)!;
        entry.stale = true;
        entry.timestamp = Date.now();
        this.notify(key);
      }
    }
  }

  /**
   * Invalidate all keys matching a prefix. (Alias for `invalidate` which now
   * does prefix matching by default.)
   */
  prefixInvalidate(prefix: string): void {
    this.invalidate(prefix);
  }

  /**
   * Get or create an in-flight promise for deduplication.
   */
  getInFlight<T>(key: string): Promise<T> | undefined {
    return this.inFlight.get(key) as Promise<T> | undefined;
  }

  /**
   * Set an in-flight promise for deduplication.
   */
  setInFlight<T>(key: string, promise: Promise<T>): Promise<T> {
    this.inFlight.set(key, promise);
    promise
      .catch(() => undefined) // suppress unhandled rejection on the cleanup chain
      .finally(() => {
        this.inFlight.delete(key);
      });
    return promise;
  }

  private notify(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    for (const sub of entry.subscribers) {
      sub();
    }
  }
}

// Singleton export
export const queryCache = new QueryCache();
