import { describe, expect, it, vi } from 'vitest';

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

describe('query cache in-flight ownership', () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    for (const clearing of ['all', 'scope'] as const) {
      for (const freshFirst of [false, true]) {
        it(`fences old ${outcome} publication after ${clearing} clear (fresh settled: ${freshFirst})`, async () => {
          const cache = new QueryCache();
          const old = deferred();
          const fresh = deferred();
          const key = 'project.health.auth-race';
          const oldPromise = cache.fetch(key, () => old.promise);
          const joined = cache.fetch(
            key,
            vi.fn(() => Promise.resolve('unexpected')),
          );
          expect(joined).toBe(oldPromise);
          const settledOld = oldPromise.catch(() => undefined);
          if (clearing === 'all') cache.clearAllInFlight();
          else cache.clearByScope('auth-race');
          const publish = vi.fn();
          cache.subscribe(key, publish);
          const freshPromise = cache.fetch(key, () => fresh.promise);
          if (freshFirst) {
            fresh.resolve('new');
            await freshPromise;
            await flush();
            expect(cache.getInFlight(key)).toBeUndefined();
          }
          publish.mockClear();
          if (outcome === 'resolve') old.resolve('old');
          else old.reject(new Error('old request failed'));
          await settledOld;
          await flush();
          expect(publish).not.toHaveBeenCalled();
          expect(cache.get(key)?.error).toBeNull();
          expect(cache.get(key)?.data).toBe(freshFirst ? 'new' : undefined);
          if (!freshFirst) {
            expect(cache.getInFlight(key)).toBe(freshPromise);
            fresh.resolve('new');
            await freshPromise;
          }
          expect(cache.get(key)?.data).toBe('new');
        });
      }
    }
  }

  it('publishes a shared fetch after the initiating subscriber unmounts', async () => {
    const cache = new QueryCache();
    const request = deferred();
    const fetcher = vi.fn(() => request.promise);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = cache.subscribe('shared', first);
    cache.subscribe('shared', second);
    const promise = cache.fetch('shared', fetcher);
    expect(cache.fetch('shared', fetcher)).toBe(promise);
    unsubscribeFirst();
    first.mockClear();
    second.mockClear();
    request.resolve('shared result');
    await promise;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(cache.get('shared')?.data).toBe('shared result');
  });

  it('retains the last successful result on failure and recovers on retry', async () => {
    const cache = new QueryCache();
    await cache.fetch('health', async () => 'previous');
    await flush();
    await expect(
      cache.fetch('health', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    await flush();
    expect(cache.get('health')).toMatchObject({
      data: 'previous',
      error: new Error('offline'),
      isFetching: false,
    });
    await cache.fetch('health', async () => 'recovered');
    await flush();
    expect(cache.get('health')).toMatchObject({
      data: 'recovered',
      error: null,
      isFetching: false,
    });
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    for (const clearing of ['all', 'scope'] as const) {
      it(`preserves a successor when an old request ${outcome}s after ${clearing} eviction`, async () => {
        const cache = new QueryCache();
        const old = deferred();
        const fresh = deferred();
        const key = 'project.health.auth-1';
        cache.setInFlight(key, old.promise);
        if (clearing === 'all') cache.clearAllInFlight();
        else cache.clearByScope('auth-1');
        cache.setInFlight(key, fresh.promise);
        if (outcome === 'resolve') old.resolve('old');
        else old.reject(new Error('old request failed'));
        await flush();
        expect(cache.getInFlight(key)).toBe(fresh.promise);
        fresh.resolve('new');
        await flush();
        expect(cache.getInFlight(key)).toBeUndefined();
      });
    }
  }

  it('cleans its own completed registration without touching another scope', async () => {
    const cache = new QueryCache();
    const other = deferred();
    cache.setInFlight('project.health.auth-2', other.promise);
    cache.setInFlight('project.health.auth-1', Promise.resolve('done'));
    await flush();
    expect(cache.getInFlight('project.health.auth-1')).toBeUndefined();
    expect(cache.getInFlight('project.health.auth-2')).toBe(other.promise);
    other.resolve('done');
    await flush();
  });
});
