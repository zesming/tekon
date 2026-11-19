import {
  deriveReworkNode,
  DYNAMIC_NODE_ORDER_OFFSET,
  reworkNodeIdFor,
} from './execution-plan.js';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { GateResult, Node } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  runAgentWithStepEvents,
  type AgentEventSink,
} from '../runtime/agent-step-events.js';
import type { WorktreeLease } from '../types/config.js';
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
  type CheckedTransitionFn,
  type ExecutableNode,
  type RunGateWithRepairFn,
  defaultBuiltInRolesDir,
  gatesWithStableKeys,
} from './workflow-runtime.js';
import type { LeaseService } from './lease-service.js';
import type { WorkflowHelpers } from './helpers.js';
import { agentFailureAuditPayload, assertSuccessfulAgentRun } from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';

export interface ReworkHandlerDeps {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  builtInRolesDir?: string;
  userHome?: string;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  artifactStore: ArtifactStoreLike;
  executionLeases: Map<string, WorktreeLease>;
  getCheckedTransition(): CheckedTransitionFn;
  getRunGateWithRepair(): RunGateWithRepairFn;
  /**
   * Phase 2 S3: optional best-effort agent-loop event sink, threaded from the
   * engine (same as node-executor). rework/review re-runs are real agent
   * executions, so they emit step events too — otherwise a run that went
   * through rework would have an incomplete model-visible replay (§13.6).
   */
  agentEventSink?: AgentEventSink;
}

export interface HumanRejectionReworkInput {
  /** 挂 human gate 的评审节点。 */
  reviewNode: ExecutableNode;
  /** 节点配置中的 human gate（携带 reworkTargetNodeId）。 */
  gate: WorkflowGateConfig;
  /** reject 时被置为 failed/human-rejected 的门禁结果。 */
  gateResult: GateResult;
  /** 返工目标的 run-scoped 节点 id（由模板 reworkTargetNodeId 解析）。 */
  targetNodeId: string;
  attempt: number;
  /** 人工驳回备注，作为返工反馈注入提示词。 */
  feedbackNote: string;
}

export interface ReworkHandler {
  attemptChangesRequestedRework(
    runId: string,
    reviewNode: ExecutableNode,
    gate: WorkflowGateConfig,
    gateResult: GateResult,
    targetNodeId: string,
    attempt: number,
  ): Promise<void>;
  /**
   * PD-18：人工驳回后的返工。反馈来自决策备注而非评审产物，目标来自
   * human gate 声明的 reworkTargetNodeId；主体七步与 changes-requested
   * 返工共用同一实现。
   */
  attemptHumanRejectionRework(
    runId: string,
    input: HumanRejectionReworkInput,
  ): Promise<void>;
  resolveReviewTargetNode(
    runId: string,
    reviewNodeId: string,
  ): Promise<string | null>;
}

