import { canonicalJson, captureRunPlan } from '../../src/workflow/run-plan.js';
import {
  loadBuiltInWorkflowTemplate,
  parseWorkflowTemplate,
  type BuiltInWorkflowTemplateId,
  type GateType,
  type WorkflowTemplate,
} from '../../src/workflow/template.js';

/**
 * PD-21 测试夹具用：构造带 delivery 声明的冻结 V3 计划字段，直接喂给
 * createWorkflowInstance。readiness 只从 plan_snapshot 读声明，无快照的
 * 夹具会一律落 delivery-not-declared。Test-only。
 */
export function frozenPlanFields(
  repoPath: string,
  templateOrId: BuiltInWorkflowTemplateId | WorkflowTemplate = 'standard-delivery',
  agent = 'codex',
): { planSnapshot: string; planDigest: string } {
  const template =
    typeof templateOrId === 'string'
      ? loadBuiltInWorkflowTemplate(templateOrId)
      : templateOrId;
  const plan = captureRunPlan(repoPath, template, { agent });
  return { planSnapshot: canonicalJson(plan), planDigest: plan.digest };
}

/**
 * PD-21 测试夹具用：按给定门集合构造最小可交付模板，delivery 声明与模板
 * 真实门禁严格一致（assertDeliveryDeclaration 会强制）。调用方传入的门
 * 类型必须与测试实际 seed 的 GateResult 对齐。Test-only。
 */
export function fixtureDeliveryTemplate(input: {
  id?: string;
  commandGates?: readonly GateType[];
  governanceGates?: readonly GateType[];
  qaReleaseSignoff?: boolean;
  securityScan?: boolean;
  acceptanceEvidence?: boolean;
}): WorkflowTemplate {
  const commandGates = input.commandGates ?? [];
  const governanceGates = input.governanceGates ?? [];
  const securityScan = input.securityScan ?? true;
  const gates = [
    ...commandGates.map((type) => ({ type })),
    ...governanceGates.map((type) => ({ type })),
    ...(securityScan ? [{ type: 'security-scan' as const }] : []),
    { type: 'schema' as const, artifactType: 'delivery-package' },
  ];
  return parseWorkflowTemplate({
    id: input.id ?? 'fixture-deliverable',
    delivery: {
      deliverable: true,
      requirements: {
        commandGates: [...commandGates],
        governanceGates: [...governanceGates],
        qaReleaseSignoff: input.qaReleaseSignoff ?? true,
        securityScan,
        acceptanceEvidence: input.acceptanceEvidence ?? true,
      },
    },
    phases: [
      {
        id: 'delivery',
        nodes: [
          {
            id: 'delivery-node',
            role: 'pmo',
            outputs: [{ id: 'delivery-package', type: 'delivery-package' }],
            gates,
          },
        ],
      },
    ],
  });
}

