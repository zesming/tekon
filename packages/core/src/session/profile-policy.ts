/**
 * Session profile policy (design §1.2.1, 4d). Pure functions, no IO.
 *
 * A session's `profile` is a behavioral policy, not just a display label. The
 * three profiles differ ONLY in the automation and mutation surface they
 * unlock — NEVER in governance gate semantics:
 *
 * HARD RED LINE (CLAUDE.md「合入上线必须受控」「Iron Man suit 优先」): no
 * profile auto-advances a human-approval gate or auto-creates a PR. Capability
 * gates already auto-run at node boundaries for every profile (that is the
 * existing runtime, not a profile concession); human gates always block for a
 * human. `autonomous-delivery` only additionally auto-*prepares* delivery
 * (evidence packaging), which still stops before PR creation.
 */
export type SessionProfile =
  | 'human-web'
  | 'autonomous-delivery'
  | 'review-only';

const KNOWN_PROFILES = new Set<SessionProfile>([
  'human-web',
  'autonomous-delivery',
  'review-only',
]);

/**
 * Normalize a stored/label profile string to a behavioral SessionProfile.
 * CLI sessions are labeled 'cli' (display) but behave as 'human-web' (a human
 * drives them). Any unknown value defaults to the most restrictive automation
 * (human-web) — never silently grants autonomy.
 */
export function resolveSessionProfile(
  profile: string | null | undefined,
): SessionProfile {
  if (profile && KNOWN_PROFILES.has(profile as SessionProfile)) {
    return profile as SessionProfile;
  }
  return 'human-web';
}

/**
 * Whether this profile may auto-*prepare* delivery when a run passes (package
 * evidence, write the `prepared` row). Only autonomous-delivery. Auto-prepare
 * NEVER creates a PR — that stays human (see red line above).
 */
export function canAutoPrepareDelivery(
  profile: string | null | undefined,
): boolean {
  return resolveSessionProfile(profile) === 'autonomous-delivery';
}

/**
 * Whether this profile may perform mutation operations (run/cancel/pause,
 * gate approve/reject, delivery prepare/create-pr). review-only is read-only.
 */
export function canMutate(profile: string | null | undefined): boolean {
  return resolveSessionProfile(profile) !== 'review-only';
}
