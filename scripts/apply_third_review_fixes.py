from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


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
# 1. Job runner: a timed-out stop relinquishes ownership. Fence the old local
#    executor before clearing its token/controller so same-worker restart cannot
#    leave a still-running zombie mutating workflow/worktree state.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/session/job-runner.ts",
    """  leaseTtlMs?: number;\n  workerId?: string;\n}\n""",
    """  leaseTtlMs?: number;\n  /** Test/embedding seam; production defaults to 5 seconds. */\n  stopSettleTimeoutMs?: number;\n  workerId?: string;\n}\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;\n  const workerId =\n""",
    """  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;\n  const stopSettleTimeoutMs =\n    deps.stopSettleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS;\n  const workerId =\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """        timer = setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS);\n""",
    """        timer = setTimeout(resolve, stopSettleTimeoutMs);\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """      if (timer) {\n        clearTimeout(timer);\n      }\n      for (const jobId of [...heartbeats.keys()]) {\n        clearHeartbeat(jobId);\n      }\n      controllers.clear();\n      executionTokens.clear();\n      pauseFlags.clear();\n""",
    """      if (timer) {\n        clearTimeout(timer);\n      }\n\n      // A stop that reaches the timeout is an ownership hand-off, not a\n      // promise that the old executor vanished. Abort every remaining local\n      // generation with the dedicated fencing reason before clearing maps.\n      // Otherwise start() may reclaim the same durable job with the same\n      // workerId while the old executor keeps mutating workflow/worktree state.\n      for (const [jobId, controller] of controllers) {\n        if (controller.signal.aborted) {\n          continue;\n        }\n        controller.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);\n        const current = await jobs.get(jobId);\n        const runId = current\n          ? await sessions.getRunIdBySessionId(current.sessionId)\n          : null;\n        if (runId) {\n          registry.killAll(runId, 'SIGKILL');\n        }\n      }\n      for (const jobId of [...heartbeats.keys()]) {\n        clearHeartbeat(jobId);\n      }\n      controllers.clear();\n      executionTokens.clear();\n      pauseFlags.clear();\n""",
)

# ---------------------------------------------------------------------------
# 2. Workflow engine: ownership-loss is a silent stand-down at every plan
#    boundary. It must never call the user-cancellation terminal writer.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/workflow/engine.ts",
    """import type { WorktreeManager } from '../runtime/worktree-manager.js';\nimport type { WorkflowInstance } from '../types/domain.js';\nimport { WorkflowTerminalError } from './errors.js';\n""",
    """import type { WorktreeManager } from '../runtime/worktree-manager.js';\nimport type { WorkflowInstance } from '../types/domain.js';\nimport {\n  isJobCancellationAbort,\n  isJobOwnershipLostAbort,\n} from '../session/job-runner.js';\nimport { WorkflowTerminalError } from './errors.js';\n""",
)

replace_once(
    "packages/core/src/workflow/engine.ts",
    """    getCheckedTransition: () => checkedTransitionNode,\n    getRunGateWithRepair: () => gateRunnerRef.runGateWithRepair,\n    agentEventSink: options.agentEventSink,\n""",
    """    getCheckedTransition: () => checkedTransitionNode,\n    getRunGateWithRepair: () => gateRunnerRef.runGateWithRepair,\n    getSignal: () => options.signal,\n    agentEventSink: options.agentEventSink,\n""",
)

old_boundary = """        // S5: node-boundary cancel/pause checks (before any node work).\n        if (options.signal?.aborted) {\n          await settleCancelled(runId, node.id);\n          return helpers.mustGetWorkflow(runId);\n        }\n        if (options.isPauseRequested?.()) {\n          return settlePaused(runId, node.id);\n        }\n"""
new_boundary = """        // Ownership loss fences this stale executor. It is not a user\n        // cancellation and must not write workflow terminal state.\n        if (isJobOwnershipLostAbort(options.signal)) {\n          return helpers.mustGetWorkflow(runId);\n        }\n        if (isJobCancellationAbort(options.signal)) {\n          await settleCancelled(runId, node.id);\n          return helpers.mustGetWorkflow(runId);\n        }\n        if (options.isPauseRequested?.()) {\n          return settlePaused(runId, node.id);\n        }\n"""
replace_once("packages/core/src/workflow/engine.ts", old_boundary, new_boundary)

