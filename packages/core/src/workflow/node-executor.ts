import { randomUUID } from 'node:crypto';

import type { ArtifactType, AuditEvent } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  runAgentWithStepEvents,
  type AgentEventSink,
} from '../runtime/agent-step-events.js';
import {
  type ExecutableNode,
  type CheckedTransitionFn,
  type ResumeExecutionOptions,
  gatesWithStableKeys,
  resolveMaxReworkAttempts,
} from './workflow-runtime.js';
import { reworkNodeIdFor } from './execution-plan.js';
import type { LeaseService } from './lease-service.js';
import { RecoverableLeaseError } from './lease-service.js';
import {
  evaluateDeterministicBlock,
  type DeterministicBlock,
} from './resume-policy.js';
import { resolveHumanReworkTrigger } from './human-rework.js';
import type { ReworkHandler } from './rework.js';
import type { WorkflowHelpers } from './helpers.js';
import {
  agentFailureAuditPayload,
  assertSuccessfulAgentRun,
  requiredArtifactTypesForNode,
} from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';
import { appendGateFailureReason } from './prompt-builder.js';
import type { GateRunner } from './gate-runner.js';
import { isWorkflowTerminalError } from './errors.js';
import { writeWorkflowTerminal } from './state-machine.js';
import { isJobCancellationAbort, isJobOwnershipLostAbort, isJobShutdownAbort } from '../session/job-runner.js';
import type { WorktreeLease } from '../types/config.js';

/**
 * CD-09 8b-3：识别“finalize 失败的可恢复中断”。该状态下 agent 与所有 Gate
 * 都已完成、租约仍 active，节点最后一个自身事件是 worktree.lease.finalize.failed。
 * resume 时应直接重试 finalize，而不是重跑 agent（旧实现每次 resume 都重跑，
 * 用户无法走出去）。只认节点自身的最后事件，避免被后续其他节点事件污染。
 */
export function isRecoverableFinalizeInterrupt(
  events: AuditEvent[],
  nodeId: string,
): boolean {
  const lastNodeEvent = [...events]
    .reverse()
    .find((event) => event.payload?.nodeId === nodeId);
  return lastNodeEvent?.type === 'worktree.lease.finalize.failed';
}

/**
 * CD-09 SF-1：finalize 失败审计事件除 error 文案外，展开
 * RecoverableLeaseError.details（改动路径、工作树/快照位置、恢复指引），
 * 让 CLI/Web 的 interrupted 呈现能把“怎么取回/恢复”送到用户面前。
 */
function finalizeFailurePayload(
  nodeId: string,
  error: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    nodeId,
    error: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof RecoverableLeaseError) {
    payload.recoverable = true;
    payload.changedPaths = error.details.changedPaths;
    payload.recoveryHint = error.details.recoveryHint;
    if (error.details.worktreePath) payload.worktreePath = error.details.worktreePath;
    if (error.details.snapshotPath) payload.snapshotPath = error.details.snapshotPath;
  }
  return payload;
}

export interface NodeExecutorDeps {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  gateRunner: GateRunner;
  getCheckedTransition(): CheckedTransitionFn;
  /**
   * PD-18：人工驳回返工处理器。可选注入；缺省时 blocked 人工节点走常规
   * 重跑路径（旧行为）。
   */
  getReworkHandler?(): ReworkHandler;
  /**
   * Job-level abort signal: user cancellation settles cancelled, shutdown
   * preserves an interrupted checkpoint, and ownership loss fences writes.
   * Absent means legacy behavior.
   */
  signal?: AbortSignal;
  /**
   * Phase 2 S3: optional best-effort sink for agent-loop step events
   * (step/start, tool/*, assistant/message, agent/error, step/end). The web
   * executor wires the dual-write bridge; CLI passes nothing → no events. MUST
   * be best-effort (never throw) — C1 governance zero-regression.
   */
  agentEventSink?: AgentEventSink;
}

