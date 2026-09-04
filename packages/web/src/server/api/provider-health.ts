export type ProviderHealthStatus = 'available' | 'unavailable';

export interface ProviderHealthResult {
  provider: 'dsh-headless';
  status: ProviderHealthStatus;
  checkedAt: string;
}

export interface ProviderHealthInput {
  scope: string;
  tokenHash: string;
  provider: 'dsh-headless';
}

interface CacheEntry {
  result: ProviderHealthResult;
  cachedAt: number;
}

export function createProviderHealthService(options: {
  probe: () => Promise<ProviderHealthStatus>;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 128;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ProviderHealthResult>>();

  function keyFor(input: ProviderHealthInput): string {
    return `${input.scope}\0${input.provider}\0${input.tokenHash}`;
  }

  function cleanExpired(at: number): void {
    for (const [key, entry] of cache.entries()) {
      if (at - entry.cachedAt >= ttlMs) {
        cache.delete(key);
      }
    }
  }

  function setCache(key: string, entry: CacheEntry): void {
    if (cache.size >= maxEntries && !cache.has(key)) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, entry);
  }

  async function check(
    input: ProviderHealthInput,
  ): Promise<ProviderHealthResult> {
    const at = now();
    cleanExpired(at);
    const key = keyFor(input);
    const cached = cache.get(key);
    if (cached && at - cached.cachedAt < ttlMs) {
      return cached.result;
    }

    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const probe = (async () => {
      let status: ProviderHealthStatus;
      try {
        status = await options.probe();
      } catch {
        // Provider health is deliberately coarse and must never expose raw
        // process errors, paths, proxy URLs or environment values to the UI.
        status = 'unavailable';
      }
      const checkedAtMs = now();
      const result: ProviderHealthResult = {
        provider: input.provider,
        status,
        checkedAt: new Date(checkedAtMs).toISOString(),
      };
      setCache(key, { result, cachedAt: checkedAtMs });
      return result;
    })();
    inFlight.set(key, probe);
    try {
      return await probe;
    } finally {
      if (inFlight.get(key) === probe) {
        inFlight.delete(key);
      }
    }
  }

  return { check };
}
