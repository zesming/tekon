import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { SessionEventBus } from './event-bus.js';
import type { SessionEventStore } from './session-store.js';
import type { EventVisibility } from '../types/session-contract.js';

/**
 * Dual-write 包装器(阶段 1 S6)。
 *
 * 设计权威:`docs/superpowers/plans/2026-08-21-phase1-event-spine-detailed-design.md`
 * §1.2(映射表 + S9 显式不映射清单)、§0.1-2(best-effort,C1 治理零回归)、
 * §2.10(web 组合根接线)。
 *
 * 语义:
 * - 包装器在**原有写入之外**追加一条 session_event(经 SessionEventStore),
 *   不改变原有写入语义(C3 双轨:旧引擎/旧表继续写,session_events 是增量)。
 * - best-effort:session_events 是可观测脊柱,绝不能拖垮治理路径(C1)。
 *   原 audit/仓储写入先发生且必须成功;session_event 追加失败仅记录、不抛错。
 * - 按 runId 反查 session(`sessions.run_id` 索引);查不到 session(旧 run,
 *   或 session 尚未创建——如 prepareRun 内的 audit `run.started`)则静默跳过。
 *   M1:凡"session 创建晚于 run 首个 audit"的事件,由 router 在 createSession
 *   后显式补发,不靠 dual-write 兜底。
 * - 不拦截 workflow/node status 写入(SHOULD7:passed/failed 已由 audit 映射为
 *   `agent/status`,再拦截会双发;cancelled 由 web cancel 路径显式发射)。
 */

// ---------------------------------------------------------------------------
// §1.2 audit → session_event 映射表
// ---------------------------------------------------------------------------

/**
 * 被映射的 audit 类型完整清单(§1.2)。此清单之外的所有 audit 类型——
 * 包括 S9 显式不映射清单与任何未知类型——一律不产生 session_event。
 */
export const MAPPED_AUDIT_EVENT_TYPES = [
  'run.started',
  'run.resumed',
  'run.passed',
  'node.started',
  'node.passed',
  'node.interrupted',
  'node.resumed-at-gates',
  'node.stale-running-detected',
  'pmo.node-checkpoint',
  'artifact.dependency.missing',
  'gate.execution.error',
  'worktree.lease.created',
  'worktree.lease.finalize.failed',
] as const;

export interface MappedSessionEvent {
  type: string;
  payload: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * 纯函数映射:audit 事件 → session_event(type + payload)。
 * 返回 null 表示不映射(S9 清单 / 未知类型)。
 *
 * 注:设计未逐条指定 visibility/modelVisible/correlationId,dual-write 事件
 * 统一采用契约默认值(ui-only / false / null)——治理事件是 UI 可观测脊柱,
 * 非模型对话上下文;modelVisible:true 仅 router/executor 显式 append 的
 * user/message、assistant/message 使用(§2.5/§2.10,属 S7 范围)。
 */
export function mapAuditEventToSessionEvent(input: {
  runId: string;
  auditType: string;
  auditPayload: Record<string, unknown>;
}): MappedSessionEvent | null {
  const { runId, auditType, auditPayload: p } = input;
  switch (auditType) {
    case 'run.started':
      // M1:web 路径由 router 在 createSession 后显式补发;prepareRun 内
      // audit run.started 的 dual-write 因 session 不存在被静默跳过。
      return {
        type: 'workflow/started',
        payload: {
          runId,
          templateId: asString(p.templateId),
          mode: asString(p.mode),
          kind: 'workflow',
        },
      };
    case 'run.resumed':
      return {
        type: 'workflow/started',
        payload: { runId, resumed: true, kind: 'workflow' },
      };
    case 'run.passed':
      // D4:run 级完成统一用 agent/status(payload 加 kind:'workflow')。
      return {
        type: 'agent/status',
        payload: { runId, status: 'passed', kind: 'workflow' },
      };
    case 'node.started':
      return {
        type: 'workflow/node-started',
        payload: { runId, nodeId: asString(p.nodeId), role: asString(p.role) },
      };
    case 'node.passed':
      return {
        type: 'workflow/node-ended',
        payload: { runId, nodeId: asString(p.nodeId), status: 'passed' },
      };
    case 'node.interrupted':
      return {
        type: 'workflow/node-ended',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          status: 'interrupted',
          error: asString(p.error),
        },
      };
    case 'node.resumed-at-gates':
      return {
        type: 'workflow/node-started',
        payload: { runId, nodeId: asString(p.nodeId), resumed: 'at-gates' },
      };
    case 'node.stale-running-detected':
      return {
        type: 'workflow/node-ended',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          status: 'interrupted',
          reason: 'stale-running',
        },
      };
    case 'pmo.node-checkpoint':
      return {
        type: 'job/checkpointed',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          status: asString(p.status),
          missingArtifacts: asStringArray(p.missingArtifacts),
        },
      };
    case 'artifact.dependency.missing':
      return {
        type: 'agent/status',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          status: 'blocked',
          missing: {
            fromNodeId: asString(p.fromNodeId),
            type: asString(p.artifactType),
          },
        },
      };
    case 'gate.execution.error':
      return {
        type: 'agent/error',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          message: asString(p.error),
        },
      };
    case 'worktree.lease.created':
      // 不含 worktreePath(§1.2:payload 已脱敏/摘要化)。
      return {
        type: 'worktree/leased',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          leaseId: asString(p.leaseId),
          branchName: asString(p.branchName),
        },
      };
    case 'worktree.lease.finalize.failed':
      return {
        type: 'agent/error',
        payload: {
          runId,
          nodeId: asString(p.nodeId),
          message: asString(p.error),
        },
      };
    default:
      // S9 显式不映射清单 + 任何未知类型:不产生 session_event。
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bridge:按 runId 反查 session → appendEvent → bus.publish(best-effort)
// ---------------------------------------------------------------------------

