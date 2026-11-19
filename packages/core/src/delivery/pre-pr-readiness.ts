import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { GateType } from '../types/domain.js';
import {
  createDeliveryEvidencePackage,
  type DeliveryEvidencePackage,
} from './evidence.js';
import { validateRunPlanV2, validateRunPlanV3 } from '../workflow/run-plan.js';
import type {
  WorkflowDeliveryDeclaration,
  WorkflowTemplate,
} from '../workflow/template.js';

export interface PrePullRequestReadinessCheck {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface PrePullRequestReadiness {
  runId: string;
  ready: boolean;
  checks: PrePullRequestReadinessCheck[];
}

// PD-21：交付要求只从该 run 自己的冻结 plan_snapshot 读取（D2），运行期
// 不重读 yaml，在途 run 不受模板事后修改影响。
type DeclarationRead =
  | {
      ok: true;
      templateId: string;
      declaration: WorkflowDeliveryDeclaration;
    }
  | {
      ok: false;
      // snapshot-unavailable：快照缺失/旧 V1/损坏/摘要校验失败（M4）；
      // not-declared：快照可用但模板未声明可交付或 deliverable 非 true。
      reason: 'snapshot-unavailable' | 'not-declared';
      evidence: string;
    };

/**
 * M4 fail-closed：任何快照异常都不抛错，返回不可交付结论。
 * review/surface.ts 在 Promise.all 内无 catch 调用本模块，抛错会击穿整个
 * review.get，使 Web 运行详情/DeliveryTab/DeliveryPage 全部打不开。
 */
function readDeliveryDeclaration(
  planSnapshot: string | null | undefined,
): DeclarationRead {
  if (!planSnapshot) {
    return {
      ok: false,
      reason: 'snapshot-unavailable',
      evidence: 'plan snapshot is absent; delivery declaration cannot be verified',
    };
  }
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(planSnapshot);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: 'snapshot-unavailable',
        evidence: 'plan snapshot is not an object; delivery declaration cannot be verified',
      };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: 'snapshot-unavailable',
      evidence: 'plan snapshot is not valid JSON; delivery declaration cannot be verified',
    };
  }

  // V1 或更旧快照无 digestVersion，不携带冻结声明。
  if (!Object.hasOwn(raw, 'digestVersion')) {
    return {
      ok: false,
      reason: 'snapshot-unavailable',
      evidence: 'legacy v1 plan snapshot carries no frozen delivery declaration',
    };
  }

  let template: WorkflowTemplate;
  try {
    const plan =
      raw.digestVersion === 2
        ? validateRunPlanV2(raw)
        : validateRunPlanV3(raw);
    template = plan.template;
  } catch {
    // 含未知 digestVersion、canonical 投影不一致、digest 认证失败。
    return {
      ok: false,
      reason: 'snapshot-unavailable',
      evidence: 'plan snapshot failed digest validation; delivery declaration cannot be verified',
    };
  }

  const delivery = template.delivery;
  if (!delivery) {
    return {
      ok: false,
      reason: 'not-declared',
      evidence: `workflow template ${template.id} does not declare deliverable requirements`,
    };
  }
  if (delivery.deliverable !== true) {
    return {
      ok: false,
      reason: 'not-declared',
      evidence: `workflow template ${template.id} explicitly declares deliverable=false`,
    };
  }
  return { ok: true, templateId: template.id, declaration: delivery };
}

