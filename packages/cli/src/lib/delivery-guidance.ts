import type { createWorkReviewSurface } from '@tekon/core';

// ---------------------------------------------------------------------------
// delivery-guidance.ts — PD-21 CLI 交付指引渲染。
// 数据全部来自 core 的 review surface（含 nextCommandsFor 产出的 nextCommands），
// CLI 不另起一套准备度判定；git merge 是真实 git 命令的本地合入提示，
// 不承诺任何不存在的 tekon 动作（git 回送命令见 backlog）。
// ---------------------------------------------------------------------------

type ReviewSurface = Awaited<ReturnType<typeof createWorkReviewSurface>>;

const NOT_DELIVERABLE_HINT =
  '模板未声明交付要求或计划快照不可用；goal/plan-only/lightweight 等不可交付模板及升级前的旧运行，需换用可交付模板重新发起';

// PD-21：Pre-PR readiness 检查 id 的中文标签，与 Web check-labels 同义；
// CLI 不共享 web 包，在此维护一份最小映射，未命中回落技术 id。
const CHECK_LABELS: Record<string, string> = {
  'delivery-declared': '交付声明',
  'delivery-not-declared': '不可交付',
  'workflow-passed': '工作流执行',
  'audit-valid': '审计链完整性',
  'no-pending-human-gates': '人工审批',
  'validation-gates-passed': '校验门禁',
  'governance-gates-satisfied': '治理门禁',
  'acceptance-criteria-evidenced': '验收标准',
  'qa-release-signoff-passed': 'QA 签收',
  'security-scans-passed': '安全扫描',
};

function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

/**
 * 渲染人读交付指引块（以换行结尾）。机器可读的 key=value 输出由各命令自行保留，
 * 本块只做追加，不改变既有行格式。
 */
export function formatDeliveryGuidance(surface: ReviewSurface): string {
  const { delivery, prePullRequestReadiness } = surface;
  const lines = ['交付指引:'];

  if (!prePullRequestReadiness.ready) {
    const firstFailed = prePullRequestReadiness.checks.find(
      (check) => !check.passed,
    );
    if (firstFailed?.id === 'delivery-not-declared') {
      lines.push(`  当前不可进入 PR 准备: ${NOT_DELIVERABLE_HINT}`);
    } else if (firstFailed) {
      lines.push(
        `  当前不可进入 PR 准备: ${checkLabel(firstFailed.id)} — ${firstFailed.evidence}`,
      );
    } else {
      lines.push('  当前不可进入 PR 准备: 准备度检查未通过');
    }
    return lines.join('\n') + '\n';
  }

  lines.push(
    `  交付分支: ${delivery.diff.branch}（基线 ${delivery.diff.baseBranch}）`,
  );

  for (const lease of delivery.worktrees) {
    const state = lease.releasedAt ? '已释放' : '使用中';
    lines.push(
      `  Worktree: ${lease.worktreePath} — ${lease.role}/${lease.nodeId} 分支 ${lease.branchName}（${state}）`,
    );
  }

  if (delivery.diff.available) {
    lines.push('  Diff 概览:');
    const statLines = delivery.diff.stat
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    for (const statLine of statLines) {
      lines.push(`    ${statLine}`);
    }
  } else {
    lines.push(
      `  Diff 暂不可用: ${delivery.diff.reason ?? '交付分支尚未创建，可先执行 tekon delivery prepare'}`,
    );
  }

  if (delivery.package?.exists) {
    lines.push(`  PR 包: ${delivery.package.path}`);
  }
  if (delivery.prBody?.exists) {
    lines.push(`  PR Body: ${delivery.prBody.path}`);
  }

  lines.push('  下一步:');
  for (const command of surface.nextCommands) {
    lines.push(`    ${command}`);
  }
  // 本地合入替代路径：仅在交付分支真实存在（diff 可用）时提示，
  // 避免指引用户合入一个尚不存在的 ref。
  if (delivery.diff.available) {
    lines.push(
      `    git merge ${delivery.diff.branch}   # 本地直接合入，不创建 PR`,
    );
  }

  return lines.join('\n') + '\n';
}