export interface NodeExecutor {
  executeNode(
    runId: string,
    node: ExecutableNode,
    resumeOptions?: ResumeExecutionOptions,
  ): Promise<boolean>;
  appendPmoNodeCheckpoint(runId: string, node: ExecutableNode): Promise<void>;
  hasMissingArtifactDependency(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean>;
}

export function createNodeExecutor(deps: NodeExecutorDeps): NodeExecutor {
  const {
    repoPath,
    repositories,
    audit,
    adapter,
    leaseService,
    helpers,
    promptBuilder,
    gateRunner,
    getCheckedTransition,
  } = deps;

  async function hasMissingArtifactDependency(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean> {
    for (const input of node.inputs) {
      const artifacts = await repositories.listArtifacts(
        runId,
        input.fromNodeId,
        input.type,
      );
      if (artifacts.length === 0) {
        await audit.append({
          runId,
          type: 'artifact.dependency.missing',
          payload: {
            nodeId: node.id,
            fromNodeId: input.fromNodeId,
            artifactType: input.type,
          },
        });
        return true;
      }
    }
    return false;
  }

  async function executeNode(
    runId: string,
    node: ExecutableNode,
    resumeOptions?: ResumeExecutionOptions,
  ): Promise<boolean> {
    const checkedTransitionNode = getCheckedTransition();

    const current = await repositories.getNode(node.id);
    if (!current) {
      throw new Error(`node not found: ${node.id}`);
    }

    const resumableLease = await leaseService.activeExecutionLease(
      runId,
      node.id,
    );
    const completedAgentRun = await helpers.hasCompletedAgentRun(
      runId,
      node.id,
    );

    // PD-31：blocked 节点的恢复入口。两种特殊处理都只在 resume 时生效，
    // 首次执行不会是 blocked。
    if (current.status === 'blocked') {
      // 1) 确定性失败 fail-fast：白名单分类且条件仍成立时，不建 role_run、
      //    不调 agent，节点与 run 保持 blocked，把原因/下一步写入审计。
      if (!resumeOptions?.gatesOnly) {
        const deterministicBlock =
          await evaluateBlockedDeterministicFailure({
            repositories,
            repoPath,
            runId,
            node,
            lease: resumableLease ?? undefined,
          });
        if (deterministicBlock) {
          await audit.append({
            runId,
            type: 'node.resume-skipped-deterministic',
            payload: {
              nodeId: node.id,
              ...deterministicBlock,
            },
          });
          // resumeRun 入口已把 run 置为 running；fail-fast 没有推进节点，
          // 必须回写 blocked，否则工作流行会谎报 running。
          await repositories.updateWorkflowInstanceStatusIfActive(
            runId,
            'blocked',
            node.id,
          );
          return false;
        }
      }

      // 3) --gates-only：显式只重跑门禁。前置条件是该节点已有完成的 agent
      //    执行，否则产物不存在，跳过 agent 没有意义，直接拒绝入参。
      if (resumeOptions?.gatesOnly) {
        if (!completedAgentRun) {
          // resumeRun 入口已把 run 置 running；拒绝时必须回写 blocked，
          // 否则工作流行谎报 running（与 fail-fast 分支同一守护）。
          await repositories.updateWorkflowInstanceStatusIfActive(
            runId,
            'blocked',
            node.id,
          );
          throw new Error(
            `GATES_ONLY_NO_AGENT_RUN: 节点 ${node.id} 没有已完成的 agent 执行，不能只重跑门禁；请去掉 --gates-only 后恢复。`,
          );
        }
        await checkedTransitionNode(
          runId,
          node.id,
          'running',
          'node.transition.checked',
          { fromStatus: 'blocked' },
        );
        await repositories.transitionNode(node.id, 'awaiting-gate');
        await repositories.updateWorkflowInstanceStatusIfActive(
          runId,
          'running',
          node.id,
        );
        await audit.append({
          runId,
          type: 'node.resumed-gates-only',
          payload: { nodeId: node.id, role: node.role },
        });
      }

      // 2) PD-18：人工驳回且 human gate 声明了返工目标时，对目标节点发起
      //    返工（备注作为反馈），而不是盲目重跑本节点 agent。返工七步结束
      //    后本节点回到 awaiting-gate，下方门禁循环重新请求人工审批。
      if (!resumeOptions?.gatesOnly) {
        const reworkHandler = deps.getReworkHandler?.();
        if (reworkHandler) {
          const [nodes, gateResults, decisions, events] = await Promise.all([
            repositories.listNodes(runId),
            repositories.listGateResults(runId),
            repositories.listHumanDecisions(runId),
            repositories.listAuditEvents(runId),
          ]);
          const trigger = resolveHumanReworkTrigger({
            runId,
            node,
            nodes,
            gateResults,
            decisions,
            reworkAttemptEvents: events.filter(
              (event) => event.type === 'gate.rework.attempt',
            ),
          });
          if (trigger) {
            await checkedTransitionNode(
              runId,
              node.id,
              'running',
              'node.transition.checked',
              { fromStatus: 'blocked' },
            );
            await audit.append({
              runId,
              type: 'node.human-rework.started',
              payload: {
                nodeId: node.id,
                decisionId: trigger.decision.id,
                targetNodeId: trigger.targetNodeId,
                attempt: trigger.attempt,
              },
            });
            // 与 gate-runner 的 changes-requested 路径同形状发返工意图事件：
            // 完整性校验靠 gate.rework.attempt 与 attemptRework 第一步的
            // gate.rework.needs-revision 配对，才会授权动态返工节点；缺了它，
            // 下一次 resume 必然 nodes.unproven。reworkNodeId 用同一推导函数
            // 保证与校验器算出的 id 一致。
            await audit.append({
              runId,
              type: 'gate.rework.attempt',
              payload: {
                nodeId: node.id,
                reviewNodeId: node.id,
                targetNodeId: trigger.targetNodeId,
                reworkNodeId: reworkNodeIdFor(
                  trigger.targetNodeId,
                  trigger.attempt,
                  trigger.gateResult.id,
                ),
                attempt: trigger.attempt,
                maxAttempts: resolveMaxReworkAttempts(trigger.gate.maxRetries),
                gateResultId: trigger.gateResult.id,
              },
            });
            try {
              await reworkHandler.attemptHumanRejectionRework(runId, {
                reviewNode: node,
                gate: trigger.gate,
                gateResult: trigger.gateResult,
                targetNodeId: trigger.targetNodeId,
                attempt: trigger.attempt,
                feedbackNote: trigger.feedbackNote,
              });
            } catch (error) {
              // 与门禁 catch 对称的失败收敛：作业取消/关停走终止路径；真实
              // 错误把节点与工作流收敛为 interrupted（attemptRework 内部可
              // 能已把本节点置 interrupted，先重读避免非法二次转换），不留
              // running 假象，resume 可从 interrupted 状态恢复。
              if (await stopAbortedGateExecution()) {
                await audit.append({
                  runId,
                  type: 'node.human-rework.interrupted',
                  payload: {
                    nodeId: node.id,
                    reason: isJobOwnershipLostAbort(deps.signal)
                      ? 'ownership-lost'
                      : isJobShutdownAbort(deps.signal)
                        ? 'shutdown'
                        : 'cancelled',
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                });
                return false;
              }
              const latestNode = await repositories.getNode(node.id);
              if (latestNode && latestNode.status !== 'interrupted') {
                await repositories.transitionNode(node.id, 'interrupted');
              }
              await repositories.updateWorkflowInstanceStatusIfActive(
                runId,
                'interrupted',
                node.id,
              );
              await audit.append({
                runId,
                type: 'node.human-rework.failed',
                payload: {
                  nodeId: node.id,
                  error:
                    error instanceof Error ? error.message : String(error),
                  ...agentFailureAuditPayload(error),
                },
              });
              return false;
            }
            // 返工已把节点置为 awaiting-gate，直接进入门禁恢复路径，
            // 跳过整个 agent 执行段。
            current.status = 'awaiting-gate';
          }
        }
      }
    }

    // CD-09 8b-3：finalize 失败的可恢复中断。此时 agent 与全部 Gate 都已
    // 完成、租约仍 active，节点最后自身事件是 worktree.lease.finalize.failed。
    // resume 直接重试 finalize，绝不重跑 agent——修复旧实现“每次 resume 都
    // 重跑 agent、用户走不出去”的缺陷。
    if (
      current.status === 'interrupted' &&
      resumableLease &&
      !resumableLease.releasedAt &&
      isRecoverableFinalizeInterrupt(
        await repositories.listAuditEvents(runId),
        node.id,
      )
    ) {
      if (deps.signal?.aborted) return false;
      await checkedTransitionNode(
        runId,
        node.id,
        'running',
        'node.transition.checked',
        { fromStatus: 'interrupted' },
      );
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'running',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.resumed-finalize',
        payload: { nodeId: node.id, role: node.role },
      });
      try {
        await leaseService.finalizeExecutionLease(runId, node.id);
      } catch (error) {
        // N-1：cancel/关停与 finalize 失败竞态时，优先尊重 abort 语义，
        // 不把已被其他 owner 终态化的运行盲写回 interrupted。
        if (await stopAbortedGateExecution()) return false;
        // 用户尚未回滚改动：回到 interrupted 并再记一次失败，等待再次 resume。
        await repositories.transitionNode(node.id, 'interrupted');
        await repositories.updateWorkflowInstanceStatusIfActive(
          runId,
          'interrupted',
          node.id,
        );
        await audit.append({
          runId,
          type: 'worktree.lease.finalize.failed',
          payload: finalizeFailurePayload(node.id, error),
        });
        return false;
      }
      if (await stopAbortedGateExecution()) return false;
      await checkedTransitionNode(runId, node.id, 'passed', 'node.passed');
      await appendPmoNodeCheckpoint(runId, node);
      return true;
    }

    if (
      Boolean(resumableLease) &&
      current.status === 'running' &&
      !completedAgentRun
    ) {
      // SHOULD4: the previous worker crashed mid-node; mark its leftover
      // running role_run as interrupted so recovery has a symmetric API.
      const staleRoleRun = await repositories.getLatestRoleRunForNode(
        runId,
        node.id,
      );
      if (staleRoleRun?.status === 'running') {
        await repositories.markRoleRunInterrupted({
          roleRunId: staleRoleRun.id,
          interruptedAt: new Date().toISOString(),
        });
      }
      await repositories.transitionNode(node.id, 'interrupted');
      // F4-P0-05: guarded write — never revert a run another owner already
      // settled terminal. The stale-running-detected path is reachable by a
      // worker resuming a job whose previous owner crashed mid-node.
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.stale-running-detected',
        payload: { nodeId: node.id, role: node.role },
      });
      return false;
    }
    const fallbackGateCheckpoint = current.status === 'needs-revision' && completedAgentRun &&
      resumableLease?.nodeId === node.id && hasPendingFallbackGate(
        await repositories.listAuditEvents(runId), node.id, resumableLease.id,
      );
    // PD-31：--gates-only 在上方已把 blocked 节点推进到 awaiting-gate，
    // 这里直接识别该状态，跳过整个 agent 执行段。
    const gatesOnlyResume =
      current.status === 'blocked' && resumeOptions?.gatesOnly === true;
    const resumeFromGate =
      fallbackGateCheckpoint ||
      gatesOnlyResume ||
      current.status === 'awaiting-gate' ||
      (Boolean(resumableLease) &&
        ['paused', 'running'].includes(current.status) &&
        completedAgentRun);