export async function evaluatePrePullRequestReadiness(input: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath: string;
}): Promise<PrePullRequestReadiness> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const declarationRead = readDeliveryDeclaration(workflow.planSnapshot);
  if (!declarationRead.ok) {
    // 不可交付/快照不可用：只输出 delivery-not-declared 一条，绝不抛错。
    return {
      runId: input.runId,
      ready: false,
      checks: [
        {
          id: 'delivery-not-declared',
          passed: false,
          evidence: declarationRead.evidence,
        },
      ],
    };
  }
  const { templateId, declaration } = declarationRead;
  const requirements = declaration.requirements ?? {};
  const requiredCommandGates = requirements.commandGates ?? [];
  const requiredGovernanceGates = requirements.governanceGates ?? [];

  const gates = await input.repositories.listGateResults(input.runId);
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const deliveryEvidence = await createDeliveryEvidencePackage({
    repositories: input.repositories,
    audit: input.audit,
    runId: input.runId,
    repoPath: input.repoPath,
  });
  const audit = await input.audit.verify(input.runId);
  const pendingHuman = decisions.filter(
    (decision) => decision.status === 'pending',
  );

  const checks: PrePullRequestReadinessCheck[] = [
    {
      id: 'delivery-declared',
      passed: true,
      evidence: `delivery requirements declared by frozen template ${templateId}: commandGates=[${requiredCommandGates.join(', ')}] governanceGates=[${requiredGovernanceGates.join(', ')}] qaReleaseSignoff=${requirements.qaReleaseSignoff ?? false} securityScan=${requirements.securityScan ?? false} acceptanceEvidence=${requirements.acceptanceEvidence ?? false}`,
    },
    {
      id: 'workflow-passed',
      passed: workflow.status === 'passed',
      evidence: `workflow status is ${workflow.status}`,
    },
    {
      id: 'audit-valid',
      passed: audit.valid,
      evidence: audit.valid
        ? 'audit hash chain is valid'
        : `audit hash chain is broken at ${audit.brokenEventId}`,
    },
    {
      id: 'no-pending-human-gates',
      passed: pendingHuman.length === 0,
      evidence: `${pendingHuman.length} pending human decisions`,
    },
    commandGatesCheck(requiredCommandGates, gates),
    governanceGatesCheck(requiredGovernanceGates, gates),
    acceptanceEvidenceCheck(requirements.acceptanceEvidence === true, deliveryEvidence),
    qaSignoffCheck(
      requirements.qaReleaseSignoff === true,
      deliveryEvidence,
      gates,
    ),
    securityScansCheck(requirements.securityScan === true, deliveryEvidence),
  ];

  return {
    runId: input.runId,
    ready: checks.every((check) => check.passed),
    checks,
  };
}

