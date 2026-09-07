import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { comparePlanCommandBindings, type BindingPreview } from '../../src/client/lib/plan-command-bindings.js';
import { PlanCommandBindings } from '../../src/client/components/runs/PlanCommandBindings.js';
import { ExecutionBindingNotice } from '../../src/client/components/runs/ExecutionBindingNotice.js';

function preview(fingerprint = 'opaque-a'): BindingPreview {
  return {
    digest: 'plan-a', comparisonScope: 'server-a',
    gates: [{ nodeId: 'qa', gateIndex: 0, type: 'test', role: 'qa', requiresHumanApproval: false,
      commandBinding: { status: 'resolved', source: 'repo-profile', commandRef: 'test', behavior: 'execute-command', fingerprint } }],
  };
}

describe('safe command binding comparison', () => {
  it('identifies an opaque invocation change without showing private fields', () => {
    const next = { ...preview('opaque-b'), digest: 'plan-b' };
    const comparison = comparePlanCommandBindings(preview(), next);
    expect(comparison).toMatchObject({ status: 'changed', changes: [{ kind: 'changed', nodeId: 'qa', gateIndex: 0 }] });
    const html = renderToStaticMarkup(React.createElement(PlanCommandBindings, { plan: next, comparison }));
    expect(html).toContain('qa');
    expect(html).toContain('检查配置已变化');
    expect(html).not.toContain('opaque-b');
  });

  it('compares a resolver source change inside the same service scope', () => {
    const next = preview('opaque-b');
    next.gates[0].commandBinding!.source = 'package-json-detection';
    expect(comparePlanCommandBindings(preview(), next).status).toBe('changed');
  });

  it('locates added and removed Gates by node and index', () => {
    const next = preview('opaque-new');
    next.gates[0].nodeId = 'review';
    const kinds = comparePlanCommandBindings(preview(), next).changes.map((change) => change.kind);
    expect(kinds.sort()).toEqual(['added', 'removed']);
  });

  it('separates a non-Gate plan change from unchanged invocation facts', () => {
    const next = { ...preview(), digest: 'different-settings' };
    expect(comparePlanCommandBindings(preview(), next)).toMatchObject({ status: 'changed', settingsChanged: true, changes: [] });
    expect(comparePlanCommandBindings(preview(), preview()).status).toBe('unchanged');
  });

  for (const missing of ['scope', 'fingerprint', 'gateIndex', 'binding', 'rotated-scope'] as const) {
    it(`${missing} does not claim the checks are unchanged`, () => {
      const next = preview();
      if (missing === 'scope') delete next.comparisonScope;
      if (missing === 'rotated-scope') next.comparisonScope = 'server-b';
      if (missing === 'fingerprint') delete next.gates[0].commandBinding!.fingerprint;
      if (missing === 'gateIndex') delete next.gates[0].gateIndex;
      if (missing === 'binding') delete next.gates[0].commandBinding;
      expect(comparePlanCommandBindings(preview(), next).status).toBe('unavailable');
    });
  }

  it('has no fabricated difference without an older preview', () => {
    expect(comparePlanCommandBindings(undefined, preview()).status).toBe('initial');
    const oldPayload = { digest: 'old', gates: [] };
    expect(comparePlanCommandBindings(undefined, oldPayload).status).toBe('unavailable');
  });

  it('does not compare malformed or duplicate Gate positions', () => {
    const malformed = preview();
    malformed.gates[0].gateIndex = -1;
    expect(comparePlanCommandBindings(preview(), malformed).status).toBe('unavailable');
    const duplicate = preview();
    duplicate.gates.push({ ...duplicate.gates[0] });
    expect(comparePlanCommandBindings(preview(), duplicate).status).toBe('unavailable');
    expect(comparePlanCommandBindings(preview(), undefined).status).toBe('unavailable');
    const legacy = { ...preview(), comparisonScope: undefined };
    expect(comparePlanCommandBindings(legacy, preview()).status).toBe('unavailable');
  });

  for (const [behavior, label] of [
    ['execute-command', '将执行已绑定命令'], ['skip', '将跳过此检查'],
    ['missing-command', '缺少命令，检查将失败'], ['builtin-security', '仍执行内置安全扫描'],
    ['builtin-security-and-command', '内置安全扫描及已绑定命令'], ['not-command-gate', '按检查规则执行'],
  ] as const) {
    it(`renders ${behavior} from server behavior, independently of resolution status`, () => {
      const plan = preview();
      plan.gates[0].commandBinding!.behavior = behavior;
      const html = renderToStaticMarkup(React.createElement(PlanCommandBindings, { plan }));
      expect(html).toContain(label);
      if (behavior === 'skip') expect(html).not.toContain('将执行已绑定命令');
    });
  }
});

describe('execution binding explanation', () => {
  for (const [state, text] of [
    ['frozen', '仓库检查已绑定'], ['legacy-unbound', '历史计划未记录仓库命令绑定'],
    ['invalid', '计划绑定记录无效'], ['unknown', '暂无法确认检查绑定'],
  ] as const) {
    it(`renders ${state} without claiming the entire environment is frozen`, () => {
      const html = renderToStaticMarkup(React.createElement(ExecutionBindingNotice, { value: state }));
      expect(html).toContain(text);
      expect(html).not.toContain('执行环境已冻结');
    });
  }
  it('treats a missing or future field as unknown', () => {
    for (const value of [undefined, 'future-binding']) {
      expect(renderToStaticMarkup(React.createElement(ExecutionBindingNotice, { value }))).toContain('暂无法确认检查绑定');
    }
  });
});
