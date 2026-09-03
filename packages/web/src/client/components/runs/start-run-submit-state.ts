// Pure submit-state selector for Advanced Run (StartRunForm).
// Returns admission block reason in strict priority order.

export type StartRunBlockReason =
  | 'no-token'
  | 'submitting'
  | 'plan-loading'
  | 'plan-error'
  | 'no-plan'
  | 'no-demand'
  | 'draft-not-ready'
  | 'missing-plan-digest'
  | 'network-unacknowledged';

export interface StartRunSubmitStateInput {
  hasToken: boolean;
  submitting?: boolean;
  planLoading?: boolean;
  planError?: boolean;
  hasPlanData?: boolean;
  hasDemandText: boolean;
  draftNotReady?: boolean;
  missingPlanDigest?: boolean;
  networkUnacknowledged?: boolean;
}

export interface StartRunSubmitStateResult {
  disabled: boolean;
  reason?: StartRunBlockReason;
}

/**
 * Pure selector evaluating whether StartRunForm submission is blocked.
 * Strict priority order:
 * no-token > submitting > plan-loading > plan-error > no-plan > no-demand > draft-not-ready > missing-plan-digest > network-unacknowledged
 */
export function startRunSubmitState(
  input: StartRunSubmitStateInput,
): StartRunSubmitStateResult {
  if (!input.hasToken) {
    return { disabled: true, reason: 'no-token' };
  }
  if (Boolean(input.submitting)) {
    return { disabled: true, reason: 'submitting' };
  }
  if (Boolean(input.planLoading)) {
    return { disabled: true, reason: 'plan-loading' };
  }
  if (Boolean(input.planError)) {
    return { disabled: true, reason: 'plan-error' };
  }
  if (!input.hasPlanData) {
    return { disabled: true, reason: 'no-plan' };
  }
  if (!input.hasDemandText) {
    return { disabled: true, reason: 'no-demand' };
  }
  if (Boolean(input.draftNotReady)) {
    return { disabled: true, reason: 'draft-not-ready' };
  }
  if (Boolean(input.missingPlanDigest)) {
    return { disabled: true, reason: 'missing-plan-digest' };
  }
  if (Boolean(input.networkUnacknowledged)) {
    return { disabled: true, reason: 'network-unacknowledged' };
  }

  return { disabled: false, reason: undefined };
}
