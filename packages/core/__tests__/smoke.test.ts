import { describe, expect, it } from 'vitest';

import { DONKEY_CORE_VERSION } from '../src/index.js';

describe('@donkey/core', () => {
  it('exports the core package version marker', () => {
    expect(DONKEY_CORE_VERSION).toBe('0.1.0');
  });
});
