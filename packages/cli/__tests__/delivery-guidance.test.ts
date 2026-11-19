import { describe, expect, it } from 'vitest';

import {
  checkLabel,
  formatDeliveryGuidance,
  formatReadinessBlockMessage,
  isReadinessBlockError,
} from '../src/lib/delivery-guidance.js';

// PD-21：交付指引是纯渲染函数，最小 surface 夹具只构造它实际读取的字段。
type GuidanceInput = Parameters<typeof formatDeliveryGuidance>[0];

function baseSurface(overrides: Partial<GuidanceInput>): GuidanceInput {
  return {
    prePullRequestReadiness: {
      runId: 'run_1',
      ready: true,
      checks: [],
    },
    delivery: {
      status: 'not-prepared',
      prUrl: null,
      package: null,
      prBody: null,
      worktrees: [],
      diff: {
        branch: 'tekon-delivery/run_1',
        baseBranch: 'main',
        available: true,
        stat: ' feature.txt | 2 ++\n 1 file changed',
        changedFiles: ['M\tfeature.txt'],
      },
    },
    nextCommands: ['tekon status', 'tekon delivery prepare'],
    ...overrides,
  } as unknown as GuidanceInput;
}

describe('formatDeliveryGuidance（PD-21 CLI 指引）', () => {
  it('not-ready 且 delivery-not-declared：只给重新发起提示，不出现分支与下一步', () => {
    const output = formatDeliveryGuidance(
      baseSurface({
        prePullRequestReadiness: {
          runId: 'run_1',
          ready: false,
          checks: [
            {
              id: 'delivery-not-declared',
              passed: false,
              evidence: 'workflow template goal does not declare deliverable requirements',
            },
          ],
        },
      }),
    );

    expect(output).toContain('交付指引:');
    expect(output).toContain('当前不可进入 PR 准备');
    expect(output).toContain('需换用可交付模板重新发起');
    expect(output).not.toContain('交付分支');
    expect(output).not.toContain('Worktree');
    expect(output).not.toContain('git merge');
  });

  it('not-ready 且其他检查失败：技术 id 经中文标签表翻译并附 evidence', () => {
    const output = formatDeliveryGuidance(
      baseSurface({
        prePullRequestReadiness: {
          runId: 'run_1',
          ready: false,
          checks: [
            {
              id: 'validation-gates-passed',
              passed: false,
              evidence: '3/4 declared command gates passed or explicitly skipped',
            },
          ],
        },
      }),
    );

    expect(output).toContain('校验门禁');
    expect(output).toContain('3/4 declared command gates');
    expect(output).not.toContain('git merge');
  });

  it('ready 且 diff 可用：渲染分支/worktree/diff/落点/nextCommands 与本地合入提示', () => {
    const output = formatDeliveryGuidance(
      baseSurface({
        delivery: {
          status: 'prepared',
          prUrl: null,
          worktrees: [
            {
              id: 'lease_1',
              nodeId: 'node_1',
              role: 'rd',
              worktreePath: '/repo/.tekon/worktrees/run_1/lease_1',
              branchName: 'tekon/run_1/lease_1',
              createdAt: '2026-06-08T00:00:00.000Z',
              releasedAt: null,
            },
          ],
          package: {
            path: '/repo/.tekon/runs/run_1/delivery/pr-package.md',
            exists: true,
            content: '',
            truncated: false,
            sizeBytes: 10,
          },
          prBody: {
            path: '/repo/.tekon/runs/run_1/delivery/pr-body.md',
            exists: true,
            content: '',
            truncated: false,
            sizeBytes: 10,
          },
          diff: {
            branch: 'tekon-delivery/run_1',
            baseBranch: 'main',
            available: true,
            stat: ' feature.txt | 2 ++',
            changedFiles: ['M\tfeature.txt'],
          },
        } as GuidanceInput['delivery'],
      }),
    );

    expect(output).toContain('交付分支: tekon-delivery/run_1（基线 main）');
    expect(output).toContain('Worktree: /repo/.tekon/worktrees/run_1/lease_1');
    expect(output).toContain('（使用中）');
    expect(output).toContain('Diff 概览:');
    expect(output).toContain('feature.txt | 2 ++');
    expect(output).toContain('PR 包: /repo/.tekon/runs/run_1/delivery/pr-package.md');
    expect(output).toContain('PR Body: /repo/.tekon/runs/run_1/delivery/pr-body.md');
    expect(output).toContain('tekon status');
    expect(output).toContain('tekon delivery prepare');
    expect(output).toContain('git merge tekon-delivery/run_1');
  });

  it('ready 但 diff 不可用：不承诺 git merge，改给不可用原因', () => {
    const output = formatDeliveryGuidance(
      baseSurface({
        delivery: {
          status: 'not-prepared',
          prUrl: null,
          package: null,
          prBody: null,
          worktrees: [],
          diff: {
            branch: 'tekon-delivery/run_1',
            baseBranch: 'main',
            available: false,
            stat: '',
            changedFiles: [],
            reason: 'branch ref is missing or unsafe: tekon-delivery/run_1',
          },
        },
      }),
    );

    expect(output).toContain('Diff 暂不可用:');
    expect(output).toContain('branch ref is missing or unsafe');
    expect(output).not.toContain('git merge');
  });

  it('已释放的 worktree 标注「已释放」', () => {
    const output = formatDeliveryGuidance(
      baseSurface({
        delivery: {
          ...baseSurface({}).delivery,
          worktrees: [
            {
              id: 'lease_2',
              nodeId: 'node_2',
              role: 'qa',
              worktreePath: '/repo/.tekon/worktrees/run_1/lease_2',
              branchName: 'tekon/run_1/lease_2',
              createdAt: '2026-06-08T00:00:00.000Z',
              releasedAt: '2026-06-08T00:05:00.000Z',
            },
          ],
        } as GuidanceInput['delivery'],
      }),
    );

    expect(output).toContain('（已释放）');
  });
});

