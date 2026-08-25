from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}")
    write(path, text.replace(old, new, 1))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}")
    write(path, updated)


# ---------------------------------------------------------------------------
# Job abort semantics and same-worker execution-generation fencing.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/session/job-runner.ts",
    """import type { SubprocessRegistry } from './subprocess-registry.js';\n\n/**\n * Thrown when a job operation detects that the job is no longer owned by this\n""",
    """import type { SubprocessRegistry } from './subprocess-registry.js';\n\n/** Abort reason used only when a runner loses the durable job lease/owner. */\nexport const JOB_ABORT_REASON_OWNERSHIP_LOST =\n  'tekon:job-ownership-lost' as const;\n\n/** True when an AbortSignal fences a stale executor rather than user cancel. */\nexport function isJobOwnershipLostAbort(\n  signal: AbortSignal | undefined,\n): boolean {\n  return Boolean(\n    signal?.aborted && signal.reason === JOB_ABORT_REASON_OWNERSHIP_LOST,\n  );\n}\n\n/** User cancellation excludes the internal ownership-loss fencing signal. */\nexport function isJobCancellationAbort(\n  signal: AbortSignal | undefined,\n): boolean {\n  return Boolean(signal?.aborted && !isJobOwnershipLostAbort(signal));\n}\n\n/**\n * Thrown when a job operation detects that the job is no longer owned by this\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """  const controllers = new Map<string, AbortController>();\n  const pauseFlags = new Set<string>();\n""",
    """  const controllers = new Map<string, AbortController>();\n  // A durable owner string is insufficient when the same worker reclaims a\n  // stale job. The process-local token fences the older executor generation.\n  const executionTokens = new Map<string, symbol>();\n  const pauseFlags = new Set<string>();\n""",
)

regex_replace_once(
    "packages/core/src/session/job-runner.ts",
    r"  async function settle\(\n    job: Job,\n    result: \{ status: JobStatus; summary\?: string \} \| undefined,\n    failure: unknown,\n  \): Promise<void> \{.*?\n  \}\n\n  async function runJob\(job: Job\): Promise<void> \{.*?\n  \}\n\n  function spawnJob",
    """  async function settle(\n    job: Job,\n    result: { status: JobStatus; summary?: string } | undefined,\n    failure: unknown,\n    executionToken: symbol,\n  ): Promise<void> {\n    // Same-worker stale recovery can reclaim the same job id with the same\n    // durable owner. Token equality is therefore checked before touching the\n    // current controller, heartbeat or terminal row.\n    if (executionTokens.get(job.id) !== executionToken) {\n      return;\n    }\n\n    clearHeartbeat(job.id);\n    const controller = controllers.get(job.id);\n\n    const current = await jobs.get(job.id);\n    if (!current || current.owner !== workerId) {\n      controllers.delete(job.id);\n      executionTokens.delete(job.id);\n      pauseFlags.delete(job.id);\n      return;\n    }\n\n    const cancelRequested =\n      current.status === 'cancelling' ||\n      current.abortState === 'requested' ||\n      current.abortState === 'propagated' ||\n      isJobCancellationAbort(controller?.signal);\n    const terminalStatus: JobStatus = cancelRequested\n      ? 'cancelled'\n      : failure\n        ? 'failed'\n        : result && SETTLEABLE_STATUSES.includes(result.status)\n          ? result.status\n          : 'failed';\n\n    await jobs.updateJob(job.id, {\n      status: terminalStatus,\n      abortState: 'stopped',\n    });\n    controllers.delete(job.id);\n    executionTokens.delete(job.id);\n    pauseFlags.delete(job.id);\n    await notifySettled(\n      current.sessionId,\n      job.id,\n      current.kind,\n      terminalStatus,\n    );\n  }\n\n  async function runJob(job: Job): Promise<void> {\n    const executionToken = Symbol(job.id);\n    const controller = new AbortController();\n    executionTokens.set(job.id, executionToken);\n    controllers.set(job.id, controller);\n\n    const heartbeat = setInterval(() => {\n      if (executionTokens.get(job.id) !== executionToken) {\n        clearInterval(heartbeat);\n        return;\n      }\n      void jobs.updateJob(job.id, { lease: nowIso() }).catch(() => {});\n    }, heartbeatMs);\n    if (typeof heartbeat.unref === 'function') {\n      heartbeat.unref();\n    }\n    heartbeats.set(job.id, heartbeat);\n\n    const ctx: JobExecutionContext = {\n      job,\n      signal: controller.signal,\n      pauseRequested: () =>\n        executionTokens.get(job.id) === executionToken &&\n        pauseFlags.has(job.id),\n      checkpoint: (nodeId) => {\n        if (executionTokens.get(job.id) !== executionToken) {\n          throw new JobFencingError(job.id, 'execution generation changed');\n        }\n        return writeCheckpoint(job.id, `node:${nodeId}`);\n      },\n    };\n\n    let result: { status: JobStatus; summary?: string } | undefined;\n    let failure: unknown;\n    try {\n      result = await executor.execute(ctx);\n    } catch (error) {\n      failure = error;\n    }\n    await settle(job, result, failure, executionToken);\n  }\n\n  function spawnJob""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """        if (!controller.signal.aborted) {\n          controller.abort();\n          const runId = current\n            ? await sessions.getRunIdBySessionId(current.sessionId)\n            : null;\n          if (runId) registry.killAll(runId, 'SIGKILL');\n        }\n        pauseFlags.delete(jobId);\n        continue;\n""",
    """        if (!controller.signal.aborted) {\n          controller.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);\n          const runId = current\n            ? await sessions.getRunIdBySessionId(current.sessionId)\n            : null;\n          if (runId) registry.killAll(runId, 'SIGKILL');\n        }\n        // Invalidate this local generation immediately. A same-worker reclaim\n        // may install a new controller/token for the same durable job id.\n        executionTokens.delete(jobId);\n        clearHeartbeat(jobId);\n        controllers.delete(jobId);\n        pauseFlags.delete(jobId);\n        continue;\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """      controllers.clear();\n      pauseFlags.clear();\n""",
    """      controllers.clear();\n      executionTokens.clear();\n      pauseFlags.clear();\n""",
)

