import type { createWorkReviewSurface } from '@tekon/core';

// ---------------------------------------------------------------------------
// delivery-guidance.ts — PD-21 CLI 交付指引渲染。
// 数据全部来自 core 的 review surface（含 nextCommandsFor 产出的 nextCommands），
// CLI 不另起一套准备度判定；git merge 是真实 git 命令的本地合入提示，
// 不承诺任何不存在的 tekon 动作（git 回送命令见 backlog）。
//
// CD-03：check id → 中文标签/建议与 Web 的
// packages/web/src/client/lib/check-labels.ts 同义维护；core 新增/改名 check id
// 时两处必须同步（delivery-guidance.test.ts 与 web check-labels 表测试会拦截漂移）。
// ---------------------------------------------------------------------------

type ReviewSurface = Awaited<ReturnType<typeof createWorkReviewSurface>>;
type ReadinessCheck = ReviewSurface['prePullRequestReadiness']['checks'][number];

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
  'qa-release-signoff-passed': 'QA 签署',
  'security-scans-passed': '安全扫描',
};

// 与 Web check-labels 的 suggestion 同义；PD-06 后失败行先给中文建议，
// 英文 evidence 仅作括注细节。
const CHECK_SUGGESTIONS: Record<string, string> = {
  'delivery-declared':
    '该运行的模板未声明交付要求，无法进入 PR 准备；请换用可交付模板重新发起',
  'delivery-not-declared':
    '使用带 delivery 声明的可交付模板重新发起运行；升级前的旧运行需重新发起才能交付',
  'workflow-passed': '检查工作流执行日志，修复失败步骤后重新触发',
  'audit-valid': '审计链出现断点，检查审计日志存储并修复数据完整性',
  'no-pending-human-gates': '存在待处理的人工审批，请先完成审批决策',
  'validation-gates-passed': '查看失败门禁的详细报告，根据失败原因修复后重试',
  'governance-gates-satisfied': '查看失败的治理门禁，根据报告修复对应问题',
  'acceptance-criteria-evidenced':
    '验收标准缺少证据，补充截图、日志或测试报告后重新评估',
  'qa-release-signoff-passed': 'QA 尚未签署，联系 QA 团队完成发布签署流程',
  'security-scans-passed': '安全扫描发现风险项，查看报告修复漏洞后重新扫描',
};

export function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

function checkSuggestion(checkId: string): string | null {
  return CHECK_SUGGESTIONS[checkId] ?? null;
}

/**
 * 渲染人读交付指引块（以换行结尾）。机器可读的 key=value 输出由各命令自行保留，
 * 本块只做追加，不改变既有行格式。
 */
export function formatDeliveryGuidance(surface: ReviewSurface): string {
  const { delivery, prePullRequestReadiness } = surface;
  const lines = ['交付指引:'];

  if (!prePullRequestReadiness.ready) {
    lines.push(...formatFailedChecks(prePullRequestReadiness.checks).map((line) => `  ${line}`));
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

/**
 * PD-02：把未通过检查渲染为中文阻断行。delivery-not-declared 给完整补救
 * 路径；其余检查给中文标签 + 中文建议，英文 evidence 降为括注供排障。
 */
function formatFailedChecks(checks: ReadinessCheck[]): string[] {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return ['当前不可进入 PR 准备: 准备度检查未通过'];
  }
  return failed.map((check) => {
    if (check.id === 'delivery-not-declared') {
      return `当前不可进入 PR 准备: ${NOT_DELIVERABLE_HINT}`;
    }
    const suggestion = checkSuggestion(check.id);
    const detail = suggestion ? `${checkLabel(check.id)} — ${suggestion}` : checkLabel(check.id);
    return `当前不可进入 PR 准备: ${detail}（${check.evidence}）`;
  });
}

/**
 * PD-02：识别 core assertPrePullRequestReady 抛出的阻断错误。
 * 消息前缀是稳定契约（packages/core/src/delivery/pre-pr-readiness.ts）。
 */
export function isReadinessBlockError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('run is not ready for PR creation:')
  );
}

/**
 * PD-02：prepare/create-pr 被 readiness 拦截时，用结构化检查结果生成中文
 * 错误消息；调用方在 catch 中重新抛出，顶层按既有契约 exit 1。
 */
export function formatReadinessBlockMessage(checks: ReadinessCheck[]): string {
  return [
    '当前运行不满足 PR 准备条件：',
    ...formatFailedChecks(checks).map((line) => `  ${line}`),
  ].join('\n');
}
