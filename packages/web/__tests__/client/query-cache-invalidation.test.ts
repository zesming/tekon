import { describe, expect, it } from 'vitest';

import { QueryCache } from '../../src/client/lib/query-cache.js';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// This is useQuery's subscription contract: the cache owns publication;
// subscribers fetch when invalidated and no request is already in flight.
function subscribeToRefresh(cache: QueryCache, key: string, fetcher: () => Promise<string>) {
  return cache.subscribe(key, () => {
    const snapshot = cache.get<string>(key);
    if (snapshot?.stale && !snapshot.isFetching) {
      void cache.fetch(key, fetcher).catch(() => undefined);
    }
  });
}

describe('query invalidation during an in-flight read', () => {
  for (const outcome of ['success', 'failure'] as const) {
    it(`does not publish invalidated ${outcome} and refetches once for shared subscribers`, async () => {
      const cache = new QueryCache();
      const old = deferred();
      const fresh = deferred();
      const key = 'gate.list.run1';
      cache.set(key, 'before');
      let calls = 0;
      const fetcher = () => ++calls === 1 ? old.promise : fresh.promise;
      const first = cache.fetch(key, fetcher).catch(() => undefined);
      await flush();
      const observed: Array<{ data?: string; error: Error | null }> = [];
      const observer = cache.subscribe(key, () => {
        const snapshot = cache.get<string>(key)!;
        observed.push({ data: snapshot.data, error: snapshot.error });
      });
      const firstSubscriber = subscribeToRefresh(cache, key, fetcher);
      const secondSubscriber = subscribeToRefresh(cache, key, fetcher);

      cache.invalidate('gate.list');
      await flush();
      expect(calls).toBe(1);
      if (outcome === 'success') old.resolve('stale');
      else old.reject(new Error('stale failure'));
      await first;
      await flush();
      expect(calls).toBe(2);
      expect(cache.get(key)).toMatchObject({ data: 'before', error: null, stale: true, isFetching: true });
      expect(observed.some((snapshot) => snapshot.data === 'stale' || snapshot.error?.message === 'stale failure')).toBe(false);

      fresh.resolve('after');
      await flush();
      expect(cache.get(key)).toMatchObject({ data: 'after', error: null, stale: false, isFetching: false });
      observer();
      firstSubscriber();
      secondSubscriber();
    });
  }

  it('keeps unobserved data stale until a later consumer refetches', async () => {
    const cache = new QueryCache();
    const old = deferred();
    const key = 'session.list';
    cache.set(key, 'before');
    const first = cache.fetch(key, () => old.promise);
    cache.invalidate('session.');
    old.resolve('stale');
    await first;
    await flush();
    expect(cache.get(key)).toMatchObject({ data: 'before', stale: true, isFetching: false });
    await cache.fetch(key, async () => 'after');
    await flush();
    expect(cache.get(key)).toMatchObject({ data: 'after', stale: false, isFetching: false });
  });

  it('coalesces an invalidation burst without parallel reads', async () => {
    const cache = new QueryCache();
    const old = deferred();
    const fresh = deferred();
    const key = 'session.get.s1';
    cache.set(key, 'before');
    let calls = 0;
    const fetcher = () => ++calls === 1 ? old.promise : fresh.promise;
    const first = cache.fetch(key, fetcher);
    await flush();
    const unsubscribe = subscribeToRefresh(cache, key, fetcher);
    for (let index = 0; index < 20; index++) cache.invalidate('session.');
    await flush();
    expect(calls).toBe(1);
    old.resolve('stale');
    await first;
    await flush();
    expect(calls).toBe(2);
    fresh.resolve('after');
    await flush();
    expect(cache.get(key)).toMatchObject({ data: 'after', stale: false });
    unsubscribe();
  });

  it('does not revoke publication for unrelated query prefixes', async () => {
    const cache = new QueryCache();
    const session = deferred();
    const health = deferred();
    const sessionPromise = cache.fetch('session.list', () => session.promise);
    const healthPromise = cache.fetch('project.health', () => health.promise);
    cache.invalidate('session.');
    expect(cache.getInFlight('project.health')).toBe(healthPromise);
    session.resolve('old');
    health.resolve('valid');
    await Promise.all([sessionPromise, healthPromise]);
    await flush();
    expect(cache.get('project.health')).toMatchObject({ data: 'valid', stale: false, isFetching: false });
  });
});
