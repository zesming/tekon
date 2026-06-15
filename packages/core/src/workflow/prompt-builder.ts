import { join } from 'node:path';

import type {
  ArtifactType,
  Node,
  Role,
  WorkflowInstance,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  buildRolePrompt,
  type RolePromptArtifactSummary,
} from '../role/prompt-builder.js';
import { loadRole } from '../role/loader.js';
import {
  type WorkflowArtifactInputRef,
  type WorkflowArtifactOutputRef,
  type WorkflowGateConfig,
} from './template.js';
import {
  type ArtifactStoreLike,
  type ExecutableNode,
  defaultBuiltInRolesDir,
  gatesWithStableKeys,
} from './workflow-runtime.js';

export interface PromptBuilderDeps {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  builtInRolesDir?: string;
  userHome?: string;
  artifactStore: ArtifactStoreLike;
}

export interface PromptBuilder {
  buildNodePrompt(runId: string, node: ExecutableNode): Promise<string>;
  buildRepairPrompt(
    runId: string,
    node: Pick<Node, 'id' | 'role' | 'phaseId'>,
    failedGate: { id: string; gateType: string; failureClassification?: string | null },
  ): Promise<string>;
  appendArtifactProtocol(
    prompt: string,
    input: {
      nodeId: string;
      outputDir: string;
      role: Role;
      nodeInputs: WorkflowArtifactInputRef[];
      priorNodes: Array<Pick<Node, 'id' | 'role'>>;
      requiredArtifactTypes: ArtifactType[];
    },
  ): string;
  artifactSummariesForNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<RolePromptArtifactSummary[]>;
}