export function createReworkHandler(deps: ReworkHandlerDeps): ReworkHandler {
  const {
    repoPath,
    dataDir,
    repositories,
    audit,
    adapter,
    builtInRolesDir,
    userHome,
    leaseService,
    helpers,
    promptBuilder,
    artifactStore,
    executionLeases,
    getCheckedTransition,
    getRunGateWithRepair,
  } = deps;

  /**
   * CD-14：返工目标只认真实评审产物里的 reviewProcess.targetNodeId。
   * independent-review gate 在放行/驳回前已校验该字段的连通性、角色与产物
   * 类型（gate/engine.ts runIndependentReviewGate），因此这里不再做启发式
   * 猜测：读不到合法目标就返回 null，由调用方按门禁耗尽处理（blocked），
   * 避免重跑错误节点。六种评审产物共用 reviewProcess schema，不按类型白
   * 名单过滤，取最新一个携带合法 targetNodeId 的产物。
   */
  async function resolveReviewTargetNode(
    runId: string,
    reviewNodeId: string,
  ): Promise<string | null> {
    const payload = await loadReviewArtifactPayload(runId, reviewNodeId);
    if (!payload) return null;
    const reviewProcess = payload.reviewProcess as
      | { targetNodeId?: unknown }
      | undefined;
    const targetNodeId = reviewProcess?.targetNodeId;
    if (typeof targetNodeId !== 'string' || targetNodeId.length === 0) {
      return null;
    }
    const targetNode = await repositories.getNode(targetNodeId);
    if (!targetNode || targetNode.runId !== runId) {
      return null;
    }
    return targetNodeId;
  }

  /**
   * 读取评审节点最新一个含 reviewProcess 的 JSON 产物。非 JSON / 缺字段的
   * 产物跳过；全部不可读时返回 null（调用方 fail-closed，不回退启发式）。
   */
  async function loadReviewArtifactPayload(
    runId: string,
    reviewNodeId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const artifacts = await repositories.listArtifacts(
        runId,
        reviewNodeId,
      );
      for (const artifact of [...artifacts].reverse()) {
        const artifactPath = resolve(repoPath, artifact.path);
        if (!existsSync(artifactPath)) continue;
        try {
          const payload = JSON.parse(
            readFileSync(artifactPath, 'utf8'),
          ) as Record<string, unknown>;
          const process = payload.reviewProcess as
            | { targetNodeId?: unknown }
            | undefined;
          if (process && typeof process.targetNodeId === 'string') {
            return payload;
          }
        } catch {
          // 非 JSON 或解析失败：忽略，继续看更早的产物。
        }
      }
    } catch {
      // 仓储读取失败：fail-closed。
    }
    return null;
  }

  /**
   * CD-14：返工反馈携带评审正文与具体 findings，而不是固定英文句或被截断
   * 的 JSON 头部。读不到产物时才回退到通用提示句。
   */
  async function loadReviewArtifactContent(
    runId: string,
    reviewNodeId: string,
  ): Promise<string> {
    const payload = await loadReviewArtifactPayload(runId, reviewNodeId);
    if (!payload) {
      return 'Review found changes that need to be addressed.';
    }
    const sections: string[] = [];
    if (typeof payload.title === 'string' && payload.title.length > 0) {
      sections.push(`Title: ${payload.title}`);
    }
    if (typeof payload.body === 'string' && payload.body.length > 0) {
      sections.push(`Body:\n${payload.body}`);
    }
    if (typeof payload.summary === 'string' && payload.summary.length > 0) {
      sections.push(`Summary: ${payload.summary}`);
    }
    if (typeof payload.decision === 'string') {
      sections.push(`Decision: ${payload.decision}`);
    }
    if (Array.isArray(payload.findings) && payload.findings.length > 0) {
      const lines = payload.findings.map((entry) => {
        const finding = (entry ?? {}) as Record<string, unknown>;
        const severity =
          typeof finding.severity === 'string' ? finding.severity : 'minor';
        const message =
          typeof finding.message === 'string' ? finding.message : '';
        return `- [${severity}] ${message}`.trim();
      });
      sections.push(['Findings:', ...lines].join('\n'));
    }
    return sections.length > 0
      ? sections.join('\n\n')
      : 'Review found changes that need to be addressed.';
  }

  async function buildReworkNodePrompt(
    runId: string,
    targetNode: Node,
    targetInputs: WorkflowArtifactInputRef[],
    reviewFeedback: string,
  ): Promise<string> {
    const role = loadRole({
      role: targetNode.role,
      repoPath,
      builtInRolesDir: builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome,
    });
    const workflow = await helpers.mustGetWorkflow(runId);
    const demand = await helpers.mustGetDemand(workflow.demandId);
    const reworkNodeForArtifacts: ExecutableNode = {
      id: targetNode.id,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
      ...(targetNode.prompt ? { prompt: targetNode.prompt } : {}),
      workspace: targetNode.workspace,
      inputs: targetInputs,
      outputs: (targetNode.outputs ?? []) as WorkflowArtifactOutputRef[],
      gates: (targetNode.gates ?? []) as WorkflowGateConfig[],
      dependsOn: targetNode.dependencies ?? [],
    };
    const artifacts = await artifactSummariesForReworkNode(
      runId,
      reworkNodeForArtifacts,
    );
    const allNodes = await repositories.listNodes(runId);
    const priorNodes = allNodes.filter((n) => n.id !== targetNode.id);
    const priorNodeLines = priorNodes.map((item) =>
      [
        `- ${item.id} role=${item.role} status=${item.status}`,
        item.outputs.length > 0
          ? `outputs=${item.outputs.map((output) => output.type).join(',')}`
          : 'outputs=none',
      ].join(' '),
    );
    const truncated =
      reviewFeedback.length > 8000
        ? reviewFeedback.slice(0, 8000) + '\n\n[truncated]'
        : reviewFeedback;
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Rework node ${targetNode.id} after independent review found changes-requested.`,
        // 与 resume 路径的 buildNodePrompt 对齐：节点指令在返工中仍然生效，
        // 评审反馈在其基础上叠加，避免同进程/跨进程提示词分叉。
        targetNode.prompt
          ? ['Node instruction (template-authored, still applies):', targetNode.prompt].join('\n')
          : '',
        priorNodeLines.length > 0
          ? ['Prior workflow nodes:', ...priorNodeLines].join('\n')
          : 'Prior workflow nodes: none.',
        '',
        '## Review Feedback',
        truncated,
        '',
        '## Instructions',
        '- Address each finding marked as important or blocker.',
        '- Produce corrected artifact files matching the required types.',
        '- Write the artifact manifest file before completing.',
        '- After writing the manifest, stop work and exit.',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      projectContext: {
        runId,
        nodeId: targetNode.id,
        projectId: workflow.projectId,
        repoPath,
        dataDir,
      },
      artifactSummaries: artifacts,
    });
  }

  async function artifactSummariesForReworkNode(
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

  async function attemptChangesRequestedRework(
    runId: string,
    reviewNode: ExecutableNode,
    gate: WorkflowGateConfig,
    gateResult: GateResult,
    targetNodeId: string,
    attempt: number,
  ): Promise<void> {
    const reviewFeedback = await loadReviewArtifactContent(
      runId,
      reviewNode.id,
    );
    return attemptRework({
      runId,
      reviewNode,
      gate,
      gateResult,
      targetNodeId,
      attempt,
      reviewFeedback,
      reason: 'Independent review found changes-requested',
    });
  }

  async function attemptHumanRejectionRework(
    runId: string,
    input: HumanRejectionReworkInput,
  ): Promise<void> {
    return attemptRework({
      runId,
      reviewNode: input.reviewNode,
      gate: input.gate,
      gateResult: input.gateResult,
      targetNodeId: input.targetNodeId,
      attempt: input.attempt,
      reviewFeedback: input.feedbackNote,
      reason: 'Human reviewer rejected the gate',
    });
  }

  /**
   * 返工七步的共享实现。changes-requested 与 human-rejected 仅反馈来源和
   * 原因文案不同，节点/租约/门禁/评审重跑的机制完全一致。
   */
  async function attemptRework(input: {
    runId: string;
    reviewNode: ExecutableNode;
    gate: WorkflowGateConfig;
    gateResult: GateResult;
    targetNodeId: string;
    attempt: number;
    reviewFeedback: string;
    reason: string;
  }): Promise<void> {
    const {
      runId,
      reviewNode,
      gate,
      gateResult,
      targetNodeId,
      attempt,
      reviewFeedback,
      reason,
    } = input;
    const checkedTransitionNode = getCheckedTransition();
    const runGateWithRepair = getRunGateWithRepair();

    const targetNode = await repositories.getNode(targetNodeId);
    if (!targetNode) return;

    const reworkNodeId = reworkNodeIdFor(targetNodeId, attempt, gateResult.id);

    // --- Step 1: Transition target to needs-revision ---
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'needs-revision',
      'gate.rework.needs-revision',
      {
        reviewNodeId: reviewNode.id,
        targetNodeId,
        gateResultId: gateResult.id,
        attempt,
        reason,
      },
    );

    const targetInputs = targetNode.inputs as WorkflowArtifactInputRef[];
    const targetOutputs = targetNode.outputs as WorkflowArtifactOutputRef[];
    const targetGates = targetNode.gates as WorkflowGateConfig[];
    const reworkPrompt = await buildReworkNodePrompt(
      runId,
      targetNode,
      targetInputs,
      reviewFeedback,
    );

    await leaseService.finalizeExecutionLease(runId, reviewNode.id);

    // --- Step 2: Create rework node reusing target's inputs/outputs/gates ---
    const now = new Date().toISOString();
    const derived = deriveReworkNode({
      id: targetNode.id,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
      // 保留模板声明的节点指令，使同进程返工与 resume 重建的提示词一致。
      ...(targetNode.prompt ? { prompt: targetNode.prompt } : {}),
      // CD-09：返工节点继承源节点工作区模式。
      workspace: targetNode.workspace,
      inputs: targetInputs,
      outputs: targetOutputs,
      gates: targetGates,
      dependsOn: targetNode.dependencies,
    }, reviewNode.id, attempt, gateResult.id);
    await repositories.createNode({
      id: derived.id,
      runId,
      role: derived.role,
      ...(derived.prompt ? { prompt: derived.prompt } : {}),
      // CD-09：返工节点继承源节点工作区模式，不能落回默认 worktree。
      workspace: derived.workspace,
      status: 'pending',
      inputs: derived.inputs,
      outputs: derived.outputs,
      gates: derived.gates,
      dependencies: derived.dependsOn,
      // Dynamic rework nodes are created after the original plan nodes and
      // must sort after them within the phase on a planFromRepository resume.
      // Original nodes use small array-index orders (0..N); a large offset
      // keeps rework nodes last, with created_at/id ordering successive
      // rework nodes by creation time (see listNodes ordering).
      order: DYNAMIC_NODE_ORDER_OFFSET,
      createdAt: now,
      updatedAt: now,
      phaseId: derived.phaseId,
    });

    // --- Step 3: Run rework agent ---
    const reworkRoleRunId = `role_run_${randomUUID()}`;
    await repositories.createRoleRun({
      id: reworkRoleRunId,
      runId,
      nodeId: reworkNodeId,
      role: targetNode.role,
      status: 'running',
      startedAt: now,
    });

    await checkedTransitionNode(
      runId,
      reworkNodeId,
      'running',
      'node.transition.checked',
    );

    const reworkLease = await leaseService.createExecutionLease(runId, {
      id: reworkNodeId,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
      workspace: targetNode.workspace,
    });

    try {
      let reworkSucceeded = false;
      try {
        const reworkInput = await helpers.agentInputForLease(
          runId,
          {
            id: reworkNodeId,
            role: targetNode.role,
            phaseId: targetNode.phaseId,
            ...(targetNode.prompt ? { prompt: targetNode.prompt } : {}),
            inputs: targetInputs,
            outputs: targetOutputs,
            gates: targetGates,
          },
          reworkLease,
          reworkPrompt,
          targetNodeId,
        );
        const reworkResult = await runAgentWithStepEvents(
          adapter,
          reworkInput,
          {
            runId,
            nodeId: reworkNodeId,
            role: targetNode.role,
            promptSummary: reworkInput.prompt,
          },
          deps.agentEventSink,
        );
        assertSuccessfulAgentRun(reworkResult);
        reworkSucceeded = true;
        await repositories.markRoleRunCompleted({
          roleRunId: reworkRoleRunId,
          completedAt: new Date().toISOString(),
        });
      } finally {
        if (!reworkSucceeded) {
          await leaseService
            .finalizeExecutionLease(runId, reworkNodeId)
            .catch(() => {});
        }
      }
    } catch (error) {
      // CD-33：agent 失败必须同步终结 role_run，旧实现留下 running 孤儿记录。
      await repositories.markRoleRunInterrupted({
        roleRunId: reworkRoleRunId,
        interruptedAt: new Date().toISOString(),
      });
      await repositories.transitionNode(reworkNodeId, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    // --- Step 4: Run target node's gates using targetNodeId ---
    // Gates look up the worktree lease by nodeId. The lease was created
    // under reworkNodeId, but artifacts were written to targetNodeId.
    // Temporarily alias the lease so gate-runner finds the rework worktree.
    await repositories.transitionNode(reworkNodeId, 'awaiting-gate');
    const targetLease = executionLeases.get(reworkNodeId);
    if (targetLease) {
      executionLeases.set(targetNodeId, targetLease);
    }
    const configuredTargetGates = gatesWithStableKeys(targetGates, targetNodeId);
    try {
      for (const targetGate of configuredTargetGates) {
        const gatePassed = await runGateWithRepair(
          runId,
          {
            id: targetNodeId,
            role: targetNode.role,
            phaseId: targetNode.phaseId,
            workspace: targetNode.workspace,
            inputs: targetInputs,
            outputs: targetOutputs,
            gates: targetGates,
            dependsOn: [reviewNode.id],
          },
          targetGate,
          { forceRerun: true },
        );
        if (!gatePassed) {
          return;
        }
      }
    } catch (error) {
      // CD-33：门禁抛错时别名必须随异常一起清掉，否则残留的 targetNodeId
      // 租约别名会让后续门禁/恢复拿到错误租约，用“active execution lease
      // required”二次异常掩盖真实门禁错误。
      executionLeases.delete(targetNodeId);
      throw error;
    }
    executionLeases.delete(targetNodeId);

    // --- Step 5: Finalize rework lease ---
    try {
      await leaseService.finalizeExecutionLease(runId, reworkNodeId);
    } catch (error) {
      await repositories.transitionNode(reworkNodeId, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.lease.finalize.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    await checkedTransitionNode(
      runId,
      reworkNodeId,
      'passed',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'running',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'awaiting-gate',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'passed',
      'node.transition.checked',
    );

    // --- Step 6: Re-execute review node to produce fresh review artifact ---
    await checkedTransitionNode(
      runId,
      reviewNode.id,
      'needs-revision',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      reviewNode.id,
      'running',
      'node.transition.checked',
    );

    const reviewReRunRoleRunId = `role_run_${randomUUID()}`;
    await repositories.createRoleRun({
      id: reviewReRunRoleRunId,
      runId,
      nodeId: reviewNode.id,
      role: reviewNode.role,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const reviewReRunLease = await leaseService.createExecutionLease(runId, {
      id: reviewNode.id,
      role: reviewNode.role,
      phaseId: reviewNode.phaseId,
      workspace: reviewNode.workspace,
    });

    try {
      const reviewInput = await helpers.agentInputForLease(
        runId,
        reviewNode,
        reviewReRunLease,
        await promptBuilder.buildNodePrompt(runId, reviewNode),
      );
      const reviewResult = await runAgentWithStepEvents(
        adapter,
        reviewInput,
        {
          runId,
          nodeId: reviewNode.id,
          role: reviewNode.role,
          promptSummary: reviewInput.prompt,
        },
        deps.agentEventSink,
      );
      assertSuccessfulAgentRun(reviewResult);
      await repositories.markRoleRunCompleted({
        roleRunId: reviewReRunRoleRunId,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      // CD-33：标记 role_run 中断并向上抛错。旧实现吞掉错误 return，调用方
      // 继续在 interrupted 节点上跑门禁，触发“illegal workflow transition”
      // 二次异常并掩盖真实原因。抛出后由 node-executor 的门禁 catch 统一
      // 收敛为 interrupted，resume 可恢复。
      await repositories.markRoleRunInterrupted({
        roleRunId: reviewReRunRoleRunId,
        interruptedAt: new Date().toISOString(),
      });
      await repositories.transitionNode(reviewNode.id, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.review.re-execute.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
          ...agentFailureAuditPayload(error),
        },
      });
      throw error;
    }

    // --- Step 7: Put review node back to awaiting-gate ---
    await repositories.transitionNode(reviewNode.id, 'awaiting-gate');

    // The review Gate still needs this worktree. NodeExecutor finalizes it
    // after all Gates pass, just as it does for the first review execution.
    await audit.append({
      runId,
      type: 'gate.rework.completed',
      payload: {
        reviewNodeId: reviewNode.id,
        targetNodeId,
        reworkNodeId,
        attempt,
      },
    });
  }

  return {
    attemptChangesRequestedRework,
    attemptHumanRejectionRework,
    resolveReviewTargetNode,
  };
}
