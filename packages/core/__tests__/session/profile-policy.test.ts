import { describe, expect, it } from 'vitest';

import {
  canAutoPrepareDelivery,
  canMutate,
  resolveSessionProfile,
} from '../../src/session/profile-policy.js';

// 4d: profile policy is pure. The governance red line (CLAUDE.md) lives here:
// no profile auto-creates a PR; only autonomous-delivery auto-PREPARES; and an
// unknown profile never silently grants autonomy.
describe('session profile policy (4d)', () => {
  describe('resolveSessionProfile', () => {
    it('passes through the three known profiles', () => {
      expect(resolveSessionProfile('human-web')).toBe('human-web');
      expect(resolveSessionProfile('autonomous-delivery')).toBe(
        'autonomous-delivery',
      );
      expect(resolveSessionProfile('review-only')).toBe('review-only');
    });

    it('maps the CLI display label to human-web behavior', () => {
      expect(resolveSessionProfile('cli')).toBe('human-web');
    });

    it('defaults unknown/empty to human-web (never grants autonomy)', () => {
      expect(resolveSessionProfile(undefined)).toBe('human-web');
      expect(resolveSessionProfile(null)).toBe('human-web');
      expect(resolveSessionProfile('bogus')).toBe('human-web');
    });
  });

  describe('canAutoPrepareDelivery', () => {
    it('is true ONLY for autonomous-delivery', () => {
      expect(canAutoPrepareDelivery('autonomous-delivery')).toBe(true);
      expect(canAutoPrepareDelivery('human-web')).toBe(false);
      expect(canAutoPrepareDelivery('review-only')).toBe(false);
      expect(canAutoPrepareDelivery('cli')).toBe(false);
      // Red line: an unknown profile does NOT auto-prepare.
      expect(canAutoPrepareDelivery('bogus')).toBe(false);
      expect(canAutoPrepareDelivery(undefined)).toBe(false);
    });
  });

  describe('canMutate', () => {
    it('is false ONLY for review-only', () => {
      expect(canMutate('review-only')).toBe(false);
      expect(canMutate('human-web')).toBe(true);
      expect(canMutate('autonomous-delivery')).toBe(true);
      expect(canMutate('cli')).toBe(true);
      // Unknown → human-web behavior → may mutate (it is a human session).
      expect(canMutate('bogus')).toBe(true);
    });
  });
});
