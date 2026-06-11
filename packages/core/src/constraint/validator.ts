import type {
  ArtifactType,
  CommandInvocation,
  GateType,
  Role,
} from '../types/domain.js';

export type ConstraintSource = 'constraint';
export type WorkflowArtifactType = ArtifactType | string;

export interface WorkflowGate {
  id?: string;
  type: GateType;
  gateKey?: string;
  command?: CommandInvocation;
  artifactType?: WorkflowArtifactType;
  requiresHumanApproval?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  source?: ConstraintSource | string;
  explanation?: string;
}

export interface WorkflowNode {
  id: string;
  role: Role | string;
  gates?: WorkflowGate[];
  dependsOn?: string[];
  outputs?: WorkflowArtifactType[];
  source?: ConstraintSource | string;
  explanation?: string;
}

export interface WorkflowPhase {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  source?: ConstraintSource | string;
  explanation?: string;
}

export interface ConstraintWorkflowControl {
  id: string;
  source: ConstraintSource;
  explanation: string;
}

export interface WorkflowTemplate {
  id: string;
  name?: string;
  phases: WorkflowPhase[];
  constraintControls?: ConstraintWorkflowControl[];
}

export type ConstraintSeverity = 'error' | 'warning' | 'info';

export interface ConstraintIssue {
  id: string;
  severity: ConstraintSeverity;
  source: ConstraintSource;
  targetId?: string;
  explanation: string;
}

export interface ConstraintMutation {
  id: string;
  source: ConstraintSource;
  targetId: string;
  kind: 'gate' | 'phase' | 'node' | 'control';
  explanation: string;
}

export interface ConstraintSuggestion {
  id: string;
  source: ConstraintSource;
  autoMutates: false;
  explanation: string;
}

export interface ConstraintContext {
  title?: string;
  body?: string;
  tags?: string[];
  riskLevel?: 'low' | 'medium' | 'high' | string;
}

export interface ConstraintMutationOptions {
  acceptedSuggestionIds?: string[];
}

export interface ConstraintValidationResult {
  valid: boolean;
  issues: ConstraintIssue[];
}

export interface ConstraintMutationResult extends ConstraintValidationResult {
  workflow: WorkflowTemplate;
  mutations: ConstraintMutation[];
  suggestions: ConstraintSuggestion[];
}

const source: ConstraintSource = 'constraint';

const softSuggestions: ConstraintSuggestion[] = [
  {
    id: 'soft-dry-run-preview',
    source,
    autoMutates: false,
    explanation:
      'Expose a dry-run preview before execution so humans can inspect the constrained workflow.',
  },
  {
    id: 'soft-audit-log',
    source,
    autoMutates: false,
    explanation:
      'Expose constraint decisions in the audit log so reviewers can see why workflow changes were proposed.',
  },
];

