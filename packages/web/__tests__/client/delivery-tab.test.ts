import { describe, expect, it } from 'vitest';

import { branchPendingNote } from '../../src/client/pages/run-detail/DeliveryTab.js';

// UI-01：ready 但交付分支 ref 尚不存在时必须提示「prepare 后创建」，
// 防止把约定分支名当成既有事实（幻影分支）。
describe('branchPendingNote（DeliveryTab 幻影分支防护）', () => {
  it('diff 不可用（分支未创建）时返回提示文案', () => {
    expect(branchPendingNote({ available: false })).toBe(
      '分支将在执行 prepare 后创建',
    );
  });

  it('diff 可用（分支真实存在）时不显示提示', () => {
    expect(branchPendingNote({ available: true })).toBeNull();
  });
});