export function createPromptBuilder(deps: PromptBuilderDeps): PromptBuilder {
  const {
    repoPath,
    dataDir,
    repositories,
    builtInRolesDir,
    userHome,
    artifactStore,
  } = deps;

  async function mustGetWorkflow(runId: string): Promise<WorkflowInstance> {
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    return workflow;
  }

  async function mustGetDemand(demandId: string) {
    const demand = await repositories.getDemand(demandId);
    if (!demand) {
      throw new Error(`demand not found: ${demandId}`);
    }
    return demand;
  }

  async function latestQaValidationRef(
    runId: string,
  ): Promise<string | undefined> {
    const events = await repositories.listAuditEvents(runId);
    return events
      .filter((event) => event.type === 'qa.validation.ref')
      .map((event) =>
        typeof event.payload.ref === 'string' ? event.payload.ref : undefined,
      )
      .filter((ref): ref is string => Boolean(ref))
      .at(-1);
  }

  async function buildNodePrompt(
    runId: string,
    node: ExecutableNode,
  ): Promise<string> {
    const role = loadRole({
      role: node.role,
      repoPath,
      builtInRolesDir: builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome,
    });
    const workflow = await mustGetWorkflow(runId);
    const demand = await mustGetDemand(workflow.demandId);
    const artifacts = await artifactSummariesForNode(runId, node);
    const allNodes = await repositories.listNodes(runId);
    const currentIndex = allNodes.findIndex((item) => item.id === node.id);
    const priorNodes = currentIndex >= 0 ? allNodes.slice(0, currentIndex) : [];
    const gateResults = await repositories.listGateResults(runId);
    const visibleGateNodeIds = new Set([
      ...priorNodes.map((item) => item.id),
      node.id,
    ]);
    const eligibleGateResultLines = gateResults
      .filter(
        (gate) =>
          visibleGateNodeIds.has(gate.nodeId) &&
          (gate.status === 'passed' || gate.status === 'skipped'),
      )
      .map(formatGateResultForPrompt);
    const priorNodeLines = priorNodes.map((item) =>
      [
        `- ${item.id} role=${item.role} status=${item.status}`,
        item.outputs.length > 0
          ? `outputs=${item.outputs.map((output) => output.type).join(',')}`
          : 'outputs=none',
        item.gates.length > 0
          ? `gates=${gatesWithStableKeys(item.gates, item.id)
              .map((gate) => `${gate.type}:${gate.gateKey}`)
              .join(',')}`
          : 'gates=none',
      ].join(' '),
    );
    const processCheckpointRequired = node.outputs.some(
      (output) => output.type === 'process-checkpoint',
    );
    const pendingHumanDecisionCount = processCheckpointRequired
      ? (await repositories.listHumanDecisions(runId)).filter(
          (decision) => decision.status === 'pending',
        ).length
      : undefined;
    const expectedDeliveryRef = node.outputs.some(
      (output) => output.type === 'qa-release-signoff',
    )
      ? await latestQaValidationRef(runId)
      : undefined;
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Execute workflow node ${node.id}.`,
        node.inputs.length > 0
          ? `Declared input artifact aliases: ${node.inputs
              .map((input) => `${input.id}:${input.type}`)
              .join(', ')}.`
          : 'Declared input artifact aliases: none.',
        priorNodeLines.length > 0
          ? ['Prior workflow nodes:', ...priorNodeLines].join('\n')
          : 'Prior workflow nodes: none.',
        eligibleGateResultLines.length > 0
          ? ['Prior eligible gate results:', ...eligibleGateResultLines].join(
              '\n',
            )
          : 'Prior eligible gate results: none.',
        processCheckpointRequired
          ? [
              'For process-checkpoint.requiredNodes, include every prior workflow node listed above with the exact nodeId and status; do not invent, omit, rename, or reorder required nodes.',
              'process-checkpoint.artifactEvidence[] must use exact fields nodeId and type; do not use output, artifactId, path, exists, nonEmpty, sizeBytes, or sha256 as substitutes for type.',
              'process-checkpoint.gateEvidence[] must use exact fields nodeId, gateType, gateKey, and status; status must be passed or skipped, and observedStatus is not a valid substitute.',
              'process-checkpoint.humanDecisionEvidence.pending must be a non-negative integer count, not an array or list of pending actions.',
              `process-checkpoint.humanDecisionEvidence.pending must equal the current unresolved Tekon human decision count: ${pendingHumanDecisionCount}. Do not count manual review items, residual risks, PR/merge/release/deploy approvals, or future owner decisions unless they are currently pending Tekon human decisions.`,
            ].join('\n')
          : '',
        expectedDeliveryRef
          ? `For qa-release-signoff.targetRef and validatedRef, use this exact tested delivery ref: ${expectedDeliveryRef}.`
          : '',
        `Produce the requested artifacts and preserve evidence for gates.`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      projectContext: {
        runId,
        nodeId: node.id,
        projectId: workflow.projectId,
        repoPath,
        dataDir,
      },
      artifactSummaries: artifacts,
    });
  }

  async function buildRepairPrompt(
    runId: string,
    node: Pick<Node, 'id' | 'role' | 'phaseId'>,
    failedGate: {
      id: string;
      gateType: string;
      failureClassification?: string | null;
    },
  ): Promise<string> {
    const role = loadRole({
      role: node.role,
      repoPath,
      builtInRolesDir: builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome,
    });
    const workflow = await mustGetWorkflow(runId);
    const demand = await mustGetDemand(workflow.demandId);
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Repair failed gate ${failedGate.id}.`,
        `Failed gate type: ${failedGate.gateType}.`,
        failedGate.failureClassification
          ? `Failure classification: ${failedGate.failureClassification}.`
          : 'Failure classification: unavailable.',
      ].join('\n'),
      projectContext: {
        runId,
        nodeId: node.id,
        projectId: workflow.projectId,
        repoPath,
        dataDir,
      },
    });
  }

  function appendArtifactProtocol(
    prompt: string,
    input: {
      nodeId: string;
      outputDir: string;
      role: Role;
      nodeInputs: WorkflowArtifactInputRef[];
      priorNodes: Array<Pick<Node, 'id' | 'role'>>;
      requiredArtifactTypes: ArtifactType[];
    },
  ): string {
    if (input.requiredArtifactTypes.length === 0) {
      return prompt;
    }
    const isCodeChangesRdNode =
      input.role === 'rd' &&
      input.requiredArtifactTypes.includes('code-changes');

    const manifestExample = JSON.stringify(
      {
        artifacts: input.requiredArtifactTypes.map((type) => ({
          type,
          path: `${type}.json`,
          summary: `${type} summary`,
        })),
      },
      null,
      2,
    );
    return [
      prompt,
      '',
      'Tekon artifact protocol:',
      "- Complete only this workflow node's responsibilities.",
      '- This provider node produces internal Tekon artifacts; outer Tekon QA, reviewer, and PMO nodes handle workflow review and delivery evidence.',
      '- Do not spawn subagents, delegate review, or wait for external agents inside this node.',
      ...(isCodeChangesRdNode
        ? [
            '- For RD code-changes nodes, this artifact protocol overrides role skills or local instructions that would otherwise require tests, nested or delegated reviews, dependency installation, or extra diagnostics before manifest creation.',
          ]
        : []),
      !input.requiredArtifactTypes.includes('code-changes')
        ? '- Required artifact types do not include code-changes; do not modify the repository working tree; write only node artifacts under TEKON_OUTPUT_DIR.'
        : '- Keep repository edits scoped to the requested code-changes artifact and this workflow node.',
      '- Do not run git add, git commit, git push, or create PRs inside this node.',
      '- Leave repository edits in the worktree; Tekon Engine promotes and commits passed node changes after gates.',
      `- Write all node artifacts under TEKON_OUTPUT_DIR (${input.outputDir}).`,
      `- Required artifact types: ${input.requiredArtifactTypes.join(', ')}.`,
      '- Each artifact may be JSON, YAML front matter, or Markdown accepted by the Tekon artifact schema.',
      '- Structured JSON artifacts must include non-empty title and body fields.',
      ...(input.requiredArtifactTypes.some(
        (type) => type === 'demand-card' || type === 'prd',
      )
        ? [
            '- For demand-card and prd JSON artifacts, include acceptanceCriteria with id and description fields.',
          ]
        : []),
      ...(input.requiredArtifactTypes.some((type) =>
        ['test-report', 'ac-evidence', 'qa-release-signoff'].includes(type),
      )
        ? [
            '- For test-report, ac-evidence, and qa-release-signoff JSON artifacts, criteriaEvidence[] must use exact fields criterionId, status, and evidence.',
            '- Create one criteriaEvidence item per acceptance criterion id. criterionId must be exactly one criterion id from the demand/PRD, such as AC-PRD-1; never combine ids with "/", commas, arrays, or grouped labels. Duplicate shared evidence across separate items when needed.',
            '- criteriaEvidence[].evidence must be a non-empty string; use per-item outputPaths, gateResultIds, or artifactIds for evidence anchors when anchors are required.',
            '- Do not put evidence anchors only at artifact top-level; gate checks read anchors from each criteriaEvidence item.',
            '- criteriaEvidence[].artifactIds must use exact artifactId values shown in the Artifacts section; nodeId:type labels are not valid artifactIds.',
            '- criteriaEvidence[].gateResultIds must use exact gateResultId values from Prior eligible gate results; do not use gateKey, nodeId:gateKey labels, commandRef labels, outputPath, or log file names.',
            '- If you do not have an exact artifactId, omit artifactIds and use outputPaths or known gateResultIds instead.',
            '- criteriaEvidence[].status must be one of passed, failed, blocked, or unknown; do not use id, evidenceSummary, coverage, or extended status labels as substitutes.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('test-report')
        ? [
            '- For test-report JSON artifacts, summary is optional but must be a string when present; do not write summary as an object.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('qa-release-signoff')
        ? [
            '- For qa-release-signoff JSON artifacts, include targetRef, validatedRef, and overallStatus.',
            '- qa-release-signoff.overallStatus must be one of passed, failed, or blocked; do not use decision or recommendation as a substitute.',
          ]
        : []),
      ...(input.requiredArtifactTypes.some((type) =>
        ['ac-evidence', 'qa-release-signoff'].includes(type),
      )
        ? [
            '- For ac-evidence and qa-release-signoff JSON artifacts, each criteriaEvidence item must include at least one evidence anchor: outputPaths pointing to a file under TEKON_OUTPUT_DIR or an existing repo path, or known gateResultIds/artifactIds.',
            '- If a criterion depends on downstream delivery packaging, PR creation, PMO checkpoint, QA signoff, or QA signoff review, do not block this QA validation node solely because those downstream nodes have not run yet.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('test-plan')
        ? [
            '- For test-plan JSON artifacts, include testBasis and testCases using the exact schema fields.',
            '- testBasis must be a non-empty string array.',
            '- testCases[].id and testCases[].description are required.',
            '- Do not use testScenarios, gatePlan, or acceptanceCoverage as substitutes for testCases.',
          ]
        : []),
      ...roleScopedReviewArtifactInstructions({
        nodeId: input.nodeId,
        role: input.role,
        nodeInputs: input.nodeInputs,
        priorNodes: input.priorNodes,
        requiredArtifactTypes: input.requiredArtifactTypes,
      }),
      `- Write the artifact manifest file to ${join(input.outputDir, 'artifact-manifest.json')}, containing an "artifacts" array with type, path, and summary for each artifact.`,
      '- Write required artifact files and the manifest file before optional checks or reviews.',
      ...(isCodeChangesRdNode
        ? [
            '- Do not run dependency installation, test, lint, typecheck, build, or package-manager commands before writing required code-changes artifacts and the manifest; Tekon gates run validation after artifact ingestion.',
          ]
        : []),
      '- After the manifest file is written, stop work and exit immediately.',
      '- Do not continue editing, formatting, running checks, printing diffs, or explaining unless this workflow node explicitly requires it before manifest creation.',
      '- Manifest format example:',
      manifestExample,
      '- Do not include secrets, tokens, credentials, or production-only data in artifacts or logs.',
    ].join('\n');
  }

  async function artifactSummariesForNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<RolePromptArtifactSummary[]> {
    const summaries: RolePromptArtifactSummary[] = [];
    for (const input of node.inputs) {
      const artifacts = await repositories.listArtifacts(
        runId,
        input.fromNodeId,
        input.type,
      );
      const latestArtifact = artifacts.at(-1);
      if (!latestArtifact) {
        continue;
      }
      summaries.push({
        id: latestArtifact.id,
        type: latestArtifact.type,
        path: latestArtifact.path,
        summary: latestArtifact.summary,
        content: await artifactStore.readArtifactForPrompt(latestArtifact),
      });
    }
    return summaries;
  }

  return {
    buildNodePrompt,
    buildRepairPrompt,
    appendArtifactProtocol,
    artifactSummariesForNode,
  };
}

// ---------------------------------------------------------------------------
// Pure helper functions (no closure state)
// ---------------------------------------------------------------------------

function formatGateResultForPrompt(gate: {
  id: string;
  nodeId: string;
  gateType: string;
  status: string;
}): string {
  return `- gateResultId: ${gate.id} (context only: nodeId=${gate.nodeId}; gateType=${gate.gateType}; status=${gate.status})`;
}

const roleScopedReviewArtifactTypes: ArtifactType[] = [
  'code-review',
  'demand-review',
  'qa-release-signoff-review',
  'requirement-interface-review',
  'technical-review',
  'test-plan-review',
];

function roleScopedReviewArtifactInstructions(input: {
  nodeId: string;
  role: Role;
  nodeInputs: WorkflowArtifactInputRef[];
  priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  requiredArtifactTypes: ArtifactType[];
}): string[] {
  const reviewTypes = input.requiredArtifactTypes.filter((type) =>
    roleScopedReviewArtifactTypes.includes(type),
  );
  if (reviewTypes.length === 0) {
    return [];
  }

  return [
    '- For role-scoped review JSON artifacts, include reviewScope, reviewProcess, decision, and findings using the exact schema fields.',
    `- reviewProcess.mode must be "independent-agent" or "independent-process"; reviewProcess.reviewerRole must be "${input.role}".`,
    '- decision must be one of: approved, changes-requested, blocked.',
    '- findings must be an array; findings[].severity must be one of: critical, important, minor.',
    '- findings[].ownerRole is optional; if present, it must be one of: pm, rd, qa, reviewer, pmo.',
    '- findings[].message is required; put ids, category, impact, or recommendation details inside body or message, not in place of message.',
    '- Do not use reviewRole, reviewedArtifacts, or reviewScope as an array/object as substitutes for these schema fields.',
    ...reviewTypes.flatMap((type) =>
      roleScopedReviewArtifactExampleLines(type, input),
    ),
  ];
}

function roleScopedReviewArtifactExampleLines(
  type: ArtifactType,
  input: {
    nodeId: string;
    role: Role;
    nodeInputs: WorkflowArtifactInputRef[];
    priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  },
): string[] {
  const target = reviewTargetForArtifact(type, input);
  const reviewScopes = reviewScopesForArtifact(type, input.role);
  const example = JSON.stringify(
    {
      title: `${type} review`,
      body: 'Review findings and rationale within this role scope.',
      reviewScope: reviewScopes[0],
      reviewProcess: {
        mode: 'independent-process',
        reviewerId: `${input.role}-${type}-reviewer`,
        reviewerRole: input.role,
        targetNodeId: target.nodeId,
        targetRole: target.role,
      },
      decision: 'approved',
      findings: [
        {
          severity: 'minor',
          ownerRole: input.role,
          message: 'No blocking issue found within this role scope.',
        },
      ],
    },
    null,
    2,
  );

  return [
    `- For ${type}, reviewScope must be ${reviewScopes
      .map((scope) => `"${scope}"`)
      .join(' or ')}; use targetNodeId "${target.nodeId}" and targetRole "${
      target.role
    }" unless the node explicitly reviews a more specific declared input.`,
    `- ${type} JSON example:`,
    example,
  ];
}

function reviewScopesForArtifact(type: ArtifactType, role: Role): string[] {
  if (type === 'demand-review') {
    return ['demand-quality'];
  }
  if (type === 'requirement-interface-review') {
    return ['requirement-interface'];
  }
  if (type === 'technical-review') {
    return ['technical-design', 'implementation-risk'];
  }
  if (type === 'test-plan-review') {
    return role === 'pm' ? ['test-plan-intent'] : ['test-plan'];
  }
  if (type === 'qa-release-signoff-review') {
    return ['release-signoff'];
  }
  if (type === 'code-review') {
    return ['code-change'];
  }
  return ['delivery-readiness'];
}

function reviewTargetForArtifact(
  type: ArtifactType,
  input: {
    nodeId: string;
    nodeInputs: WorkflowArtifactInputRef[];
    priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  },
): { nodeId: string; role: Role } {
  const preferredArtifactTypes = preferredReviewTargetTypes(type);
  const targetInput =
    preferredArtifactTypes
      .map((artifactType) =>
        input.nodeInputs.find((candidate) => candidate.type === artifactType),
      )
      .find(Boolean) ?? input.nodeInputs[0];
  const targetNodeId = targetInput?.fromNodeId ?? input.nodeId;
  const targetRole =
    input.priorNodes.find((node) => node.id === targetNodeId)?.role ??
    fallbackTargetRoleForReviewArtifact(type);

  return { nodeId: targetNodeId, role: targetRole };
}

function preferredReviewTargetTypes(type: ArtifactType): ArtifactType[] {
  if (type === 'code-review') {
    return ['code-changes'];
  }
  if (type === 'demand-review') {
    return ['demand-card', 'prd'];
  }
  if (type === 'qa-release-signoff-review') {
    return ['qa-release-signoff'];
  }
  if (type === 'requirement-interface-review') {
    return ['demand-card', 'prd', 'demand-review'];
  }
  if (type === 'technical-review') {
    return ['implementation-plan'];
  }
  if (type === 'test-plan-review') {
    return ['test-plan'];
  }
  return [];
}

function fallbackTargetRoleForReviewArtifact(type: ArtifactType): Role {
  if (type === 'code-review') {
    return 'rd';
  }
  if (type === 'demand-review') {
    return 'pm';
  }
  if (type === 'qa-release-signoff-review') {
    return 'qa';
  }
  if (type === 'requirement-interface-review') {
    return 'pm';
  }
  if (type === 'technical-review') {
    return 'rd';
  }
  if (type === 'test-plan-review') {
    return 'qa';
  }
  return 'pmo';
}
