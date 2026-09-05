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

describe('query cache in-flight ownership', () => {
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
