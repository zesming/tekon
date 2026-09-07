import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createPlanPreviewSigner } from '../../src/server/api/plan-preview.js';

describe('逐检查预览的不透明比较标识', () => {
  it('同实例稳定，但不是可离线枚举的无密钥摘要', () => {
    const signer = createPlanPreviewSigner();
    const privateFacts = JSON.stringify({ purpose: 'tekon.run-plan-gate.v1', args: ['PRIVATE_ARG'], reason: 'PRIVATE_REASON' });
    const value = signer.sign(privateFacts);
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(signer.sign(privateFacts)).toBe(value);
    expect(value).not.toBe(createHash('sha256').update(privateFacts).digest('hex'));
    expect(JSON.stringify(signer)).not.toContain('PRIVATE_');
    expect(Object.keys(signer).sort()).toEqual(['comparisonScope', 'sign']);
  });

  it('不同根实例轮换比较作用域与标识，不复用前一密钥', () => {
    const first = createPlanPreviewSigner();
    const second = createPlanPreviewSigner();
    expect(first.comparisonScope).toEqual(expect.any(String));
    expect(second.comparisonScope).not.toBe(first.comparisonScope);
    expect(second.sign('same facts')).not.toBe(first.sign('same facts'));
  });

  it('有效参数、适用性和位置变化均改变同作用域标识', () => {
    const signer = createPlanPreviewSigner();
    const facts = { nodeId: 'rd', gateIndex: 0, args: ['build'], skipReason: null };
    const values = [facts, { ...facts, args: ['test'] }, { ...facts, skipReason: 'not applicable' }, { ...facts, gateIndex: 1 }]
      .map(value => signer.sign(JSON.stringify(value)));
    expect(new Set(values).size).toBe(4);
  });
});
