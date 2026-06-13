// ---------------------------------------------------------------------------
// check-labels.ts — Chinese labels, descriptions, and suggestions for all
// Tekon gate types, statuses, failure classifications, and readiness checks.
//
// Usage: import { gateTypeLabel, checkLabel, failureLabel, statusLabel } from '../lib/check-labels.js';
// Primary display is natural language Chinese; technical IDs retained for tooltips.
// ---------------------------------------------------------------------------

// ── Gate type → Chinese display name ────────────────────────────────────────

export const GATE_TYPE_LABELS: Record<string, string> = {
  'ac-evidence': '验收证据',
  build: '构建',
  test: '测试',
  lint: '代码检查',
  'e2e-pass': '端到端测试',
  schema: '模式校验',
  'independent-review': '独立评审',
  'role-scope': '角色范围',
  'qa-signoff': 'QA 签收',
  'process-completeness': '流程完整性',
  'security-scan': '安全扫描',
  human: '人工审批',
};

export function gateTypeLabel(gateType: string): string {
  return GATE_TYPE_LABELS[gateType] ?? gateType;
}

// ── Gate status → Chinese display label ─────────────────────────────────────

export const GATE_STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  blocked: '已阻塞',
  skipped: '已跳过',
};

export function gateStatusLabel(status: string): string {
  return GATE_STATUS_LABELS[status] ?? status;
}

// ── Failure classification → Chinese description ───────────────────────────

export const FAILURE_CLASSIFICATION_LABELS: Record<string, string> = {
  timeout: '超时',
  'exit-code': '退出码异常',
  'security-findings': '安全发现',
  'blocked-for-approval': '等待审批',
  rejected: '被策略拒绝',
  'human-rejected': '人工拒绝',
  'human-approval': '人工审批中',
  'missing-command': '缺少命令',
  'missing-artifact-type': '缺少产出类型',
  'missing-artifact': '缺少产出',
  'invalid-artifact': '无效产出',
  'unsupported-gate': '不支持的门禁',
  'not-applicable': '不适用',
  blocked: '已阻塞',
  unknown: '未知',
};

export function failureLabel(classification: string): string {
  return FAILURE_CLASSIFICATION_LABELS[classification] ?? classification;
}

// ── Failure classification → suggestion (for tooltips / detail panels) ─────

export const FAILURE_SUGGESTIONS: Record<string, string> = {
  timeout: '检查日志，调整超时参数或命令后重试',
  'exit-code': '查看门禁日志，修复失败原因后重试',
  'security-findings': '查看安全日志并移除敏感信息后重试',
  'blocked-for-approval': '审批通过后门禁将继续执行',
  rejected: '修改命令或策略配置，确认后再重试',
  'human-rejected': '查看拒绝说明，调整工作后重新运行',
  'missing-command': '检查仓库 role profile 配置中缺少的命令映射',
  'missing-artifact-type': '检查上游产出定义，确保产出类型已配置',
  'missing-artifact': '检查上游节点是否正确输出所需产物',
  'invalid-artifact': '检查产出是否符合 Schema 定义',
  'unsupported-gate': '当前运行时不支持该门禁类型，请检查模板配置',
};

export function failureSuggestion(classification: string): string {
  return FAILURE_SUGGESTIONS[classification] ?? '';
}

// ── Work readiness check ID → Chinese label + description ───────────────────

export interface CheckLabelEntry {
  /** Short Chinese display name */
  label: string;
  /** One-line human-readable description */
  description: string;
  /** Suggested user action when this check fails */
  suggestion: string;
}

