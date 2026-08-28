import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentRunInput,
  AgentRunResult,
} from './agent-adapter.js';
import type { Role } from '../types/domain.js';
import { redactSecrets } from '../security/secrets.js';

/**
 * Minimal event sink for agent-loop step events (phase 2 S3). The dual-write
 * bridge's `recordFromRun` satisfies this structurally, so the web executor
 * wires the bridge directly; CLI passes nothing (no sink → no events). The sink
 * MUST be best-effort internally (never throw into the caller) — the bridge's
 * recordFromRun wraps appendEvent AND bus.publish in try/catch. A sink that can
 * throw would break C1 (governance zero-regression), so callers must only pass
 * best-effort sinks.
 */
export interface AgentEventSink {
  recordFromRun(input: {
    runId: string;
    type: string;
    payload?: Record<string, unknown>;
    modelVisible?: boolean;
    correlationId?: string | null;
  }): Promise<void>;
}

export interface StepEventMeta {
  runId: string;
  nodeId: string;
  role: Role;
  /** Short, redaction-safe summary of the prompt (already truncated upstream). */
  promptSummary?: string;
}

/** Truncate + collapse a string for a step-event payload field. */
function summarize(text: string | undefined, max = 500): string | undefined {
  if (!text) return undefined;
  const oneLine = redactSecrets(text.replace(/\s+/g, ' ').trim()).content;
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Single owner of the agent-loop step-event sequence (phase 2 S3, design D1
 * option C). Wraps ONE `adapter.runAgent()` call and emits, in order:
 *   step/start → (tool/call → tool/result → assistant/message | agent/error) → step/end
 * Called by node-executor (main + rework + review re-run) and by the legacy
 * AgentDriver, so the sequence semantics live in exactly one place.
 *
 * Three terminal paths (design M1), checked in this order so a cancelled run
 * (exitCode=null) is never misclassified as a failure:
 *   - cancel  (result.cancelled || signal.aborted): emit ONLY step/end{cancelled};
 *              NO agent/error (preserves phase-1 MF1 single-emission for cancel).
 *   - failure (assertSuccessful throws on timedOut/exitCode≠0): agent/error + step/end{failed}.
 *   - throw   (adapter throws): agent/error + step/end{failed}, then rethrow.
 *
 * Events flow through the sink (best-effort); this function never lets an event
 * emission failure escape into the caller's control flow (C1). The adapter's
 * own result/throw is returned/rethrown unchanged so existing bookkeeping
 * (role_run, lease, interrupted) is untouched.
 */
export async function runAgentWithStepEvents(
  adapter: AgentAdapter,
  input: AgentRunInput,
  meta: StepEventMeta,
  sink?: AgentEventSink,
): Promise<AgentRunResult> {
  const stepId = `step_${randomUUID()}`;
  const base = { runId: meta.runId, correlationId: stepId };

  // Emit helper: swallow any sink error so event emission can never break the
  // agent run or governance path (C1). The sink itself is also best-effort;
  // this is defense-in-depth for a mis-supplied sink.
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    modelVisible = false,
  ): Promise<void> => {
    if (!sink) return;
    try {
      await sink.recordFromRun({ ...base, type, payload, modelVisible });
    } catch {
      // best-effort; never propagate.
    }
  };

  const startedAt = Date.now();
  await emit('step/start', {
    stepId,
    nodeId: meta.nodeId,
    role: meta.role,
    promptSummary: summarize(meta.promptSummary),
  });

  let result: AgentRunResult;
  try {
    result = await adapter.runAgent(input);
  } catch (error) {
    // Adapter threw (e.g. subprocess crash): surface an error event, then
    // rethrow so node-executor's existing catch handles interrupted bookkeeping.
    await emit('agent/error', {
      stepId,
      nodeId: meta.nodeId,
      role: meta.role,
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
      ).content,
    });
    await emit('step/end', {
      stepId,
      nodeId: meta.nodeId,
      status: 'failed',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  // Cancel path FIRST (design M1): a cancelled run has exitCode=null, which
  // would trip the failure check below. No agent/error on cancel (MF1).
  if (result.cancelled || input.signal?.aborted) {
    await emit('step/end', {
      stepId,
      nodeId: meta.nodeId,
      status: 'cancelled',
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  // Failure path: timed out or non-zero exit → agent/error + step/end{failed}.
  if (result.timedOut || (result.exitCode != null && result.exitCode !== 0)) {
    await emit('agent/error', {
      stepId,
      nodeId: meta.nodeId,
      role: meta.role,
      exitCode: result.exitCode,
      timedOut: result.timedOut ?? false,
    });
    await emit('step/end', {
      stepId,
      nodeId: meta.nodeId,
      status: 'failed',
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  // Success path: node-level tool summary plus the provider's final
  // assistant prose when it exposes a documented boundary (currently DSH
  // headless stdout). Other providers remain explicitly synthesized.
  const artifactRefs = (result.artifacts ?? []).map((a) => ({
    type: a.type,
    path: a.path,
  }));
  const assistantText = result.assistantText?.trim();
  const syntheticText = `[${meta.role}] completed: ${artifactRefs.length} artifact(s), exit ${result.exitCode ?? 'n/a'}.`;
  await emit(
    'tool/call',
    {
      stepId,
      nodeId: meta.nodeId,
      role: meta.role,
      provider: result.provider,
      name: result.provider,
      summaryLevel: 'node',
    },
    false,
  );
  await emit(
    'tool/result',
    {
      stepId,
      nodeId: meta.nodeId,
      provider: result.provider,
      name: result.provider,
      exitCode: result.exitCode,
      outputFiles: result.outputFiles,
      artifacts: artifactRefs,
      summary: `${result.outputFiles.length} output file(s), ${artifactRefs.length} artifact(s)`,
      summaryLevel: 'node',
    },
    true,
  );
  await emit(
    'assistant/message',
    {
      stepId,
      nodeId: meta.nodeId,
      role: meta.role,
      text: assistantText ?? syntheticText,
      synthetic: !assistantText,
      artifacts: artifactRefs,
      tokenUsage: result.tokenUsage,
    },
    true,
  );
  await emit('step/end', {
    stepId,
    nodeId: meta.nodeId,
    status: 'passed',
    durationMs: Date.now() - startedAt,
  });
  return result;
}