replace_once(
    "packages/core/src/workflow/engine.ts",
    """        const dependencyMissing =\n          await nodeExecutor.hasMissingArtifactDependency(runId, node);\n        if (dependencyMissing) {\n""",
    """        const dependencyMissing =\n          await nodeExecutor.hasMissingArtifactDependency(runId, node);\n        // The dependency scan is asynchronous; ownership/cancel can land in\n        // that window. Re-check before any blocked-state write.\n        if (isJobOwnershipLostAbort(options.signal)) {\n          return helpers.mustGetWorkflow(runId);\n        }\n        if (isJobCancellationAbort(options.signal)) {\n          await settleCancelled(runId, node.id);\n          return helpers.mustGetWorkflow(runId);\n        }\n        if (dependencyMissing) {\n""",
)

replace_once(
    "packages/core/src/workflow/engine.ts",
    """    if (options.signal?.aborted) {\n      await settleCancelled(runId, null);\n      return helpers.mustGetWorkflow(runId);\n    }\n    if (options.isPauseRequested?.()) {\n""",
    """    if (isJobOwnershipLostAbort(options.signal)) {\n      return helpers.mustGetWorkflow(runId);\n    }\n    if (isJobCancellationAbort(options.signal)) {\n      await settleCancelled(runId, null);\n      return helpers.mustGetWorkflow(runId);\n    }\n    if (options.isPauseRequested?.()) {\n""",
)