# ---------------------------------------------------------------------------
# Workflow/node execution must not interpret lease loss as user cancellation.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/session/workflow-job-executor.ts",
    """import type { JobExecutionContext, JobExecutor } from './job-runner.js';\n""",
    """import {\n  isJobCancellationAbort,\n  isJobOwnershipLostAbort,\n  type JobExecutionContext,\n  type JobExecutor,\n} from './job-runner.js';\n""",
)

replace_once(
    "packages/core/src/session/workflow-job-executor.ts",
    """      } catch (error) {\n        if (ctx.signal.aborted) {\n""",
    """      } catch (error) {\n        // Lease/owner loss fences a stale executor. It must not write workflow\n        // or session terminal state; the new owner is authoritative.\n        if (isJobOwnershipLostAbort(ctx.signal)) {\n          return { status: 'failed' as JobStatus };\n        }\n        if (isJobCancellationAbort(ctx.signal)) {\n""",
)

replace_once(
    "packages/core/src/session/workflow-job-executor.ts",
    """    // Aborted mid-flight: engine returned a cancelled/paused workflow because\n    // it hit the signal at a node boundary.\n    if (ctx.signal.aborted || workflow.status === 'cancelled') {\n""",
    """    // Ownership loss is a silent fencing outcome for this stale executor.\n    // The current owner will emit the authoritative lifecycle events.\n    if (isJobOwnershipLostAbort(ctx.signal)) {\n      return { status: 'failed' };\n    }\n\n    // User cancellation remains authoritative over an engine result.\n    if (isJobCancellationAbort(ctx.signal) || workflow.status === 'cancelled') {\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """import { writeWorkflowTerminal } from './state-machine.js';\n""",
    """import { writeWorkflowTerminal } from './state-machine.js';\nimport { isJobCancellationAbort } from '../session/job-runner.js';\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """        if (deps.signal?.aborted) {\n          // S5: cancel arrived before the agent started — short-circuit\n          // without invoking the adapter.\n          await repositories.markRoleRunInterrupted({\n            roleRunId,\n            interruptedAt: new Date().toISOString(),\n          });\n          await repositories.transitionNode(node.id, 'interrupted');\n          await writeWorkflowTerminal(\n            repositories,\n            runId,\n            'cancelled',\n            node.id,\n          );\n          await leaseService\n            .finalizeExecutionLease(runId, node.id)\n            .catch(() => {});\n          await audit.append({\n            runId,\n            type: 'node.interrupted',\n            payload: { nodeId: node.id, error: 'aborted before agent start' },\n          });\n          return false;\n        }\n""",
    """        if (deps.signal?.aborted) {\n          await repositories.markRoleRunInterrupted({\n            roleRunId,\n            interruptedAt: new Date().toISOString(),\n          });\n          await repositories.transitionNode(node.id, 'interrupted');\n          const cancelled = isJobCancellationAbort(deps.signal);\n          if (cancelled) {\n            await writeWorkflowTerminal(\n              repositories,\n              runId,\n              'cancelled',\n              node.id,\n            );\n          } else {\n            await repositories.updateWorkflowInstanceStatus(\n              runId,\n              'interrupted',\n              node.id,\n            );\n          }\n          await leaseService\n            .finalizeExecutionLease(runId, node.id)\n            .catch(() => {});\n          await audit.append({\n            runId,\n            type: 'node.interrupted',\n            payload: {\n              nodeId: node.id,\n              error: cancelled\n                ? 'cancelled before agent start'\n                : 'job ownership lost before agent start',\n            },\n          });\n          return false;\n        }\n""",
)