describe('PD-02 readiness 阻断错误中文化', () => {
  it('isReadinessBlockError 只识别 core 的稳定前缀错误', () => {
    expect(
      isReadinessBlockError(
        new Error(
          'run is not ready for PR creation: delivery-not-declared: legacy v1',
        ),
      ),
    ).toBe(true);
    expect(isReadinessBlockError(new Error('ENOENT: no such file'))).toBe(false);
    expect(isReadinessBlockError(new Error('run is not ready'))).toBe(false);
    expect(isReadinessBlockError('not an error')).toBe(false);
    expect(isReadinessBlockError(undefined)).toBe(false);
  });

  it('delivery-not-declared 阻断消息含中文补救路径，不含裸英文前缀', () => {
    const message = formatReadinessBlockMessage([
      {
        id: 'delivery-not-declared',
        passed: false,
        evidence: 'legacy v1 plan snapshot carries no frozen delivery declaration',
      },
    ]);

    expect(message).toContain('当前运行不满足 PR 准备条件');
    expect(message).toContain('需换用可交付模板重新发起');
    expect(message).not.toContain('run is not ready for PR creation');
  });

  it('其他检查失败给中文标签与建议，英文 evidence 仅作括注', () => {
    const message = formatReadinessBlockMessage([
      {
        id: 'validation-gates-passed',
        passed: false,
        evidence: '3/4 declared command gates passed or explicitly skipped',
      },
    ]);

    expect(message).toContain('校验门禁');
    expect(message).toContain('查看失败门禁的详细报告');
    expect(message).toContain('3/4 declared command gates');
  });
});

describe('TS-07 check id 中文标签漂移防护', () => {
  // core pre-pr-readiness 实际发射的全部 check id（9 项检查 + 短路 id）。
  const coreCheckIds = [
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

  it('每个 core check id 都有非技术 id 的中文标签', () => {
    for (const id of coreCheckIds) {
      const label = checkLabel(id);
      expect(label).not.toBe(id);
      expect(/[一-鿿]/.test(label)).toBe(true);
    }
  });

  it('未知 id 安全回落为技术 id 而非抛错', () => {
    expect(checkLabel('future-check-id')).toBe('future-check-id');
  });
});