export async function assertPrePullRequestReady(input: {
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  repoPath: string;
}): Promise<PrePullRequestReadiness> {
  const readiness = await evaluatePrePullRequestReadiness(input);
  if (!readiness.ready) {
    const failed = readiness.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.id}: ${check.evidence}`)
      .join('; ');
    throw new Error(`run is not ready for PR creation: ${failed}`);
  }
  return readiness;
}

const NOT_REQUIRED_EVIDENCE = '模板未要求';

/**
 * M1 每节点全量裁决：声明的每个命令门类型，其在每个节点上的最新结果都必须
 * 通过（或 skipped+not-applicable）。声明了但运行中零结果判 missing 发红；
 * 禁用「任一节点 passed 即满足」的集合写法，避免同名门一败一成被抵消。
 */
function commandGatesCheck(
  required: readonly GateType[],
  gates: Array<{
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    status: string;
    failureClassification?: string | null;
    createdAt: string;
  }>,
): PrePullRequestReadinessCheck {
  if (required.length === 0) {
    return {
      id: 'validation-gates-passed',
      passed: true,
      evidence: NOT_REQUIRED_EVIDENCE,
    };
  }
  const latest = latestGateResults(gates);
  const relevant = latest.filter((gate) =>
    (required as readonly string[]).includes(gate.gateType),
  );
  const satisfied = relevant.filter(isSatisfiedValidationGate);
  const missingTypes = required.filter(
    (type) => !relevant.some((gate) => gate.gateType === type),
  );
  const passed =
    missingTypes.length === 0 && relevant.length === satisfied.length;
  const details = `${satisfied.length}/${relevant.length} declared command gates passed or explicitly skipped`;
  return {
    id: 'validation-gates-passed',
    passed,
    evidence:
      missingTypes.length === 0
        ? details
        : `${details}; missing gate results: ${missingTypes.join(', ')}`,
  };
}

/** 治理门按类型集合裁决：声明的每个类型存在任一节点 passed 即满足。 */
function governanceGatesCheck(
  required: readonly GateType[],
  gates: Array<{
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    status: string;
    failureClassification?: string | null;
    createdAt: string;
  }>,
): PrePullRequestReadinessCheck {
  if (required.length === 0) {
    return {
      id: 'governance-gates-satisfied',
      passed: true,
      evidence: NOT_REQUIRED_EVIDENCE,
    };
  }
  const latest = latestGateResults(
    gates.filter((gate) =>
      (required as readonly string[]).includes(gate.gateType),
    ),
  );
  const passedTypes = new Set(
    latest
      .filter((gate) => gate.status === 'passed')
      .map((gate) => gate.gateType),
  );
  const missing = required.filter((type) => !passedTypes.has(type));
  return {
    id: 'governance-gates-satisfied',
    passed: missing.length === 0,
    evidence:
      missing.length === 0
        ? `declared governance gates passed: ${required.join(', ')}`
        : `missing passed governance gates: ${missing.join(', ')}`,
  };
}

function acceptanceEvidenceCheck(
  required: boolean,
  deliveryEvidence: DeliveryEvidencePackage,
): PrePullRequestReadinessCheck {
  if (!required) {
    return {
      id: 'acceptance-criteria-evidenced',
      passed: true,
      evidence: NOT_REQUIRED_EVIDENCE,
    };
  }
  const passedCount = deliveryEvidence.acceptanceEvidence.filter(
    (item) => item.status === 'passed',
  ).length;
  return {
    id: 'acceptance-criteria-evidenced',
    passed:
      deliveryEvidence.acceptanceEvidence.length > 0 &&
      deliveryEvidence.acceptanceEvidence.every(
        (item) => item.status === 'passed',
      ),
    evidence: `${passedCount}/${deliveryEvidence.acceptanceEvidence.length} acceptance criteria evidenced`,
  };
}

function qaSignoffCheck(
  required: boolean,
  deliveryEvidence: DeliveryEvidencePackage,
  gates: Array<{
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    status: string;
    failureClassification?: string | null;
    createdAt: string;
  }>,
): PrePullRequestReadinessCheck {
  if (!required) {
    return {
      id: 'qa-release-signoff-passed',
      passed: true,
      evidence: NOT_REQUIRED_EVIDENCE,
    };
  }
  const hasPassedQaSignoffGate = latestGateResults(
    gates.filter((gate) => gate.gateType === 'qa-signoff'),
  ).some((gate) => gate.status === 'passed');
  const matchingSignoff = deliveryEvidence.qaReleaseSignoffs.find(
    (signoff) =>
      signoff.status === 'passed' &&
      signoff.matchedRef &&
      Boolean(signoff.expectedRef) &&
      deliveryEvidence.acceptanceCriteria.length > 0 &&
      deliveryEvidence.acceptanceCriteria.every((criterion) =>
        signoff.coveredCriteriaIds.includes(criterion.id),
      ),
  );
  return {
    id: 'qa-release-signoff-passed',
    passed: hasPassedQaSignoffGate && Boolean(matchingSignoff),
    evidence:
      deliveryEvidence.qaReleaseSignoffs.length > 0
        ? [
            hasPassedQaSignoffGate
              ? 'qa-signoff gate passed'
              : 'qa-signoff gate missing',
            ...deliveryEvidence.qaReleaseSignoffs.map(
              (signoff) =>
                `${signoff.status} matchedRef=${signoff.matchedRef} expectedRef=${signoff.expectedRef ?? 'missing'} criteriaEvidence=${signoff.criteriaEvidence} artifact=${signoff.artifactId}`,
            ),
          ].join('; ')
        : 'QA release signoff missing',
  };
}

function securityScansCheck(
  required: boolean,
  deliveryEvidence: DeliveryEvidencePackage,
): PrePullRequestReadinessCheck {
  if (!required) {
    return {
      id: 'security-scans-passed',
      passed: true,
      evidence: NOT_REQUIRED_EVIDENCE,
    };
  }
  const passedCount = deliveryEvidence.securityScans.filter(
    (scan) => scan.status === 'passed',
  ).length;
  return {
    id: 'security-scans-passed',
    passed:
      deliveryEvidence.securityScans.length > 0 &&
      deliveryEvidence.securityScans.every((scan) => scan.status === 'passed'),
    evidence: `${passedCount}/${deliveryEvidence.securityScans.length} security scans passed`,
  };
}

function isSatisfiedValidationGate(gate: {
  status: string;
  failureClassification?: string | null;
}) {
  return (
    gate.status === 'passed' ||
    (gate.status === 'skipped' &&
      gate.failureClassification === 'not-applicable')
  );
}

function latestGateResults<
  T extends {
    nodeId: string;
    gateType: string;
    gateKey?: string | null;
    createdAt: string;
  },
>(gates: T[]): T[] {
  const latestByNodeAndType = new Map<string, T>();
  for (const gate of gates) {
    const key = `${gate.nodeId}:${gate.gateKey ?? gate.gateType}`;
    const existing = latestByNodeAndType.get(key);
    if (
      !existing ||
      Date.parse(gate.createdAt) >= Date.parse(existing.createdAt)
    ) {
      latestByNodeAndType.set(key, gate);
    }
  }
  return [...latestByNodeAndType.values()];
}