text = read("packages/core/src/workflow/node-executor.ts")
remaining = text.count("if (deps.signal?.aborted) {")
if remaining != 2:
    raise RuntimeError(
        f"node-executor: expected two remaining abort branches, found {remaining}",
    )
write(
    "packages/core/src/workflow/node-executor.ts",
    text.replace(
        "if (deps.signal?.aborted) {",
        "if (isJobCancellationAbort(deps.signal)) {",
    ),
)

# ---------------------------------------------------------------------------
# Phase-1 composition test mirrors production abort reason handling.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/__tests__/phase1/session-job-e2e.test.ts",
    """  isWorkflowTerminalError,\n""",
    """  isJobCancellationAbort,\n  isJobOwnershipLostAbort,\n  isWorkflowTerminalError,\n""",
)

replace_once(
    "packages/core/__tests__/phase1/session-job-e2e.test.ts",
    """    workflow: WorkflowInstance,\n    aborted: boolean,\n  ): Promise<{ status: JobStatus }> => {\n    if (aborted || workflow.status === 'cancelled') {\n""",
    """    workflow: WorkflowInstance,\n    signal: AbortSignal,\n  ): Promise<{ status: JobStatus }> => {\n    if (isJobOwnershipLostAbort(signal)) {\n      return { status: 'failed' };\n    }\n    if (isJobCancellationAbort(signal) || workflow.status === 'cancelled') {\n""",
)

replace_once(
    "packages/core/__tests__/phase1/session-job-e2e.test.ts",
    """          workflow,\n          ctx.signal.aborted,\n        );\n      } catch (error) {\n        if (ctx.signal.aborted) {\n""",
    """          workflow,\n          ctx.signal,\n        );\n      } catch (error) {\n        if (isJobOwnershipLostAbort(ctx.signal)) {\n          return { status: 'failed' };\n        }\n        if (isJobCancellationAbort(ctx.signal)) {\n""",
)

# Update the review's fixed-item detail to reflect the stronger fence.
replace_once(
    "docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md",
    """- owner 变化时本地 zombie executor 被 fence；\n- 增加双 Runner 测试。\n""",
    """- owner 变化时使用独立 abort reason，避免误判成用户取消；\n- 同一 worker 重领同一 job 时使用 execution-generation token fence zombie；\n- 增加双 Runner 与 crash-resume 回归验证。\n""",
)

print('Applied ownership-loss abort semantics and execution-generation fencing.')