export const CHECK_LABELS: Record<string, CheckLabelEntry> = {
  // Work readiness checks (work-readiness.ts)
  'workflow-passed': {
    label: '工作流执行',
    description: '工作流实例已成功完成所有阶段',
    suggestion: '检查工作流执行日志，修复失败步骤后重新触发',
  },
  'audit-valid': {
    label: '审计链完整性',
    description: '审计事件的哈希链连续且未被篡改',
    suggestion: '审计链出现断点，检查审计日志存储并修复数据完整性',
  },
  'validation-gates-passed': {
    label: '校验门禁',
    description: '构建、测试、代码检查、端到端测试门禁均已通过',
    suggestion: '查看失败门禁的详细报告，根据失败原因修复后重试',
  },
  'delivery-package-present': {
    label: '交付包',
    description: '交付物打包已完成，交付包文件已生成',
    suggestion: '交付包缺失，确认 delivery prepare 步骤已执行并生成产物',
  },
  'pr-prepared': {
    label: 'PR 准备',
    description: 'PR 内容已准备完毕，可供创建或审阅',
    suggestion: 'PR 尚未准备就绪，检查代码变更是否已提交到分支并完成预检',
  },
  'no-pending-human-gates': {
    label: '人工审批',
    description: '所有需要人工决策的审批项已处理',
    suggestion: '存在待处理的人工审批，请在审批界面完成审批决策',
  },
  'acceptance-criteria-evidenced': {
    label: '验收标准',
    description: '所有验收标准的证据材料已收集并通过验证',
    suggestion: '验收标准缺少证据，补充截图、日志或测试报告后重新评估',
  },
  'qa-release-signoff-passed': {
    label: 'QA 签收',
    description: 'QA 签收门禁通过且覆盖所有验收标准',
    suggestion: 'QA 尚未签收，联系 QA 团队完成发布签收流程',
  },
  'security-scans-passed': {
    label: '安全扫描',
    description: '所有安全扫描检测均已通过',
    suggestion: '安全扫描发现风险项，查看报告修复漏洞后重新扫描',
  },
  'pr-created': {
    label: 'PR 创建',
    description: 'Pull Request 已成功创建',
    suggestion: 'PR 尚未创建，确认所有前置检查通过后创建 PR',
  },
  'remote-ci-passed': {
    label: '远程 CI',
    description: '远程 CI 流水线已执行并通过',
    suggestion: '远程 CI 未通过，查看 CI 日志修复构建或测试失败',
  },

  // Pre-PR readiness additional checks (pre-pr-readiness.ts)
  'standard-delivery-template': {
    label: '标准交付模板',
    description: '工作流使用了标准交付模板',
    suggestion: '切换到标准交付模板以确保流程规范',
  },
  'standard-governance-gates-passed': {
    label: '标准治理门禁',
    description: '独立评审、角色范围、验收证据、QA 签收、流程完整性门禁均已通过',
    suggestion: '查看失败的治理门禁，根据报告修复对应问题',
  },

  // Human approval summary checks (approval/summary.ts)
  'pending-decision-present': {
    label: '待审批决策',
    description: '存在一个待处理的人工审批决策',
    suggestion: '在审批页面查看并处理待审批的决策',
  },
  'risk-context-present': {
    label: '风险上下文',
    description: '已提供决策的风险标签',
    suggestion: '补充本次审批的风险说明和风险评估',
  },
  'command-context-present': {
    label: '命令上下文',
    description: '已记录需要审批的完整命令',
    suggestion: '补充完整执行命令及其参数说明',
  },
  'impact-context-present': {
    label: '影响范围',
    description: '已列出受影响的文件及变更影响评估',
    suggestion: '补充变更影响范围说明及受影响文件列表',
  },
  'approval-entry-present': {
    label: '批准入口',
    description: '批准命令格式正确且可用',
    suggestion: '检查审批流程配置，确认批准命令已定义',
  },
  'rejection-entry-present': {
    label: '拒绝入口',
    description: '拒绝命令格式正确且不需要额外参数',
    suggestion: '检查审批流程配置，确认拒绝命令已定义',
  },
  'evidence-context-present': {
    label: '证据上下文',
    description: '提供了足够的证据链接和检查信息',
    suggestion: '补充相关证据材料，如日志、截图或测试结果',
  },
  'copyable-summary-present': {
    label: '可复制摘要',
    description: '生成了包含完整决策信息的可复制摘要文本',
    suggestion: '重新生成便于传播的决策摘要信息',
  },
};

export function checkLabel(checkId: string): string {
  return CHECK_LABELS[checkId]?.label ?? checkId;
}

export function checkDescription(checkId: string): string {
  return CHECK_LABELS[checkId]?.description ?? '';
}

// ── Convenience aliases used by CheckList.tsx ─────────────────────────────

/** Alias for checkLabel — used by CheckList component. */
export function getCheckLabel(checkId: string): string {
  return checkLabel(checkId);
}

/** Return the user-facing suggestion for a failed check. */
export function getCheckSuggestion(checkId: string): string {
  return CHECK_LABELS[checkId]?.suggestion ?? '';
}

/** Alias for checkDescription — used by CheckList for "why this matters" tooltip. */
export function getCheckDescription(checkId: string): string {
  return checkDescription(checkId);
}

// ── Risk level mapping (English → Chinese) ────────────────────────────────

const RISK_CN_MAP: Record<string, string> = {
  critical: '严重风险',
  high: '高风险',
  medium: '中风险',
  moderate: '中风险',
  low: '低风险',
  negligible: '可忽略',
  unknown: '未知',
};

/**
 * Translate an English risk label to Chinese natural language.
 * Handles single-word ("high"), multi-word ("high risk"), and
 * empty / unknown inputs.
 */
export function getRiskLabel(riskLabel: string): string {
  const lower = riskLabel.toLowerCase().trim();
  if (!lower || lower === 'unknown') return RISK_CN_MAP.unknown;
  if (lower.includes('critical')) return RISK_CN_MAP.critical;
  if (lower.includes('high')) return RISK_CN_MAP.high;
  if (lower.includes('medium') || lower.includes('moderate')) return RISK_CN_MAP.medium;
  if (lower.includes('low')) return RISK_CN_MAP.low;
  if (lower.includes('negligible')) return RISK_CN_MAP.negligible;
  return RISK_CN_MAP.unknown;
}

// ── Readiness helpers ─────────────────────────────────────────────────────

/**
 * Get a Chinese label for readiness state.
 */
export function getReadinessLabel(ready: boolean): string {
  return ready ? '已就绪' : '未就绪';
}

/**
 * Derive a readiness-bar CSS level from a 0–1 score.
 */
export function readinessBarLevel(
  score: number,
  thresholds?: { high?: number; medium?: number },
): 'high' | 'medium' | 'low' {
  const hi = thresholds?.high ?? 0.7;
  const med = thresholds?.medium ?? 0.4;
  if (score >= hi) return 'high';
  if (score >= med) return 'medium';
  return 'low';
}

// ── Failed checks summary ──────────────────────────────────────────────────

/**
 * Build a human-readable Chinese summary of failed readiness checks.
 * Used by OverviewTab to display a summary above the CheckList.
 */
export function buildFailedChecksSummary(
  failedChecks: Array<{ id: string; severity?: string }>,
): string {
  if (failedChecks.length === 0) return '';
  const labels = failedChecks.map((c) => {
    const cn = checkLabel(c.id);
    const sev =
      c.severity === 'required'
        ? '【必须】'
        : c.severity === 'recommended'
          ? '【推荐】'
          : c.severity === 'context'
            ? '【参考】'
            : '';
    return `${sev}${cn}`;
  });
  return `以下 ${labels.length} 项检查未通过，可能影响交付就绪：${labels.join('、')}`;
}
