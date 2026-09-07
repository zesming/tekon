import { describe, it, expect } from 'vitest';
import {
  startRunSubmitState,
  type StartRunBlockReason,
  type StartRunSubmitStateInput,
} from '../../src/client/components/runs/start-run-submit-state.js';

describe('startRunSubmitState', () => {
  const baselineValid: StartRunSubmitStateInput = {
    hasToken: true,
    submitting: false,
    planLoading: false,
    planError: false,
    hasPlanData: true,
    hasDemandText: true,
    draftNotReady: false,
    missingPlanDigest: false,
    networkUnacknowledged: false,
  };

  interface TableCase {
    name: string;
    override: Partial<StartRunSubmitStateInput>;
    expected: {
      disabled: boolean;
      reason?: StartRunBlockReason;
    };
  }

  const tableCases: TableCase[] = [
    {
      name: 'returns "no-token" when token is missing',
      override: { hasToken: false },
      expected: { disabled: true, reason: 'no-token' },
    },
    {
      name: 'priority: "no-token" takes precedence over "submitting"',
      override: { hasToken: false, submitting: true },
      expected: { disabled: true, reason: 'no-token' },
    },
    {
      name: 'returns "submitting" when submission is in flight',
      override: { submitting: true },
      expected: { disabled: true, reason: 'submitting' },
    },
    {
      name: 'priority: "submitting" takes precedence over "plan-loading"',
      override: { submitting: true, planLoading: true },
      expected: { disabled: true, reason: 'submitting' },
    },
    {
      name: 'returns "plan-loading" while execution plan preview is loading',
      override: { planLoading: true },
      expected: { disabled: true, reason: 'plan-loading' },
    },
    {
      name: 'priority: "plan-loading" takes precedence over "plan-error"',
      override: { planLoading: true, planError: true },
      expected: { disabled: true, reason: 'plan-loading' },
    },
    {
      name: 'returns "plan-error" when plan query failed',
      override: { planError: true },
      expected: { disabled: true, reason: 'plan-error' },
    },
    {
      name: 'priority: "plan-error" takes precedence over "no-plan" (planError=true + hasPlanData=false)',
      override: { planError: true, hasPlanData: false },
      expected: { disabled: true, reason: 'plan-error' },
    },
    {
      name: 'returns "no-plan" when plan data is absent without error',
      override: { hasPlanData: false },
      expected: { disabled: true, reason: 'no-plan' },
    },
    {
      name: 'priority: "no-plan" takes precedence over "no-demand"',
      override: { hasPlanData: false, hasDemandText: false },
      expected: { disabled: true, reason: 'no-plan' },
    },
    {
      name: 'returns "no-demand" when demand text is empty',
      override: { hasDemandText: false },
      expected: { disabled: true, reason: 'no-demand' },
    },
    {
      name: 'priority: "no-demand" takes precedence over "draft-not-ready"',
      override: { hasDemandText: false, draftNotReady: true },
      expected: { disabled: true, reason: 'no-demand' },
    },
    {
      name: 'returns "draft-not-ready" when shaped draft is unapproved or has open questions',
      override: { draftNotReady: true },
      expected: { disabled: true, reason: 'draft-not-ready' },
    },
    {
      name: 'priority: "draft-not-ready" takes precedence over "missing-plan-digest"',
      override: { draftNotReady: true, missingPlanDigest: true },
      expected: { disabled: true, reason: 'draft-not-ready' },
    },
    {
      name: 'returns "missing-plan-digest" when workflow plan lacks verification digest',
      override: { missingPlanDigest: true },
      expected: { disabled: true, reason: 'missing-plan-digest' },
    },
    {
      name: 'priority: "missing-plan-digest" takes precedence over "network-unacknowledged"',
      override: { missingPlanDigest: true, networkUnacknowledged: true },
      expected: { disabled: true, reason: 'missing-plan-digest' },
    },
    {
      name: 'returns "network-unacknowledged" when unrestricted network is required but unconfirmed',
      override: { networkUnacknowledged: true },
      expected: { disabled: true, reason: 'network-unacknowledged' },
    },
    {
      name: 'returns fully enabled when all admission criteria are satisfied',
      override: {},
      expected: { disabled: false, reason: undefined },
    },
  ];

  for (const tc of tableCases) {
    it(tc.name, () => {
      const input = { ...baselineValid, ...tc.override };
      const result = startRunSubmitState(input);
      expect(result.disabled).toBe(tc.expected.disabled);
      expect(result.reason).toBe(tc.expected.reason);
    });
  }
});