export function validateWorkflowConstraints(
  workflow: WorkflowTemplate,
): ConstraintValidationResult {
  const nodes = flattenNodes(workflow);
  const codeNodes = nodes.filter(({ node }) => producesCodeChanges(node));
  const issues: ConstraintIssue[] = [];

  if (
    codeNodes.some(
      ({ node }) => !hasGate(node, 'build') || !hasGate(node, 'lint'),
    )
  ) {
    issues.push({
      id: 'hard-code-build-lint',
      severity: 'error',
      source,
      targetId: codeNodes.find(
        ({ node }) => !hasGate(node, 'build') || !hasGate(node, 'lint'),
      )?.node.id,
      explanation:
        'Code-change workflows must include both build and lint gates before delivery.',
    });
  }

  if (codeNodes.length > 0 && !hasIndependentReviewer(nodes)) {
    issues.push({
      id: 'hard-independent-reviewer',
      severity: 'error',
      source,
      explanation:
        'Code-change workflows must include an independent reviewer phase or reviewer node.',
    });
  }

  if (codeNodes.length > 0 && !hasValidationCoverage(workflow)) {
    issues.push({
      id: 'hard-validation-or-e2e',
      severity: 'error',
      source,
      explanation:
        'Code-change workflows must include a validation phase, QA node, or e2e-pass gate.',
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function applyConstraintMutations(
  workflow: WorkflowTemplate,
  context: ConstraintContext = {},
  options: ConstraintMutationOptions = {},
): ConstraintMutationResult {
  const next = cloneWorkflow(workflow);
  const mutations: ConstraintMutation[] = [];
  const acceptedSuggestions = new Set(options.acceptedSuggestionIds ?? []);

  if (isHighRisk(context)) {
    const target = firstCodeNode(next) ?? flattenNodes(next)[0];
    if (target && !hasGateId(target.node, 'constraint-gate-human-high-risk')) {
      target.node.gates = [
        ...(target.node.gates ?? []),
        {
          id: 'constraint-gate-human-high-risk',
          type: 'human',
          requiresHumanApproval: true,
          source,
          explanation:
            'high-risk demand requires an explicit human gate before this node can proceed.',
        },
      ];
      mutations.push({
        id: 'conditional-high-risk-human-gate',
        source,
        targetId: target.node.id,
        kind: 'gate',
        explanation:
          'Injected a human approval gate because the demand is marked high-risk.',
      });
    }
  }

  if (hasAnyRiskSignal(context, ['auth', 'security', 'permission'])) {
    const added = ensureSecurityReviewPhase(next);
    if (added) {
      mutations.push({
        id: 'conditional-security-review',
        source,
        targetId: 'constraint-phase-security-review',
        kind: 'phase',
        explanation:
          'Injected security review and security-scan because auth, security, or permission risk is present.',
      });
    }
  }

  if (hasAnyRiskSignal(context, ['data', 'migration'])) {
    const added = ensureRollbackPlanPhase(next);
    if (added) {
      mutations.push({
        id: 'conditional-rollback-plan',
        source,
        targetId: 'constraint-phase-rollback-plan',
        kind: 'phase',
        explanation:
          'Injected rollback-plan artifact requirement because data or migration risk is present.',
      });
    }
  }

  for (const suggestion of softSuggestions) {
    if (!acceptedSuggestions.has(suggestion.id)) {
      continue;
    }

    const control = controlForSuggestion(suggestion.id);
    if (!control) {
      continue;
    }

    next.constraintControls = next.constraintControls ?? [];
    if (
      !next.constraintControls.some((candidate) => candidate.id === control.id)
    ) {
      next.constraintControls.push(control);
      mutations.push({
        id: suggestion.id,
        source,
        targetId: control.id,
        kind: 'control',
        explanation: `Applied soft suggestion: ${suggestion.explanation}`,
      });
    }
  }

  return {
    ...validateWorkflowConstraints(next),
    workflow: next,
    mutations,
    suggestions: softSuggestions,
  };
}

function flattenNodes(workflow: WorkflowTemplate) {
  return workflow.phases.flatMap((phase) =>
    phase.nodes.map((node) => ({ phase, node })),
  );
}

function producesCodeChanges(node: WorkflowNode) {
  return node.outputs?.includes('code-changes') ?? false;
}

function hasGate(node: WorkflowNode, type: GateType) {
  return node.gates?.some((gate) => gate.type === type) ?? false;
}

function hasGateId(node: WorkflowNode, id: string) {
  return node.gates?.some((gate) => gate.id === id) ?? false;
}

function hasIndependentReviewer(
  nodes: Array<{ phase: WorkflowPhase; node: WorkflowNode }>,
) {
  return nodes.some(({ node }) => node.role === 'reviewer');
}

function hasValidationCoverage(workflow: WorkflowTemplate) {
  return workflow.phases.some((phase) => {
    const phaseIdentity = `${phase.id} ${phase.name}`.toLowerCase();
    return (
      phaseIdentity.includes('validation') ||
      phase.nodes.some(
        (node) =>
          node.role === 'qa' ||
          (node.gates ?? []).some((gate) => gate.type === 'e2e-pass'),
      )
    );
  });
}

function isHighRisk(context: ConstraintContext) {
  return (
    context.riskLevel === 'high' ||
    contextTags(context).some((tag) => tag === 'high-risk' || tag === 'high')
  );
}

function hasAnyRiskSignal(context: ConstraintContext, signals: string[]) {
  const tags = contextTags(context);
  const text = `${context.title ?? ''} ${context.body ?? ''}`.toLowerCase();

  return signals.some(
    (signal) => tags.includes(signal) || text.includes(signal),
  );
}

function contextTags(context: ConstraintContext) {
  return (context.tags ?? []).map((tag) => tag.toLowerCase().trim());
}

function firstCodeNode(workflow: WorkflowTemplate) {
  return flattenNodes(workflow).find(({ node }) => producesCodeChanges(node));
}

function ensureSecurityReviewPhase(workflow: WorkflowTemplate) {
  if (
    workflow.phases.some(
      (phase) => phase.id === 'constraint-phase-security-review',
    )
  ) {
    return false;
  }

  workflow.phases.push({
    id: 'constraint-phase-security-review',
    name: 'Security Review',
    source,
    explanation:
      'Auth, security, or permission risk requires an explicit security review phase.',
    nodes: [
      {
        id: 'constraint-node-security-review',
        role: 'reviewer',
        outputs: ['security-report'],
        source,
        explanation:
          'Security-risk workflow requires a reviewer to produce a security-report artifact.',
        gates: [
          {
            id: 'constraint-gate-security-scan',
            type: 'security-scan',
            source,
            explanation:
              'Security-risk workflow requires a security-scan gate before delivery.',
          },
        ],
      },
    ],
  });

  return true;
}

function ensureRollbackPlanPhase(workflow: WorkflowTemplate) {
  if (
    workflow.phases.some(
      (phase) => phase.id === 'constraint-phase-rollback-plan',
    )
  ) {
    return false;
  }

  workflow.phases.push({
    id: 'constraint-phase-rollback-plan',
    name: 'Rollback Plan',
    source,
    explanation:
      'Data or migration risk requires a rollback-plan artifact before delivery.',
    nodes: [
      {
        id: 'constraint-node-rollback-plan',
        role: 'rd',
        outputs: ['rollback-plan'],
        source,
        explanation:
          'Data or migration risk requires an explicit rollback-plan artifact.',
        gates: [
          {
            id: 'constraint-gate-rollback-plan-schema',
            type: 'schema',
            artifactType: 'rollback-plan',
            source,
            explanation:
              'Validate the rollback-plan artifact shape before the workflow can proceed.',
          },
        ],
      },
    ],
  });

  return true;
}

function controlForSuggestion(
  suggestionId: string,
): ConstraintWorkflowControl | null {
  if (suggestionId === 'soft-dry-run-preview') {
    return {
      id: 'constraint-control-dry-run-preview',
      source,
      explanation:
        'Enable dry-run preview visibility as an explicitly selected soft constraint.',
    };
  }

  if (suggestionId === 'soft-audit-log') {
    return {
      id: 'constraint-control-audit-log',
      source,
      explanation:
        'Enable audit log visibility for constraint decisions as an explicitly selected soft constraint.',
    };
  }

  return null;
}

function cloneWorkflow(workflow: WorkflowTemplate): WorkflowTemplate {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowTemplate;
}
