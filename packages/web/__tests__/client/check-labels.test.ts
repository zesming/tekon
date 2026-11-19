import { describe, expect, it } from 'vitest';

import { CHECK_LABELS, checkLabel, getCheckSuggestion } from '../../src/client/lib/check-labels.js';

// TS-07/CD-03：core pre-pr-readiness 实际发射的 check id 必须在 Web 标签库
// 有中文标签与建议，防止 id 演进时静默回落技术 id。与 CLI
// delivery-guidance.test.ts 的同名单测互为双端漂移防护。
const corePrePrCheckIds = [
  'delivery-declared',
  'delivery-not-declared',
  'workflow-passed',
  'audit-valid',
  'no-pending-human-gates',
  'validation-gates-passed',
  'governance-gates-satisfied',
  'acceptance-criteria-evidenced',
  'qa-release-signoff-passed',
  'security-scans-passed',
];

describe('check-labels 与 core readiness check id 漂移防护', () => {
  it('每个 core check id 都有中文标签（非技术 id 原文）', () => {
    for (const id of corePrePrCheckIds) {
      const label = checkLabel(id);
      expect(label).not.toBe(id);
      expect(/[一-鿿]/.test(label)).toBe(true);
    }
  });

  it('PD-21 新增 id 与历史别名都有建议文案', () => {
    for (const id of [
      'delivery-declared',
      'delivery-not-declared',
      'governance-gates-satisfied',
      'standard-delivery-template',
      'standard-governance-gates-passed',
    ]) {
      expect(getCheckSuggestion(id)).toBeTruthy();
    }
  });

  it('术语统一：QA 门禁使用「签署」而非「签收」', () => {
    expect(CHECK_LABELS['qa-release-signoff-passed']?.label).toBe('QA 签署');
    expect(checkLabel('qa-release-signoff-passed')).not.toContain('签收');
  });

  it('未知 id 安全回落为技术 id，不抛错', () => {
    expect(checkLabel('future-check-id')).toBe('future-check-id');
  });
});
