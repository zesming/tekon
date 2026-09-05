import { describe, expect, it, vi } from 'vitest';

import { createProviderHealthService } from '../../src/server/api/provider-health.js';

describe('provider health cache and single-flight', () => {
  it('returns server expiry and all callers join an explicit refresh already in progress', async () => {
    let now = 1_000;
    let release!: (status: 'unavailable') => void;
    const probe = vi
      .fn<() => Promise<'available' | 'unavailable'>>()
      .mockResolvedValueOnce('available')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const service = createProviderHealthService({
      probe,
      now: () => now,
      ttlMs: 60_000,
    });
    const input = {
      scope: 'repo-a',
      tokenHash: 'hash-a',
      provider: 'dsh-headless' as const,
    };
    const first = await service.check(input);
    expect(first.checkedAt).toBe(new Date(1_000).toISOString());
    expect(first.expiresAt).toBe(new Date(61_000).toISOString());
    now = 5_000;
    const refresh = service.check({ ...input, refresh: true });
    const repeat = service.check({ ...input, refresh: true });
    const ordinary = service.check(input);
    release('unavailable');
    const results = await Promise.all([refresh, repeat, ordinary]);
    expect(results.every((result) => result.status === 'unavailable')).toBe(
      true,
    );
    expect(
      results.every(
        (result) => result.expiresAt === new Date(65_000).toISOString(),
      ),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent probes and caches unavailable results', async () => {
    let release!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<'unavailable'>((resolve) => {
          release = () => resolve('unavailable');
        }),
    );
    const service = createProviderHealthService({ probe });
    const input = {
      scope: '/repo/.tekon/web-session.json',
      tokenHash: 'one-way-token-hash',
      provider: 'dsh-headless' as const,
    };

    const calls = Array.from({ length: 8 }, () => service.check(input));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    release();

    const results = await Promise.all(calls);
    expect(results.every((result) => result.status === 'unavailable')).toBe(
      true,
    );
    expect(new Set(results.map((result) => result.checkedAt))).toHaveLength(1);
    await expect(service.check(input)).resolves.toEqual(results[0]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('uses the production default 60 second TTL', async () => {
    let now = 1_000;
    const probe = vi.fn(async () => 'available' as const);
    const service = createProviderHealthService({
      probe,
      now: () => now,
    });
    const input = {
      scope: 'repo-a',
      tokenHash: 'token-a',
      provider: 'dsh-headless' as const,
    };

    await service.check(input);
    now += 59_999;
    await service.check(input);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 1;
    await service.check(input);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('uses the production default 128-entry bound and evicts the oldest scope', async () => {
    const probe = vi.fn(async () => 'available' as const);
    const service = createProviderHealthService({ probe });
    const input = (scope: string) => ({
      scope,
      tokenHash: `hash-${scope}`,
      provider: 'dsh-headless' as const,
    });

    for (let index = 0; index < 129; index += 1) {
      await service.check(input(`repo-${index}`));
    }
    await service.check(input('repo-0'));

    expect(probe).toHaveBeenCalledTimes(130);
  });

  it('keys entries independently by repository scope and token hash', async () => {
    const probe = vi.fn(async () => 'available' as const);
    const service = createProviderHealthService({ probe });

    await service.check({
      scope: 'repo-a',
      tokenHash: 'same-hash',
      provider: 'dsh-headless',
    });
    await service.check({
      scope: 'repo-b',
      tokenHash: 'same-hash',
      provider: 'dsh-headless',
    });
    await service.check({
      scope: 'repo-b',
      tokenHash: 'different-hash',
      provider: 'dsh-headless',
    });

    expect(probe).toHaveBeenCalledTimes(3);
  });
});