export interface SessionDualWriteBridge {
  /**
   * 按 runId 反查 session 并追加一条 session_event,随后 publish 到 bus。
   * 无 session(旧 run / session 尚未创建)静默跳过;任何失败仅记录、不抛错。
   */
  recordFromRun(input: {
    runId: string;
    type: string;
    payload?: Record<string, unknown>;
    visibility?: EventVisibility;
    modelVisible?: boolean;
    sourceEventSeqs?: number[];
    correlationId?: string | null;
  }): Promise<void>;
}

export function createSessionDualWriteBridge(deps: {
  sessions: SessionEventStore;
  bus: SessionEventBus;
  /** best-effort 失败回调(默认静默)。session_events 不能拖垮治理路径(C1)。 */
  onError?: (error: unknown) => void;
}): SessionDualWriteBridge {
  const reportError = deps.onError ?? (() => {});
  return {
    async recordFromRun(input) {
      try {
        const session = await deps.sessions.findSessionByRunId(input.runId);
        if (!session) {
          // 无 session 的旧 run,或 session 尚未创建(如 prepareRun 内的
          // run.started)。M1:此类事件由 router 在 createSession 后显式补发
          // workflow/started(见 web project.ts createSession 后的补发逻辑);
          // 此处保持静默跳过,不兜底。
          return;
        }
        const event = await deps.sessions.appendEvent({
          sessionId: session.id,
          type: input.type,
          payload: input.payload,
          visibility: input.visibility,
          modelVisible: input.modelVisible,
          sourceEventSeqs: input.sourceEventSeqs,
          correlationId: input.correlationId,
        });
        deps.bus.publish(event);
      } catch (error) {
        reportError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AuditLogger 包装器
// ---------------------------------------------------------------------------

/**
 * 包装 AuditLogger:先委托原 audit.append(哈希链不变,C1 治理零回归),
 * 再 best-effort 按 §1.2 映射追加 session_event。
 */
export function createDualWriteAuditLogger(
  audit: AuditLogger,
  bridge: SessionDualWriteBridge,
): AuditLogger {
  return {
    async append(input) {
      const event = await audit.append(input);
      const mapped = mapAuditEventToSessionEvent({
        runId: input.runId,
        auditType: input.type,
        auditPayload: input.payload,
      });
      if (mapped) {
        await bridge.recordFromRun({
          runId: input.runId,
          type: mapped.type,
          payload: mapped.payload,
        });
      }
      return event;
    },
    async verify(runId) {
      return audit.verify(runId);
    },
  };
}

// ---------------------------------------------------------------------------
// Repositories 包装器
// ---------------------------------------------------------------------------

/**
 * 包装 TekonRepositories:透传全部方法,仅拦截 §1.2 的四个仓储写入方法
 * (recordGateResult / recordArtifact / createHumanDecision /
 * updateHumanDecision),在原写入成功后 best-effort 追加 session_event。
 *
 * 不拦截 updateWorkflowInstanceStatus / casWorkflowInstanceStatus
 * (SHOULD7:防完成事件双发)。
 */
export function createDualWriteRepositories(
  repositories: TekonRepositories,
  bridge: SessionDualWriteBridge,
): TekonRepositories {
  return {
    ...repositories,

    async recordGateResult(gateResult) {
      const result = await repositories.recordGateResult(gateResult);
      await bridge.recordFromRun({
        runId: result.runId,
        type: 'gate/result',
        payload: {
          runId: result.runId,
          nodeId: result.nodeId,
          gateType: result.gateType,
          gateKey: result.gateKey ?? null,
          status: result.status,
          durationMs: result.durationMs,
          retries: result.retries,
        },
      });
      return result;
    },

    async recordArtifact(artifact) {
      const result = await repositories.recordArtifact(artifact);
      await bridge.recordFromRun({
        runId: result.runId,
        type: 'artifact/created',
        payload: {
          runId: result.runId,
          nodeId: result.nodeId,
          artifactId: result.id,
          type: result.type,
          version: result.version,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          summary: result.summary ?? null,
        },
      });
      return result;
    },

    async createHumanDecision(decision) {
      const result = await repositories.createHumanDecision(decision);
      // 仅 pending(新审批请求)映射为 approval/requested;approved/rejected
      // 状态的直接落库不是新请求,不产生事件。
      if (result.status === 'pending') {
        await bridge.recordFromRun({
          runId: result.runId,
          type: 'approval/requested',
          payload: {
            runId: result.runId,
            nodeId: result.nodeId,
            decisionId: result.id,
            // HumanDecision 无 request 字段;以 gateResultId 标识本审批请求
            // 所针对的 gate result(设计假设,见 S6 汇报)。
            request: result.gateResultId ?? null,
          },
        });
      }
      return result;
    },

    async updateHumanDecision(decisionId, patch, expectedStatus) {
      const result = await repositories.updateHumanDecision(
        decisionId,
        patch,
        expectedStatus,
      );
      if (result) {
        await bridge.recordFromRun({
          runId: result.runId,
          type: 'approval/decided',
          payload: {
            runId: result.runId,
            nodeId: result.nodeId,
            decisionId: result.id,
            decision: result.status,
            actor: result.actor ?? null,
          },
        });
      }
      return result;
    },
  };
}
