import { describe, it, expect } from 'vitest';
import { runControlAffordances } from '../../src/client/components/runs/RunControls.js';

// ---------------------------------------------------------------------------
// runControlAffordances — which controls are valid for each run status.
// Report P1-08 (Resume must cover blocked/interrupted) and P1 "eye button"
// (View only on terminal runs). Pure logic, tested without a DOM renderer.
// ---------------------------------------------------------------------------

describe('runControlAffordances', () => {
  it('running: can pause and cancel, not resume or view', () => {
    expect(runControlAffordances('running')).toEqual({
      canPause: true,
      canResume: false,
      canCancel: true,
      canView: false,
    });
  });

  it('paused: can resume and cancel, not pause or view', () => {
    expect(runControlAffordances('paused')).toEqual({
      canPause: false,
      canResume: true,
      canCancel: true,
      canView: false,
    });
  });

  // The core P1-08 fix: blocked/interrupted were previously not resumable in
  // the UI (Resume only showed for `paused`).
  it.each(['blocked', 'interrupted'])(
    '%s: is resumable (P1-08 recovery entry point)',
    (status) => {
      const a = runControlAffordances(status);
      expect(a.canResume).toBe(true);
      // Not a live run, so no pause; not terminal, so no view.
      expect(a.canPause).toBe(false);
      expect(a.canCancel).toBe(false);
      expect(a.canView).toBe(false);
    },
  );

  it.each(['passed', 'failed', 'cancelled'])(
    '%s: terminal — only View is offered',
    (status) => {
      expect(runControlAffordances(status)).toEqual({
        canPause: false,
        canResume: false,
        canCancel: false,
        canView: true,
      });
    },
  );

  it('unknown status: offers no controls', () => {
    expect(runControlAffordances('bogus')).toEqual({
      canPause: false,
      canResume: false,
      canCancel: false,
      canView: false,
    });
  });
});
