import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApiCaller } from '../../src/server/api/root.js';
import { createWebFixtureProject } from '../fixtures/project.js';

describe('credential health after server configuration changes', () => {
  it('does not reuse positive or negative verdicts after token rotation', async () => {
    const fixture = await createWebFixtureProject();
    const providerProbe = vi.fn(async () => 'available' as const);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot, providerProbe });
    try {
      const replacement = 'replacement-r23-token';
      expect((await api.project.health({ token: fixture.sessionToken })).credential).toBe('valid');
      expect((await api.project.health({ token: replacement })).credential).toBe('invalid');
      writeFileSync(
        join(fixture.projectRoot, '.tekon', 'web-session.json'),
        JSON.stringify({ token: replacement }),
      );
      expect((await api.project.health({ token: fixture.sessionToken })).credential).toBe('invalid');
      expect((await api.project.health({ token: replacement })).credential).toBe('valid');
      expect(providerProbe).not.toHaveBeenCalled();
    } finally {
      await api.close();
      fixture.cleanup();
    }
  });

  for (const state of ['removed', 'malformed', 'missing-token'] as const) {
    it(`does not retain a valid verdict when configuration is ${state}`, async () => {
      const fixture = await createWebFixtureProject();
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });
      try {
        expect((await api.project.health({ token: fixture.sessionToken })).credential).toBe('valid');
        const sessionPath = join(fixture.projectRoot, '.tekon', 'web-session.json');
        if (state === 'removed') rmSync(sessionPath);
        else writeFileSync(sessionPath, state === 'malformed' ? '{' : '{}');
        expect((await api.project.health({ token: fixture.sessionToken })).credential).toBe('not-configured');
      } finally {
        await api.close();
        fixture.cleanup();
      }
    });
  }
});