    if (resumeFromGate) {
      if (current.status === 'paused' || fallbackGateCheckpoint) {
        // A newly persisted fallback lease may precede its Gate checkpoint.
        await repositories.transitionNode(node.id, 'running');
        await repositories.transitionNode(node.id, 'awaiting-gate');
      } else if (current.status === 'running') {
        await repositories.transitionNode(node.id, 'awaiting-gate');
      }
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'running',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.resumed-at-gates',
        payload: { nodeId: node.id, role: node.role },
      });
    } else {
      const fromStatus =
        current.status === 'interrupted' ||
        current.status === 'needs-revision' ||
        current.status === 'blocked' ||
        // PD-17 步 3：retryRun 把 failed 运行重新驱动到这里，failed 节点经
        // 状态机开口 failed→running 走全新 agent 执行（新建 role_run）；
        // 工作树租约与 blocked/interrupted 恢复同规则——同节点仍活动的未释放
        // 租约复用（保留工作树现场），不存在时才新建。
        current.status === 'failed'
          ? current.status
          : 'pending';
      await checkedTransitionNode(
        runId,
        node.id,
        'running',
        'node.transition.checked',
        { fromStatus },
      );
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'running',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.started',
        payload: { nodeId: node.id, role: node.role },
      });

      try {
        const roleRunId = `role_run_${randomUUID()}`;
        await repositories.createRoleRun({
          id: roleRunId,
          runId,
          nodeId: node.id,
          role: node.role,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        // A blocked/interrupted source execution still owns its working edits.
        // Reuse only that source lease; repair aliases belong to another node.
        const lease = resumableLease?.runId === runId &&
          resumableLease.nodeId === node.id && resumableLease.role === node.role &&
          !resumableLease.releasedAt
          ? resumableLease
          : await leaseService.createExecutionLease(runId, node);
        if (deps.signal?.aborted) {
          await repositories.markRoleRunInterrupted({
            roleRunId,
            interruptedAt: new Date().toISOString(),
          });
          // Ownership-lost fencing: another owner recovered this job and is
          // authoritative. This fenced executor must NOT touch the shared node
          // or workflow rows — doing so could revert the new owner's terminal
          // state (terminal-state monotonicity). Clean up only our own
          // role_run (done above) and stand down.
          if (isJobOwnershipLostAbort(deps.signal)) {
            await audit.append({
              runId,
              type: 'node.interrupted',
              payload: {
                nodeId: node.id,
                error: 'job ownership lost before agent start (fenced)',
              },
            });
            return false;
          }
          await repositories.transitionNode(node.id, 'interrupted');
          const cancelled = isJobCancellationAbort(deps.signal);
          if (cancelled) {
            await writeWorkflowTerminal(
              repositories,
              runId,
              'cancelled',
              node.id,
            );
          } else {
            // Genuine interrupt (no fencing signal): guard the write so it can
            // never overwrite a terminal status.
            await repositories.updateWorkflowInstanceStatusIfActive(
              runId,
              'interrupted',
              node.id,
            );
          }
          await leaseService
            .finalizeExecutionLease(runId, node.id)
            .catch(() => {});
          await audit.append({
            runId,
            type: 'node.interrupted',
            payload: {
              nodeId: node.id,
              error: cancelled
                ? 'cancelled before agent start'
                : 'interrupted before agent start',
            },
          });
          return false;
        }
        let agentSucceeded = false;
        try {
          // PD-31：blocked 恢复重跑时把最近一次门禁失败原因注入提示词，
          // 让 agent 知道要修复什么；白名单确定性失败已在入口 fail-fast，
          // 能走到这里的都是重跑可能修复的分类。
          let nodePrompt = await promptBuilder.buildNodePrompt(runId, node);
          if (current.status === 'blocked') {
            const latestFailedGate = (
              await repositories.listGateResults(runId)
            )
              .filter(
                (result) =>
                  result.nodeId === node.id && result.status === 'failed',
              )
              .at(-1);
            if (latestFailedGate) {
              nodePrompt = appendGateFailureReason(nodePrompt, latestFailedGate);
            }
          }
          const agentInput = await helpers.agentInputForLease(
            runId,
            node,
            lease,
            nodePrompt,
          );
          if (deps.signal) {
            // S5: propagate the job-level signal into the agent run so the
            // adapter can short-circuit / kill its subprocess.
            agentInput.signal = deps.signal;
          }
          const agentResult = await runAgentWithStepEvents(
            adapter,
            agentInput,
            {
              runId,
              nodeId: node.id,
              role: node.role,
              promptSummary: agentInput.prompt,
            },
            deps.agentEventSink,
          );
          assertSuccessfulAgentRun(agentResult);
          agentSucceeded = true;
          await repositories.markRoleRunCompleted({
            roleRunId,
            completedAt: new Date().toISOString(),
          });
        } finally {
          if (!agentSucceeded) {
            // P1-05: the agent did not complete — mark this role_run as
            // interrupted (symmetric to markRoleRunCompleted) so recovery
            // can distinguish crashed runs from finished ones.
            await repositories.markRoleRunInterrupted({
              roleRunId,
              interruptedAt: new Date().toISOString(),
            });
            // Ownership-lost fencing: the new owner is authoritative. Stand
            // down without side effects — do NOT touch shared node/workflow
            // rows (would revert its terminal state) and do NOT finalize the
            // lease (commit + promote would push this stale worktree onto the
            // run branch the new owner already owns). Our own role_run is
            // marked interrupted above.
            if (!isJobOwnershipLostAbort(deps.signal)) {
              await repositories.transitionNode(node.id, 'interrupted');
              if (isJobCancellationAbort(deps.signal)) {
                // S5: abort path — the workflow settles `cancelled` via the
                // idempotent terminal writer (M2), not `interrupted`.
                await writeWorkflowTerminal(
                  repositories,
                  runId,
                  'cancelled',
                  node.id,
                );
              } else {
                // Genuine interrupt: guarded write never overwrites terminal.
                await repositories.updateWorkflowInstanceStatusIfActive(
                  runId,
                  'interrupted',
                  node.id,
                );
              }
              await leaseService
                .finalizeExecutionLease(runId, node.id)
                .catch(() => {});
            }
          }
        }
      } catch (error) {
        // A terminal-status conflict must propagate to the executor (which
        // maps it to job cancelled), never be swallowed into `interrupted`.
        if (isWorkflowTerminalError(error)) {
          throw error;
        }
        // Ownership-lost fencing: stand down without touching shared node or
        // workflow rows — the recovering owner is authoritative and may have
        // already settled a terminal status we must not revert.
        if (isJobOwnershipLostAbort(deps.signal)) {
          await audit.append({
            runId,
            type: 'node.interrupted',
            payload: {
              nodeId: node.id,
              error: 'job ownership lost (fenced)',
            },
          });
          return false;
        }
        await repositories.transitionNode(node.id, 'interrupted');
        if (isJobCancellationAbort(deps.signal)) {
          // S5: the finally block above (or the pre-agent check) already
          // settled the run via writeWorkflowTerminal; this second call is
          // the idempotent no-op path (written=false). If the failure
          // happened before the inner try (e.g. lease creation), this is
          // the sole cancel write.
          await writeWorkflowTerminal(
            repositories,
            runId,
            'cancelled',
            node.id,
          );
        } else {
          // Genuine interrupt: guarded write never overwrites terminal.
          await repositories.updateWorkflowInstanceStatusIfActive(
            runId,
            'interrupted',
            node.id,
          );
        }
        await audit.append({
          runId,
          type: 'node.interrupted',
          payload: {
            nodeId: node.id,
            error: error instanceof Error ? error.message : String(error),
            ...agentFailureAuditPayload(error),
          },
        });
        return false;
      }

      await checkedTransitionNode(
        runId,
        node.id,
        'awaiting-gate',
        'node.transition.checked',
      );
    }
    // A completed Agent is resumable at its Gates. Shutdown/cancellation must
    // leave that checkpoint and lease intact; repair may instead have left the
    // source needs-revision, which must also remain truthful for recovery.
    async function stopAbortedGateExecution(): Promise<boolean> {
      if (!deps.signal?.aborted) return false;
      if (isJobOwnershipLostAbort(deps.signal)) return true;
      if (isJobCancellationAbort(deps.signal)) {
        await writeWorkflowTerminal(repositories, runId, 'cancelled', node.id);
      } else {
        await repositories.updateWorkflowInstanceStatusIfActive(runId, 'interrupted', node.id);
      }
      return true;
    }

    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    try {
      for (const gate of configuredGates) {
        if (await stopAbortedGateExecution()) return false;
        const passed = await gateRunner.runGateWithRepair(runId, node, gate);
        if (await stopAbortedGateExecution()) return false;
        if (!passed) {
          return false;
        }
      }
    } catch (error) {
      if (await stopAbortedGateExecution()) {
        await audit.append({
          runId,
          type: 'gate.execution.interrupted',
          payload: {
            nodeId: node.id,
            reason: isJobOwnershipLostAbort(deps.signal)
              ? 'ownership-lost'
              : isJobShutdownAbort(deps.signal) ? 'shutdown' : 'cancelled',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }
      await repositories.transitionNode(node.id, 'interrupted');
      // Guarded: never overwrite a terminal status settled by another writer.
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'gate.execution.error',
        payload: {
          nodeId: node.id,
          error: error instanceof Error ? error.message : String(error),
          ...agentFailureAuditPayload(error),
        },
      });
      return false;
    }

    try {
      if (await stopAbortedGateExecution()) return false;
      await helpers.recordQaValidationRef(runId, node);
      if (await stopAbortedGateExecution()) return false;
      await leaseService.finalizeExecutionLease(runId, node.id);
    } catch (error) {
      if (await stopAbortedGateExecution()) return false;
      await repositories.transitionNode(node.id, 'interrupted');
      // Guarded: never overwrite a terminal status settled by another writer.
      await repositories.updateWorkflowInstanceStatusIfActive(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'worktree.lease.finalize.failed',
        payload: finalizeFailurePayload(node.id, error),
      });
      return false;
    }

    if (await stopAbortedGateExecution()) return false;
    await checkedTransitionNode(runId, node.id, 'passed', 'node.passed');
    await appendPmoNodeCheckpoint(runId, node);
    return true;
  }

  async function appendPmoNodeCheckpoint(
    runId: string,
    node: ExecutableNode,
  ): Promise<void> {
    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    const requiredArtifacts = requiredArtifactTypesForNode(node);
    const missingArtifacts: ArtifactType[] = [];
    for (const artifactType of requiredArtifacts) {
      const artifacts = await repositories.listArtifacts(
        runId,
        node.id,
        artifactType,
      );
      if (artifacts.length === 0) {
        missingArtifacts.push(artifactType);
      }
    }
    const gateResults = await repositories.listGateResults(runId);
    await audit.append({
      runId,
      type: 'pmo.node-checkpoint',
      payload: {
        nodeId: node.id,
        role: node.role,
        status: 'passed',
        requiredArtifacts,
        missingArtifacts,
        gateTypes: configuredGates.map((gate) => gate.type),
        gateKeys: configuredGates.map((gate) => gate.gateKey),
        latestGateStatuses: gateRunner.latestGateResultsForNode(
          gateResults,
          node.id,
        ),
      },
    });
  }

  return {
    executeNode,
    appendPmoNodeCheckpoint,
    hasMissingArtifactDependency,
  };
}

