import { describe, expect, it } from 'vitest';

import { formatDeliveryGuidance } from '../src/lib/delivery-guidance.js';

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