# ---------------------------------------------------------------------------
# 3. Node executor: check the fencing signal around every success-path shared
#    state / branch-promotion boundary, not only in catch/finally paths.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    gateRunner,\n    getCheckedTransition,\n  } = deps;\n\n  async function hasMissingArtifactDependency(\n""",
    """    gateRunner,\n    getCheckedTransition,\n  } = deps;\n\n  const ownershipLost = (): boolean =>\n    isJobOwnershipLostAbort(deps.signal);\n\n  async function hasMissingArtifactDependency(\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    const checkedTransitionNode = getCheckedTransition();\n\n    const current = await repositories.getNode(node.id);\n""",
    """    const checkedTransitionNode = getCheckedTransition();\n\n    if (ownershipLost()) {\n      return false;\n    }\n\n    const current = await repositories.getNode(node.id);\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    const completedAgentRun = await helpers.hasCompletedAgentRun(\n      runId,\n      node.id,\n    );\n    if (\n""",
    """    const completedAgentRun = await helpers.hasCompletedAgentRun(\n      runId,\n      node.id,\n    );\n    if (ownershipLost()) {\n      return false;\n    }\n    if (\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """        return false;\n      }\n\n      await checkedTransitionNode(\n        runId,\n        node.id,\n        'awaiting-gate',\n""",
    """        return false;\n      }\n\n      if (ownershipLost()) {\n        return false;\n      }\n      await checkedTransitionNode(\n        runId,\n        node.id,\n        'awaiting-gate',\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    try {\n      for (const gate of configuredGates) {\n        const passed = await gateRunner.runGateWithRepair(runId, node, gate);\n        if (!passed) {\n          return false;\n        }\n      }\n""",
    """    try {\n      for (const gate of configuredGates) {\n        if (ownershipLost()) {\n          return false;\n        }\n        const passed = await gateRunner.runGateWithRepair(runId, node, gate);\n        if (!passed || ownershipLost()) {\n          return false;\n        }\n      }\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    try {\n      await helpers.recordQaValidationRef(runId, node);\n      await leaseService.finalizeExecutionLease(runId, node.id);\n""",
    """    try {\n      if (ownershipLost()) {\n        return false;\n      }\n      await helpers.recordQaValidationRef(runId, node);\n      if (ownershipLost()) {\n        return false;\n      }\n      await leaseService.finalizeExecutionLease(runId, node.id);\n      if (ownershipLost()) {\n        return false;\n      }\n""",
)

replace_once(
    "packages/core/src/workflow/node-executor.ts",
    """    await checkedTransitionNode(runId, node.id, 'passed', 'node.passed');\n""",
    """    if (ownershipLost()) {\n      return false;\n    }\n    await checkedTransitionNode(runId, node.id, 'passed', 'node.passed');\n""",
)

# ---------------------------------------------------------------------------
# 4. Gate repair: check fencing on successful gate/repair paths too, propagate
#    the signal to repair agents, and stand down before state/promote writes.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """    getCheckedTransition,\n    getReworkHandler,\n  } = deps;\n\n  async function runGate(\n""",
    """    getCheckedTransition,\n    getReworkHandler,\n  } = deps;\n\n  const ownershipLost = (): boolean =>\n    isJobOwnershipLostAbort(deps.getSignal?.());\n\n  async function runGate(\n""",
)

text = read("packages/core/src/workflow/gate-runner.ts")
text = text.replace(
    "isJobOwnershipLostAbort(deps.getSignal?.())",
    "ownershipLost()",
)
write("packages/core/src/workflow/gate-runner.ts", text)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """    const checkedTransitionNode = getCheckedTransition();\n    const reworkHandler = getReworkHandler();\n\n    if (!gateOpts?.forceRerun) {\n""",
    """    const checkedTransitionNode = getCheckedTransition();\n    const reworkHandler = getReworkHandler();\n\n    if (ownershipLost()) {\n      return false;\n    }\n\n    if (!gateOpts?.forceRerun) {\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """      if (\n        existingResult?.status === 'passed' ||\n        existingResult?.status === 'skipped'\n      ) {\n        await audit.append({\n""",
    """      if (\n        existingResult?.status === 'passed' ||\n        existingResult?.status === 'skipped'\n      ) {\n        if (ownershipLost()) {\n          return false;\n        }\n        await audit.append({\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """    let result = await runGate(runId, node.id, gate);\n    if (result.status === 'passed' || result.status === 'skipped') {\n""",
    """    let result = await runGate(runId, node.id, gate);\n    if (ownershipLost()) {\n      return false;\n    }\n    if (result.status === 'passed' || result.status === 'skipped') {\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """        await repositories.transitionNode(node.id, 'needs-revision');\n        await leaseService.finalizeExecutionLease(runId, node.id);\n        const repairNode = await gateEngine.createAutoFixRepairNode({\n""",
    """        await repositories.transitionNode(node.id, 'needs-revision');\n        if (ownershipLost()) {\n          return false;\n        }\n        await leaseService.finalizeExecutionLease(runId, node.id);\n        if (ownershipLost()) {\n          return false;\n        }\n        const repairNode = await gateEngine.createAutoFixRepairNode({\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """            const repairResult = await runAgentWithStepEvents(\n              adapter,\n              repairInput,\n""",
    """            const repairSignal = deps.getSignal?.();\n            if (repairSignal) {\n              repairInput.signal = repairSignal;\n            }\n            const repairResult = await runAgentWithStepEvents(\n              adapter,\n              repairInput,\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """            assertSuccessfulAgentRun(repairResult);\n            repairSucceeded = true;\n""",
    """            assertSuccessfulAgentRun(repairResult);\n            if (ownershipLost()) {\n              return false;\n            }\n            repairSucceeded = true;\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """        } catch (error) {\n          await repositories.transitionNode(\n            repairNode.id,\n            'interrupted',\n          );\n""",
    """        } catch (error) {\n          if (ownershipLost()) {\n            await audit.append({\n              runId,\n              type: 'gate.repair.failed',\n              payload: {\n                nodeId: node.id,\n                repairNodeId: repairNode.id,\n                gateResultId: result.id,\n                attempt: retryAttempt,\n                error: 'job ownership lost during repair agent (fenced)',\n              },\n            });\n            return false;\n          }\n          await repositories.transitionNode(\n            repairNode.id,\n            'interrupted',\n          );\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """        await repositories.transitionNode(repairNode.id, 'passed');\n        const repairLease = await leaseService.activeExecutionLease(\n""",
    """        if (ownershipLost()) {\n          return false;\n        }\n        await repositories.transitionNode(repairNode.id, 'passed');\n        const repairLease = await leaseService.activeExecutionLease(\n""",
)

# Every gate re-run must re-check the signal before inspecting the result.
text = read("packages/core/src/workflow/gate-runner.ts")
needle = "result = await runGate(runId, node.id, gate);\n"
replacement = (
    "result = await runGate(runId, node.id, gate);\n"
    "          if (ownershipLost()) {\n"
    "            return false;\n"
    "          }\n"
)
# Skip the initial `let result` occurrence (already patched); replace the two
# assignment occurrences in repair catch/success plus the rework assignment.
count = text.count(needle)
if count < 2:
    raise RuntimeError(f"gate-runner: expected >=2 gate rerun assignments, found {count}")
text = text.replace(needle, replacement)
write("packages/core/src/workflow/gate-runner.ts", text)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """    const shouldRework = isChangesRequested(\n      result.failureClassification,\n      gate.type,\n    );\n\n    if (shouldRework) {\n""",
    """    if (ownershipLost()) {\n      return false;\n    }\n    const shouldRework = isChangesRequested(\n      result.failureClassification,\n      gate.type,\n    );\n\n    if (shouldRework) {\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """        while (reworkAttempt < maxReworkAttempts && !reworkPassed) {\n          reworkAttempt++;\n          await audit.append({\n""",
    """        while (reworkAttempt < maxReworkAttempts && !reworkPassed) {\n          reworkAttempt++;\n          if (ownershipLost()) {\n            return false;\n          }\n          await audit.append({\n""",
)

replace_once(
    "packages/core/src/workflow/gate-runner.ts",
    """          await reworkHandler.attemptChangesRequestedRework(\n            runId,\n            node,\n            gate,\n            result,\n            targetNodeId,\n            reworkAttempt,\n          );\n\n          result = await runGate(runId, node.id, gate);\n""",
    """          await reworkHandler.attemptChangesRequestedRework(\n            runId,\n            node,\n            gate,\n            result,\n            targetNodeId,\n            reworkAttempt,\n          );\n          if (ownershipLost()) {\n            return false;\n          }\n\n          result = await runGate(runId, node.id, gate);\n""",
)

# ---------------------------------------------------------------------------
# 5. Changes-requested rework: thread the job signal and make every promote /
#    shared-state boundary ownership-aware. A fenced rework must leave its
#    worktree unpromoted for the new owner rather than force-moving run branch.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/workflow/rework.ts",
    """import { assertSuccessfulAgentRun } from './helpers.js';\nimport type { PromptBuilder } from './prompt-builder.js';\n""",
    """import { assertSuccessfulAgentRun } from './helpers.js';\nimport type { PromptBuilder } from './prompt-builder.js';\nimport { isJobOwnershipLostAbort } from '../session/job-runner.js';\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """  getCheckedTransition(): CheckedTransitionFn;\n  getRunGateWithRepair(): RunGateWithRepairFn;\n  /**\n""",
    """  getCheckedTransition(): CheckedTransitionFn;\n  getRunGateWithRepair(): RunGateWithRepairFn;\n  /** Current job signal, used to fence stale rework/review executions. */\n  getSignal?(): AbortSignal | undefined;\n  /**\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    getCheckedTransition,\n    getRunGateWithRepair,\n  } = deps;\n\n  async function resolveReviewTargetNode(\n""",
    """    getCheckedTransition,\n    getRunGateWithRepair,\n  } = deps;\n\n  const ownershipLost = (): boolean =>\n    isJobOwnershipLostAbort(deps.getSignal?.());\n\n  async function resolveReviewTargetNode(\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    const checkedTransitionNode = getCheckedTransition();\n    const runGateWithRepair = getRunGateWithRepair();\n\n    const targetNode = await repositories.getNode(targetNodeId);\n""",
    """    const checkedTransitionNode = getCheckedTransition();\n    const runGateWithRepair = getRunGateWithRepair();\n\n    if (ownershipLost()) {\n      return;\n    }\n    const targetNode = await repositories.getNode(targetNodeId);\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    await leaseService.finalizeExecutionLease(runId, reviewNode.id);\n\n    // --- Step 2: Create rework node reusing target's inputs/outputs/gates ---\n""",
    """    if (ownershipLost()) {\n      return;\n    }\n    await leaseService.finalizeExecutionLease(runId, reviewNode.id);\n    if (ownershipLost()) {\n      return;\n    }\n\n    // --- Step 2: Create rework node reusing target's inputs/outputs/gates ---\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """        const reworkResult = await runAgentWithStepEvents(\n          adapter,\n          reworkInput,\n""",
    """        const reworkSignal = deps.getSignal?.();\n        if (reworkSignal) {\n          reworkInput.signal = reworkSignal;\n        }\n        const reworkResult = await runAgentWithStepEvents(\n          adapter,\n          reworkInput,\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """        assertSuccessfulAgentRun(reworkResult);\n        reworkSucceeded = true;\n""",
    """        assertSuccessfulAgentRun(reworkResult);\n        if (ownershipLost()) {\n          return;\n        }\n        reworkSucceeded = true;\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """        if (!reworkSucceeded) {\n          await leaseService\n            .finalizeExecutionLease(runId, reworkNodeId)\n            .catch(() => {});\n        }\n""",
    """        if (!reworkSucceeded && !ownershipLost()) {\n          await leaseService\n            .finalizeExecutionLease(runId, reworkNodeId)\n            .catch(() => {});\n        }\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    } catch (error) {\n      await repositories.transitionNode(reworkNodeId, 'interrupted');\n      await audit.append({\n""",
    """    } catch (error) {\n      if (ownershipLost()) {\n        await audit.append({\n          runId,\n          type: 'gate.rework.failed',\n          payload: {\n            reviewNodeId: reviewNode.id,\n            targetNodeId,\n            reworkNodeId,\n            error: 'job ownership lost during rework agent (fenced)',\n          },\n        });\n        return;\n      }\n      await repositories.transitionNode(reworkNodeId, 'interrupted');\n      await audit.append({\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    // --- Step 4: Run target node's gates using targetNodeId ---\n""",
    """    if (ownershipLost()) {\n      return;\n    }\n\n    // --- Step 4: Run target node's gates using targetNodeId ---\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    for (const targetGate of configuredTargetGates) {\n      const gatePassed = await runGateWithRepair(\n""",
    """    for (const targetGate of configuredTargetGates) {\n      if (ownershipLost()) {\n        executionLeases.delete(targetNodeId);\n        return;\n      }\n      const gatePassed = await runGateWithRepair(\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """      if (!gatePassed) {\n        executionLeases.delete(targetNodeId);\n        return;\n      }\n""",
    """      if (!gatePassed || ownershipLost()) {\n        executionLeases.delete(targetNodeId);\n        return;\n      }\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    // --- Step 5: Finalize rework lease ---\n    try {\n      await leaseService.finalizeExecutionLease(runId, reworkNodeId);\n""",
    """    // --- Step 5: Finalize rework lease ---\n    if (ownershipLost()) {\n      return;\n    }\n    try {\n      await leaseService.finalizeExecutionLease(runId, reworkNodeId);\n      if (ownershipLost()) {\n        return;\n      }\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    } catch (error) {\n      await repositories.transitionNode(reworkNodeId, 'interrupted');\n      await audit.append({\n        runId,\n        type: 'gate.rework.lease.finalize.failed',\n""",
    """    } catch (error) {\n      if (ownershipLost()) {\n        return;\n      }\n      await repositories.transitionNode(reworkNodeId, 'interrupted');\n      await audit.append({\n        runId,\n        type: 'gate.rework.lease.finalize.failed',\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    await checkedTransitionNode(\n      runId,\n      reworkNodeId,\n      'passed',\n""",
    """    if (ownershipLost()) {\n      return;\n    }\n    await checkedTransitionNode(\n      runId,\n      reworkNodeId,\n      'passed',\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    // --- Step 6: Re-execute review node to produce fresh review artifact ---\n    await checkedTransitionNode(\n""",
    """    // --- Step 6: Re-execute review node to produce fresh review artifact ---\n    if (ownershipLost()) {\n      return;\n    }\n    await checkedTransitionNode(\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """      const reviewResult = await runAgentWithStepEvents(\n        adapter,\n        reviewInput,\n""",
    """      const reviewSignal = deps.getSignal?.();\n      if (reviewSignal) {\n        reviewInput.signal = reviewSignal;\n      }\n      const reviewResult = await runAgentWithStepEvents(\n        adapter,\n        reviewInput,\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """      assertSuccessfulAgentRun(reviewResult);\n      await repositories.markRoleRunCompleted({\n""",
    """      assertSuccessfulAgentRun(reviewResult);\n      if (ownershipLost()) {\n        return;\n      }\n      await repositories.markRoleRunCompleted({\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    } catch (error) {\n      await repositories.transitionNode(reviewNode.id, 'interrupted');\n      await audit.append({\n""",
    """    } catch (error) {\n      if (ownershipLost()) {\n        return;\n      }\n      await repositories.transitionNode(reviewNode.id, 'interrupted');\n      await audit.append({\n""",
)

replace_once(
    "packages/core/src/workflow/rework.ts",
    """    // --- Step 7: Put review node back to awaiting-gate ---\n    await repositories.transitionNode(reviewNode.id, 'awaiting-gate');\n\n    try {\n""",
    """    // --- Step 7: Put review node back to awaiting-gate ---\n    if (ownershipLost()) {\n      return;\n    }\n    await repositories.transitionNode(reviewNode.id, 'awaiting-gate');\n\n    try {\n""",
)

# ---------------------------------------------------------------------------
# 6. Regression locks.
# ---------------------------------------------------------------------------

write(
    "packages/core/__tests__/session/job-runner-stop-fencing.test.ts",
    r'''import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJobRepository,
  createJobRunner,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWriteQueue,
  JOB_ABORT_REASON_OWNERSHIP_LOST,
  migrateDatabase,
  openTekonDatabase,
  type JobExecutionContext,
  type JobExecutor,
  type JobStatus,
} from '../../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

class DeferredExecutor implements JobExecutor {
  readonly contexts: JobExecutionContext[] = [];
  private readonly releases: Array<
    (result: { status: JobStatus }) => void
  > = [];

  execute(ctx: JobExecutionContext): Promise<{ status: JobStatus }> {
    this.contexts.push(ctx);
    return new Promise((resolve) => this.releases.push(resolve));
  }

  release(index: number, status: JobStatus = 'done'): void {
    this.releases[index]?.({ status });
  }
}

const runners: Array<ReturnType<typeof createJobRunner>> = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    await runner.stop().catch(() => {});
  }
});

describe('job runner stop fencing', () => {
  it('aborts a timed-out generation before same-worker restart can reclaim it', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    const killSpy = vi.spyOn(registry, 'killAll');
    const executor = new DeferredExecutor();
    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor,
      workerId: 'worker_same',
      pollIntervalMs: 5,
      heartbeatMs: 30,
      leaseTtlMs: 10,
      stopSettleTimeoutMs: 20,
    });
    runners.push(runner);

    const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/tekon-stop-fence');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'stop fencing',
      profile: 'human-web',
      runId: 'run_stop_fence',
    });
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.contexts.length === 1);
    const oldContext = executor.contexts[0]!;

    await runner.stop();

    expect(oldContext.signal.aborted).toBe(true);
    expect(oldContext.signal.reason).toBe(JOB_ABORT_REASON_OWNERSHIP_LOST);
    expect(killSpy).toHaveBeenCalledWith('run_stop_fence', 'SIGKILL');

    // A late result from the timed-out generation is token-fenced.
    executor.release(0, 'done');
    await sleep(30);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'running',
      owner: 'worker_same',
    });

    // Make the lease stale and restart the SAME runner/worker. The job is
    // reclaimed as generation 2; generation 1 can no longer settle it.
    await jobs.updateJob(job.id, { lease: '2020-01-01T00:00:00.000Z' });
    runner.start();
    await waitFor(() => executor.contexts.length === 2);
    expect(executor.contexts[1]!.signal.aborted).toBe(false);

    executor.release(1, 'done');
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
    db.close();
  });
});
''',
)

write(
    "packages/core/__tests__/workflow/ownership-fencing.e2e.test.ts",
    r'''import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  JOB_ABORT_REASON_OWNERSHIP_LOST,
  migrateDatabase,
  openTekonDatabase,
  type GateEngine,
} from '../../src/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workflow ownership fencing — success and boundary paths', () => {
  it('stands down at the next plan boundary instead of converting ownership loss to cancellation', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-boundary-fence-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();
    const fence = new AbortController();
    let activeRunId = '';
    let checkpointed = false;

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      signal: fence.signal,
      adapter: {
        async runAgent(input) {
          activeRunId = input.runContext.runId;
          return mock.runAgent(input);
        },
      },
      onNodeCheckpoint: async () => {
        if (checkpointed) return;
        checkpointed = true;
        await repositories.updateWorkflowInstanceStatus(activeRunId, 'passed', null);
        fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
      },
    });

    const result = await engine.startRun({
      demandText: 'ownership loss at node boundary',
      mode: 'template',
      workflowSpec: singleNodeWorkflow([]),
    });

    expect(checkpointed).toBe(true);
    expect(result.workflow.status).toBe('passed');
    expect((await repositories.getWorkflowInstance(result.runId))?.status).toBe(
      'passed',
    );
    db.close();
  });

  it('does not mark a node passed when ownership is lost with a successful gate result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-passed-gate-fence-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const fence = new AbortController();
    let fenced = false;

    const gateEngine: GateEngine = {
      async runGate(input) {
        if (!fenced) {
          fenced = true;
          await repositories.updateWorkflowInstanceStatus(input.runId, 'passed', null);
          fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
        }
        return repositories.recordGateResult({
          id: `gate_${input.nodeId}_${Date.now()}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: 'passed',
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
      async createAutoFixRepairNode(input) {
        return repositories.createNode({
          id: `repair_${input.failedGateResult.id}`,
          runId: input.failedGateResult.runId,
          role: input.fixerRole,
          status: 'pending',
          gates: [],
          dependencies: [input.failedGateResult.nodeId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };

    const result = await createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: createMockAgentAdapter(),
      gateEngine,
      signal: fence.signal,
    }).startRun({
      demandText: 'successful gate must still observe fencing',
      mode: 'template',
      workflowSpec: singleNodeWorkflow([
        {
          type: 'build' as const,
          requiresHumanApproval: false,
          maxRetries: 0,
          retryPolicy: retryPolicy(0),
        },
      ]),
    });

    expect(fenced).toBe(true);
    expect(result.workflow.status).toBe('passed');
    const [node] = await repositories.listNodes(result.runId);
    expect(node?.status).toBe('awaiting-gate');
    db.close();
  });

  it('does not promote a fenced changes-requested rework worktree', async () => {
    const repoPath = createGitRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const fence = new AbortController();
    let reviewCalls = 0;
    let fencedDuringRework = false;

    const gateEngine: GateEngine = {
      async runGate(input) {
        let status: 'passed' | 'failed' = 'passed';
        let failureClassification: string | null = null;
        if (input.gate.type === 'independent-review') {
          reviewCalls += 1;
          if (reviewCalls === 1) {
            status = 'failed';
            failureClassification = 'changes-requested';
          }
        }
        return repositories.recordGateResult({
          id: `gate_${input.nodeId}_${input.gate.type}_${Date.now()}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status,
          failureClassification,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
      async createAutoFixRepairNode(input) {
        return repositories.createNode({
          id: `repair_${input.failedGateResult.id}`,
          runId: input.failedGateResult.runId,
          role: input.fixerRole,
          status: 'pending',
          gates: [],
          dependencies: [input.failedGateResult.nodeId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };

    const result = await createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      gateEngine,
      signal: fence.signal,
      worktreeManager: createWorktreeManager({ repositories, gateway }),
      adapter: {
        async runAgent(input) {
          if (input.runContext.nodeId.endsWith('_rd-node')) {
            writeFileSync(
              join(input.runContext.repoPath, 'feature.txt'),
              'implemented\n',
              'utf8',
            );
          }
          if (input.runContext.nodeId.includes('_rework_')) {
            fencedDuringRework = true;
            writeFileSync(
              join(input.runContext.repoPath, 'feature.txt'),
              'stale-zombie\n',
              'utf8',
            );
            await repositories.updateWorkflowInstanceStatus(
              input.runContext.runId,
              'passed',
              null,
            );
            fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
            throw new Error('fenced during rework');
          }
          return mock.runAgent(input);
        },
      },
    }).startRun({
      demandText: 'fenced rework must not move delivery branch',
      mode: 'template',
      workflowSpec: reworkWorkflow(),
    });

    expect(fencedDuringRework).toBe(true);
    expect(result.workflow.status).toBe('passed');
    const reworkNode = (await repositories.listNodes(result.runId)).find((node) =>
      node.id.includes('_rework_'),
    );
    expect(reworkNode?.status).toBe('running');
    const reworkLeases = (await repositories.listWorktreeLeases(result.runId)).filter(
      (lease) => lease.nodeId.includes('_rework_'),
    );
    expect(reworkLeases).toHaveLength(1);
    expect(reworkLeases[0]?.releasedAt).toBeUndefined();
    expect(
      execFileSync(
        'git',
        ['show', `tekon-delivery/${result.runId}:feature.txt`],
        { cwd: repoPath, encoding: 'utf8' },
      ),
    ).toBe('implemented\n');
    db.close();
  });
});

function retryPolicy(maxRetries: number) {
  return {
    maxRetries,
    maxAttempts: maxRetries + 1,
    backoffMs: 0,
    strategy: 'fixed' as const,
    onExhausted: 'block' as const,
  };
}

function singleNodeWorkflow(gates: Array<Record<string, unknown>>) {
  return {
    id: 'ownership-fence-single',
    name: 'Ownership Fence Single',
    version: 1,
    retryPolicy: retryPolicy(0),
    phases: [
      {
        id: 'work',
        name: 'Work',
        dependsOn: [],
        parallel: false,
        nodes: [
          {
            id: 'rd-node',
            role: 'rd' as const,
            inputs: [],
            outputs: [],
            gates,
            dependsOn: [],
          },
        ],
      },
    ],
  } as never;
}

function reworkWorkflow() {
  return {
    id: 'ownership-fence-rework',
    name: 'Ownership Fence Rework',
    version: 1,
    retryPolicy: retryPolicy(1),
    phases: [
      {
        id: 'implementation',
        name: 'Implementation',
        dependsOn: [],
        parallel: false,
        nodes: [
          {
            id: 'rd-node',
            role: 'rd' as const,
            inputs: [],
            outputs: [{ id: 'code', type: 'code-changes' as const }],
            gates: [
              {
                type: 'build' as const,
                requiresHumanApproval: false,
                maxRetries: 0,
                retryPolicy: retryPolicy(0),
              },
            ],
            dependsOn: [],
          },
        ],
      },
      {
        id: 'review',
        name: 'Review',
        dependsOn: ['implementation'],
        parallel: false,
        nodes: [
          {
            id: 'reviewer-node',
            role: 'reviewer' as const,
            inputs: [
              {
                id: 'code',
                type: 'code-changes' as const,
                fromNodeId: 'rd-node',
              },
            ],
            outputs: [{ id: 'review', type: 'code-review' as const }],
            gates: [
              {
                type: 'independent-review' as const,
                requiresHumanApproval: false,
                maxRetries: 1,
                retryPolicy: retryPolicy(1),
              },
            ],
            dependsOn: ['rd-node'],
          },
        ],
      },
    ],
  } as never;
}

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rework-fence-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
''',
)

# The implementation annotation overclaimed what its maxRetries=1 test drove.
# Preserve it as historical context, but correct the evidence statement.
report = read("docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md")
pattern = re.compile(r"^- \*\*S9（本轮已补）\*\*：.*$", re.M)
replacement = (
    "- **S9（第三轮复核更正）**：原新增用例在 `maxRetries=1` 且于第二次 gate 调用触发 fence，"
    "实际只能证明 repair gate 重跑后到 exhausted settle 之前会 stand down，不能单独证明下一轮 "
    "loop-top (b) 被驱动；第三轮已调整测试说明，并新增 plan-boundary、successful-gate、"
    "changes-requested rework 与 same-worker restart 回归。M1/M2 的 throw 变体、以及检查与共享写入/"
    "`git branch -f` 之间的原子 fencing token 仍是后续架构硬化项。"
)
report, count = pattern.subn(replacement, report, count=1)
if count != 1:
    raise RuntimeError(f"review report: expected one S9 annotation, found {count}")
write("docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md", report)

# Make the existing test name/comment honest about the path it actually drives.
path = "packages/core/__tests__/workflow/engine-gate-repair.e2e.test.ts"
text = read(path)
text = text.replace(
    "a fence during gate repair does not revert a terminal run via the repair/exhausted path (M3 (b)/(c))",
    "a fence after a repair gate rerun stands down before exhausted state writes",
)
text = text.replace(
    "the repair-loop-top fence check\n    // (gate-runner.ts) and the exhausted-settle fence check must prevent a",
    "the post-repair gate-result fence check and exhausted-settle fence must prevent a",
)
text = text.replace(
    "this drives (b)/(c) by keeping an autoFix gate failing so the repair loop\n    // runs, then fencing during it.",
    "this keeps an autoFix gate failing, then fences on its post-repair rerun.",
)
text = text.replace(
    "The\n    // repair-loop-top (b) / exhausted-settle (c) guards must stand down without\n    // reverting `passed`.",
    "The post-rerun/exhausted guards must stand down without reverting `passed`.",
)
text = text.replace(
    "executor's repair-loop / exhausted-settle bookkeeping.",
    "executor's post-repair / exhausted-settle bookkeeping.",
)
write(path, text)

print('Applied third-review ownership fencing fixes and regression locks.')