/**
 * PD-31：blocked 节点 resume 前的确定性失败判定。取节点最新一个 failed
 * 门禁结果，匹配其在节点配置中的 gate（type+gateKey），再用当前仓库配置
 * 复核失败条件是否仍成立。条件已消失、分类不在白名单或匹配不到配置时
 * 返回 null，调用方走常规 agent 重跑。
 */
export async function evaluateBlockedDeterministicFailure(input: {
  repositories: TekonRepositories;
  repoPath: string;
  runId: string;
  node: ExecutableNode;
  lease: WorktreeLease | undefined;
}): Promise<DeterministicBlock | null> {
  const failedResults = (await input.repositories.listGateResults(input.runId))
    .filter(
      (result) => result.nodeId === input.node.id && result.status === 'failed',
    );
  const latest = failedResults.at(-1);
  if (!latest?.failureClassification) return null;
  const configuredGate = gatesWithStableKeys(
    input.node.gates,
    input.node.id,
  ).find((gate) => gate.type === latest.gateType && gate.gateKey === latest.gateKey);
  if (!configuredGate) return null;
  return evaluateDeterministicBlock({
    profileRepoPath: input.repoPath,
    policyCwd: input.lease?.worktreePath ?? input.repoPath,
    gate: configuredGate,
    classification: latest.failureClassification,
  });
}

// An ordinary failed repair can persist its replacement source lease before
// shutdown prevents the node checkpoint. A later repair intent supersedes it.
export function hasPendingFallbackGate(
  events: Pick<AuditEvent, 'type' | 'payload'>[], nodeId: string, leaseId: string,
): boolean {
  const created = events.map(event => event.type === 'worktree.lease.created' &&
    event.payload.nodeId === nodeId && event.payload.leaseId === leaseId).lastIndexOf(true);
  const failed = events.map(event => event.type === 'gate.repair.failed' && event.payload.nodeId === nodeId).lastIndexOf(true);
  const intent = events.map(event => event.type === 'gate.repair.intent' && event.payload.sourceNodeId === nodeId).lastIndexOf(true);
  return failed >= 0 && created > failed && created > intent;
}
