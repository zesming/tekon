import { redactSecrets } from '../security/secrets.js';
import type { AuditEvent } from '../types/domain.js';

export interface RunFailureReason {
  message: string;
  /** Diagnostic code, e.g. not-authenticated; absent for unclassified errors. */
  kind?: string;
  hint?: string;
}

const FAILURE_EVENT_TYPES = new Set([
  'node.interrupted',
  'gate.execution.error',
  'gate.repair.failed',
  'gate.rework.review.re-execute.failed',
  // PD-31：fail-fast 跳过本身不是执行失败，但要作为 blocked 的最新原因
  // 展示给 CLI/Web（带可操作的下一步）。
  'node.resume-skipped-deterministic',
]);

// A repair or review rerun can fail and a later attempt still succeed; these
// events mark the node as recovered, so its earlier failure is not the reason.
const RECOVERED_EVENT_TYPES = new Set([
  'node.passed',
  'gate.passed-after-repair',
  'gate.passed-after-rework',
  'gate.rework.completed',
]);
const RECOVERABLE_FAILURE_TYPES = new Set([
  'gate.repair.failed',
  'gate.rework.review.re-execute.failed',
]);

function eventNodeId(payload: Record<string, unknown>): string | undefined {
  const id = payload.nodeId ?? payload.reviewNodeId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The newest recorded failure since the run last resumed, so a reason that a
 * resume already addressed is not shown again.
 */
export function findLatestRunFailure(
  events: readonly Pick<AuditEvent, 'type' | 'payload'>[],
): RunFailureReason | undefined {
  const recovered = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'run.resumed') return undefined;
    if (RECOVERED_EVENT_TYPES.has(event.type)) {
      const nodeId = eventNodeId(event.payload);
      if (nodeId) recovered.add(nodeId);
      continue;
    }
    if (!FAILURE_EVENT_TYPES.has(event.type)) continue;
    if (RECOVERABLE_FAILURE_TYPES.has(event.type)) {
      const nodeId = eventNodeId(event.payload);
      if (nodeId && recovered.has(nodeId)) continue;
    }
    // PD-31：fail-fast 事件携带 reason/hint，直接作为 blocked 原因输出。
    if (event.type === 'node.resume-skipped-deterministic') {
      const reason = event.payload.reason;
      const hint = event.payload.hint;
      if (typeof reason === 'string') {
        return {
          kind: 'deterministic-block',
          message: redactSecrets(reason).content,
          ...(typeof hint === 'string'
            ? { hint: redactSecrets(hint).content }
            : {}),
        };
      }
    }
    const diagnostic = event.payload.diagnostic as
      | { code?: unknown; message?: unknown; hint?: unknown }
      | undefined;
    if (diagnostic && typeof diagnostic.message === 'string') {
      return {
        message: diagnostic.message,
        ...(typeof diagnostic.code === 'string' ? { kind: diagnostic.code } : {}),
        ...(typeof diagnostic.hint === 'string' ? { hint: diagnostic.hint } : {}),
      };
    }
    if (typeof event.payload.error === 'string') {
      return { message: redactSecrets(event.payload.error).content };
    }
    return undefined;
  }
  return undefined;
}
