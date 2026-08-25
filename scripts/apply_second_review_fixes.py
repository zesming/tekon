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


def insert_before_last(path: str, marker: str, block: str) -> None:
    text = read(path)
    index = text.rfind(marker)
    if index < 0:
        raise RuntimeError(f"{path}: final marker not found")
    write(path, text[:index] + block + text[index:])


# ---------------------------------------------------------------------------
# 1. Durable job control: relay cross-process pause/cancel to the owning runner,
#    fence cancellation at settle, and prevent overlapping poll ticks.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/session/job-runner.ts",
    """  let pollTimer: NodeJS.Timeout | null = null;\n  let stopped = true;\n""",
    """  let pollTimer: NodeJS.Timeout | null = null;\n  let stopped = true;\n  let pollInFlight = false;\n""",
)

regex_replace_once(
    "packages/core/src/session/job-runner.ts",
    r"  async function settle\(\n    job: Job,\n    result: \{ status: JobStatus; summary\?: string \} \| undefined,\n    failure: unknown,\n  \): Promise<void> \{.*?\n  \}\n\n  async function runJob",
    """  async function settle(\n    job: Job,\n    result: { status: JobStatus; summary?: string } | undefined,\n    failure: unknown,\n  ): Promise<void> {\n    clearHeartbeat(job.id);\n    const controller = controllers.get(job.id);\n\n    // Re-read and fence on ownership before writing a terminal state. A zombie\n    // executor whose lease was reclaimed must not flip a job owned elsewhere.\n    const current = await jobs.get(job.id);\n    if (!current || current.owner !== workerId) {\n      controllers.delete(job.id);\n      pauseFlags.delete(job.id);\n      return;\n    }\n\n    // A cancellation persisted by another process is authoritative even when\n    // the executor races to return `done`. Without this fence a web-owned job\n    // can overwrite `cancelling` with `done` before its process-local observer\n    // notices the control request.\n    const cancelRequested =\n      current.status === 'cancelling' ||\n      current.abortState === 'requested' ||\n      current.abortState === 'propagated' ||\n      controller?.signal.aborted === true;\n    const terminalStatus: JobStatus = cancelRequested\n      ? 'cancelled'\n      : failure\n        ? 'failed'\n        : result && SETTLEABLE_STATUSES.includes(result.status)\n          ? result.status\n          : 'failed';\n\n    await jobs.updateJob(job.id, {\n      status: terminalStatus,\n      abortState: 'stopped',\n    });\n    controllers.delete(job.id);\n    pauseFlags.delete(job.id);\n    await notifySettled(\n      current.sessionId,\n      job.id,\n      current.kind,\n      terminalStatus,\n    );\n  }\n\n  async function runJob""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """  async function poll(): Promise<void> {\n    if (stopped) {\n      return;\n    }\n    const job = await jobs.claimNext(workerId);\n    if (job) {\n      spawnJob(job);\n    }\n  }\n""",
    """  async function syncOwnedControls(): Promise<void> {\n    for (const [jobId, controller] of controllers) {\n      const current = await jobs.get(jobId);\n      if (!current || current.owner !== workerId) {\n        // Ownership changed: fence the local execution and kill only processes\n        // registered in this process. The new owner will continue from durable\n        // state; the zombie must stop touching the workspace.\n        if (!controller.signal.aborted) {\n          controller.abort();\n          const runId = current\n            ? await sessions.getRunIdBySessionId(current.sessionId)\n            : null;\n          if (runId) registry.killAll(runId, 'SIGKILL');\n        }\n        pauseFlags.delete(jobId);\n        continue;\n      }\n\n      if (current.status === 'paused') {\n        pauseFlags.add(jobId);\n      }\n\n      const cancelRequested =\n        current.status === 'cancelling' ||\n        current.abortState === 'requested' ||\n        current.abortState === 'propagated';\n      if (!cancelRequested) continue;\n\n      if (!controller.signal.aborted) {\n        controller.abort();\n        const runId = await sessions.getRunIdBySessionId(current.sessionId);\n        if (runId) registry.killAll(runId, 'SIGKILL');\n      }\n      if (current.abortState !== 'propagated') {\n        await jobs.updateJob(jobId, { abortState: 'propagated' });\n      }\n    }\n  }\n\n  async function poll(): Promise<void> {\n    if (stopped || pollInFlight) {\n      return;\n    }\n    pollInFlight = true;\n    try {\n      // Process-local AbortControllers and registries cannot be mutated by a\n      // second CLI/Web process. Observe the durable job row on every owner poll\n      // and relay foreign pause/cancel requests into this process first.\n      await syncOwnedControls();\n      const job = await jobs.claimNext(workerId);\n      if (job) {\n        spawnJob(job);\n      }\n    } finally {\n      pollInFlight = false;\n    }\n  }\n""",
)

replace_once(
    "packages/core/src/session/job-runner.ts",
    """      await jobs.updateJob(jobId, {\n        status: 'cancelling',\n        abortState: 'requested',\n      });\n      controllers.get(jobId)?.abort();\n      const runId = await sessions.getRunIdBySessionId(job.sessionId);\n      if (runId) {\n        registry.killAll(runId, 'SIGKILL');\n      }\n      await jobs.updateJob(jobId, { abortState: 'propagated' });\n""",
    """      await jobs.updateJob(jobId, {\n        status: 'cancelling',\n        abortState: 'requested',\n      });\n\n      // A requester in another process can only persist the request. The owner\n      // poll relays it to that process's AbortController and subprocess\n      // registry, then advances abortState to propagated.\n      if (job.owner !== workerId) {\n        return;\n      }\n      const controller = controllers.get(jobId);\n      controller?.abort();\n      const runId = await sessions.getRunIdBySessionId(job.sessionId);\n      if (runId) {\n        registry.killAll(runId, 'SIGKILL');\n      }\n      await jobs.updateJob(jobId, { abortState: 'propagated' });\n""",
)

insert_before_last(
    "packages/core/__tests__/session/job-runner.test.ts",
    "});",
    r'''
  it('owner poll relays a cross-process pause into its process-local pause flag', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, bus, registry, runner } = setup({
      executor,
      workerId: 'worker_web',
      pollIntervalMs: 5,
    });
    const requester = createJobRunner({
      jobs,
      sessions,
      bus,
      registry: createSubprocessRegistry(),
      executor: immediateExecutor(),
      pollIntervalMs: 5,
      heartbeatMs: 30,
      leaseTtlMs: 30_000,
      workerId: 'worker_cli',
    });
    runners.push(requester);
    const session = await seedSession(sessions, 'run_cross_process_pause');
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ownerContext = executor.ctxFor(job.id);
    expect(ownerContext?.pauseRequested()).toBe(false);

    await requester.requestPause(job.id);

    await waitFor(() => ownerContext?.pauseRequested() === true);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'paused',
      owner: 'worker_web',
    });

    executor.release(job.id, { status: 'done' });
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
  });

  it('owner poll relays a cross-process cancel and cancellation wins a racing done result', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, bus, registry, runner } = setup({
      executor,
      workerId: 'worker_web',
      pollIntervalMs: 5,
    });
    const ownerKill = vi.spyOn(registry, 'killAll');
    const requester = createJobRunner({
      jobs,
      sessions,
      bus,
      registry: createSubprocessRegistry(),
      executor: immediateExecutor(),
      pollIntervalMs: 5,
      heartbeatMs: 30,
      leaseTtlMs: 30_000,
      workerId: 'worker_cli',
    });
    runners.push(requester);
    const session = await seedSession(sessions, 'run_cross_process_cancel');
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ownerContext = executor.ctxFor(job.id);

    await requester.requestCancel(job.id, 'external cli cancel');
    await waitFor(() => ownerContext?.signal.aborted === true);
    expect(ownerKill).toHaveBeenCalledWith(
      'run_cross_process_cancel',
      'SIGKILL',
    );
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'cancelling',
      abortState: 'propagated',
      owner: 'worker_web',
    });

    // Deliberately return done after cancellation to exercise the settle fence.
    executor.release(job.id, { status: 'done' });
    await waitFor(async () => (await jobs.get(job.id))?.status === 'cancelled');
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
  });

''',
)

# ---------------------------------------------------------------------------
# 2. Workflow terminality: a terminal run can never be revived by `pause`, and
#    an unexpected non-terminal engine return is a failure, not a fake success.
# ---------------------------------------------------------------------------

regex_replace_once(
    "packages/cli/src/commands/approval.ts",
    r"export async function commandPause\(\n  argv: string\[\],\n  io: CliIO,\n\): Promise<number> \{.*?\n\}\n\nexport async function commandResume",
    """export async function commandPause(\n  argv: string[],\n  io: CliIO,\n): Promise<number> {\n  await withSessionCommandCtx(\n    argv,\n    io,\n    async ({ repositories, runId, sessionService }) => {\n      const workflow = await repositories.getWorkflowInstance(runId);\n      if (!workflow) {\n        throw new Error(`未找到运行: ${runId}`);\n      }\n      const result = await sessionService.requestPause({ runId });\n      if (result.outcome === 'paused') {\n        io.stdout.write(`runId=${runId} status=paused\\n`);\n        return;\n      }\n\n      const status = result.workflowStatus ?? workflow.status;\n      if (['passed', 'failed', 'cancelled'].includes(status)) {\n        throw new WorkflowTerminalError(runId, status);\n      }\n      throw new Error(`运行 ${runId} 当前状态为 ${status}，无法暂停。`);\n    },\n  );\n  return 0;\n}\n\nexport async function commandResume""",
)

insert_before_last(
    "packages/cli/__tests__/approval-terminal.test.ts",
    "});",
    r'''
  it('M5: tekon pause on a cancelled run exits 1 and cannot revive the terminal status', async () => {
    const { repoPath, runId } = await createCancelledRunWithPendingDecision();
    const io = createMemoryIo();

    await expect(
      runCli(['pause', '--run-id', runId, '--repo', repoPath], io),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('终态');

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    expect(await createRepositories(db).getWorkflowInstance(runId)).toMatchObject({
      status: 'cancelled',
    });
    db.close();
  });

''',
)

replace_once(
    "packages/cli/__tests__/e2e/cli-flow.test.ts",
    """    const pauseOutput = runCli(\n      cliPath,\n      ['pause', '--run-id', runId!, '--repo', repoPath],\n      repoPath,\n    );\n    expect(pauseOutput).toContain('status=paused');\n\n    const cancelOutput = runCli(\n      cliPath,\n      ['cancel', '--run-id', runId!, '--repo', repoPath],\n      repoPath,\n    );\n    expect(cancelOutput).toContain('status=cancelled');\n""",
    """    // Terminal states are monotonic: a passed run cannot be revived as paused.\n    expect(() =>\n      runCli(\n        cliPath,\n        ['pause', '--run-id', runId!, '--repo', repoPath],\n        repoPath,\n      ),\n    ).toThrow();\n\n    // Cancel is idempotent against a different terminal outcome: it reports the\n    // existing passed status instead of mutating the run.\n    const cancelOutput = runCli(\n      cliPath,\n      ['cancel', '--run-id', runId!, '--repo', repoPath],\n      repoPath,\n    );\n    expect(cancelOutput).toContain('status=passed');\n""",
)

replace_once(
    "packages/core/src/session/workflow-job-executor.ts",
    """      default: {\n        // running/pending should not be a terminal engine return; treat as done\n        // to avoid a stuck job, but surface it via turn/end.\n        await sessions.updateSessionStatus(sessionId, 'idle');\n        await emit(sessionId, 'turn/end', { runId, status: workflow.status });\n        return { status: 'done' };\n      }\n""",
    """      default: {\n        // A background executor returning running/pending is a contract breach.\n        // Never convert it to `done`: that creates a false-success job while the\n        // workflow itself is still non-terminal. Fail loudly and preserve the\n        // unexpected status in the durable event trail.\n        const message = `Workflow engine returned non-terminal status: ${workflow.status}`;\n        await sessions.updateSessionStatus(sessionId, 'failed');\n        await emit(sessionId, 'agent/error', {\n          runId,\n          status: workflow.status,\n          message,\n        });\n        await emit(sessionId, 'turn/end', { runId, status: 'failed' });\n        return { status: 'failed' };\n      }\n""",
)

# ---------------------------------------------------------------------------
# 3. Event durability: allocate per-session sequence numbers inside an IMMEDIATE
#    SQLite transaction so independent CLI/Web processes cannot race max(seq).
# ---------------------------------------------------------------------------

regex_replace_once(
    "packages/core/src/session/session-store.ts",
    r"    async appendEvent\(input\) \{.*?\n    \},\n\n    async listEventsSince",
    """    async appendEvent(input) {\n      return writeQueue.enqueue(() => {\n        // The process-local WriteQueue cannot serialize writes from a separate\n        // CLI/Web process. BEGIN IMMEDIATE acquires the database writer lock\n        // before max(seq) is read, making allocation + insert one cross-process\n        // critical section. busy_timeout handles short-lived contention.\n        const append = db.transaction(() => {\n          const maxRow = db\n            .prepare(\n              'select coalesce(max(seq), 0) as max_seq from session_events where session_id = ?',\n            )\n            .get(input.sessionId) as { max_seq: number };\n          const event = sessionEventSchema.parse({\n            sessionId: input.sessionId,\n            seq: maxRow.max_seq + 1,\n            type: input.type,\n            version: SESSION_EVENT_SCHEMA_VERSION,\n            timestamp: now(),\n            payload: input.payload ?? {},\n            visibility: input.visibility ?? 'ui-only',\n            modelVisible: input.modelVisible ?? false,\n            sourceEventSeqs: input.sourceEventSeqs ?? [],\n            correlationId: input.correlationId ?? null,\n          });\n          db.prepare(\n            `insert into session_events (\n               session_id, seq, type, version, timestamp, payload,\n               visibility, model_visible, source_event_seqs, correlation_id\n             ) values (\n               @sessionId, @seq, @type, @version, @timestamp, @payload,\n               @visibility, @modelVisible, @sourceEventSeqs, @correlationId\n             )`,\n          ).run({\n            sessionId: event.sessionId,\n            seq: event.seq,\n            type: event.type,\n            version: event.version,\n            timestamp: event.timestamp,\n            payload: JSON.stringify(event.payload),\n            visibility: event.visibility,\n            modelVisible: event.modelVisible ? 1 : 0,\n            sourceEventSeqs: JSON.stringify(event.sourceEventSeqs),\n            correlationId: event.correlationId,\n          });\n          return event;\n        });\n        return append.immediate();\n      });\n    },\n\n    async listEventsSince""",
)

replace_once(
    "packages/core/__tests__/session/session-store.test.ts",
    """import { randomUUID } from 'node:crypto';\n\nimport { describe, expect, it } from 'vitest';\n""",
    """import { randomUUID } from 'node:crypto';\nimport { mkdtempSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n\nimport { afterEach, describe, expect, it } from 'vitest';\n""",
)

replace_once(
    "packages/core/__tests__/session/session-store.test.ts",
    """function setupStore() {\n""",
    """const tempDirs: string[] = [];\n\nafterEach(() => {\n  for (const dir of tempDirs.splice(0)) {\n    rmSync(dir, { recursive: true, force: true });\n  }\n});\n\nfunction setupStore() {\n""",
)

replace_once(
    "packages/core/__tests__/session/session-store.test.ts",
    """});\n\ndescribe('job repository', () => {\n""",
    r'''  it('allocates monotonic event seqs across independent database connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-session-seq-'));
    tempDirs.push(dir);
    const filename = join(dir, 'tekon.sqlite');
    const dbA = openTekonDatabase({ filename });
    const dbB = openTekonDatabase({ filename });
    try {
      migrateDatabase(dbA);
      migrateDatabase(dbB);
      const storeA = createSessionEventStore(dbA, createWriteQueue());
      const storeB = createSessionEventStore(dbB, createWriteQueue());
      const workspace = await storeA.getOrCreateDefaultWorkspace(dir);
      const session = await storeA.createSession({
        workspaceId: workspace.id,
        title: 'two connections',
        profile: 'human-web',
        runId: null,
      });

      const appended = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          (index % 2 === 0 ? storeA : storeB).appendEvent({
            sessionId: session.id,
            type: 'agent/status',
            payload: { index },
          }),
        ),
      );
      const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect((await storeA.listEventsSince(session.id, 0)).map((event) => event.seq)).toEqual(
        seqs,
      );
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

describe('job repository', () => {
''',
)

# ---------------------------------------------------------------------------
# 4. SSE: retain the in-process bus for low latency, but continuously catch up
#    from SQLite and order by contiguous seq so CLI-originated events appear in
#    an already-open Web stream without reconnecting.
# ---------------------------------------------------------------------------

write(
    "packages/web/src/server/sse.ts",
    r'''import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  presentEvent,
  type SessionEvent,
  type SessionEventBus,
  type SessionEventStore,
} from '@tekon/core';

/**
 * Stream one session's durable events. The process-local bus is a low-latency
 * hint; SQLite remains the cross-process source. A short catch-up poll reads
 * from the last contiguous seq, so events appended by a separate CLI process
 * reach an already-open Web stream without a reconnect.
 */
export async function handleSessionEventsSse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sessionId: string;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  heartbeatMs?: number;
  catchUpMs?: number;
}): Promise<void> {
  const { request, response, sessionId, sessions, bus } = input;

  // Validate before committing event-stream headers so the route can still
  // return a normal JSON 404/500.
  const session = await sessions.getSession(sessionId);
  if (!session) {
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({
        error: { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` },
      }),
    );
    return;
  }

  const url = new URL(request.url ?? '', 'http://localhost');
  const sinceParam = url.searchParams.get('sinceSeq');
  const lastEventId = request.headers['last-event-id'];
  let cursor = 0;
  if (sinceParam != null && /^\d+$/.test(sinceParam)) {
    cursor = Number(sinceParam);
  } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    cursor = Number(lastEventId);
  }

  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let catchUpTimer: ReturnType<typeof setInterval> | null = null;
  let catchUpInFlight = false;

  const writeFrame = (event: SessionEvent): void => {
    if (closed || response.writableEnded) return;
    const presented = presentEvent(event);
    if (!presented) return;
    const safeType = presented.type.replace(/[\r\n]/g, ' ');
    response.write(
      `id: ${presented.seq}\n` +
        `event: ${safeType}\n` +
        `data: ${JSON.stringify(presented)}\n\n`,
    );
  };

  // Live events may arrive ahead of an event committed in another process.
  // Buffer by seq and only advance the cursor through a contiguous prefix.
  // Internal events still advance the cursor even though presentEvent filters
  // them from the client.
  const pending = new Map<number, SessionEvent>();
  const drain = (): void => {
    for (;;) {
      const next = pending.get(cursor + 1);
      if (!next) break;
      pending.delete(next.seq);
      cursor = next.seq;
      writeFrame(next);
    }
  };
  const enqueue = (event: SessionEvent): void => {
    if (event.seq <= cursor || pending.has(event.seq)) return;
    pending.set(event.seq, event);
    drain();
  };

  // Subscribe before replay. The contiguous buffer removes replay/live races
  // and de-duplicates an event that appears in both paths.
  const unsubscribe = bus.subscribe(sessionId, enqueue);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (catchUpTimer) clearInterval(catchUpTimer);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  request.on('close', cleanup);

  const catchUp = async (): Promise<void> => {
    if (closed || response.writableEnded || catchUpInFlight) return;
    catchUpInFlight = true;
    try {
      const events = await sessions.listEventsSince(sessionId, cursor);
      for (const event of events) enqueue(event);
    } catch {
      cleanup();
    } finally {
      catchUpInFlight = false;
    }
  };

  try {
    await catchUp();
  } catch {
    cleanup();
    return;
  }

  if (closed || response.writableEnded) {
    cleanup();
    return;
  }

  const heartbeatMs = input.heartbeatMs ?? 15_000;
  heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) response.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  const catchUpMs = input.catchUpMs ?? 750;
  catchUpTimer = setInterval(() => {
    void catchUp();
  }, catchUpMs);
  catchUpTimer.unref?.();
}
''',
)

insert_before_last(
    "packages/web/__tests__/api/session-sse.test.ts",
    "});",
    r'''
  it('catches up an event committed without a process-local bus publish', async () => {
    const fixture = await createWebFixtureProject();
    const s = openStore(fixture.projectRoot);
    cleanupTasks.push(() => {
      s.close();
      fixture.cleanup();
    });
    const sessionId = await seedSession(s.store, fixture.projectRoot);

    const fake = makeFakeReqRes(`/api/sessions/${sessionId}/events?sinceSeq=0`);
    await handleSessionEventsSse({
      request: fake.request,
      response: fake.response,
      sessionId,
      sessions: s.store,
      bus: s.bus,
      heartbeatMs: 60_000,
      catchUpMs: 5,
    });

    // Deliberately do not publish to the local bus: this models a separate CLI
    // process writing to the shared SQLite event store.
    await s.store.appendEvent({
      sessionId,
      type: 'assistant/message',
      payload: { text: 'written by another process' },
      modelVisible: true,
    });

    const deadline = Date.now() + 2_000;
    while (!fake.frames().some((frame) => frame.event === 'assistant/message')) {
      if (Date.now() >= deadline) {
        throw new Error('cross-process SSE catch-up did not deliver the event');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fake.frames().filter((frame) => frame.id === '1')).toHaveLength(1);
    fake.close();
  });

''',
)

# ---------------------------------------------------------------------------
# 5. Agent output fidelity and durable redaction. DSH headless officially writes
#    its final assistant message to stdout; surface that text instead of always
#    replacing it with an artifact-count sentence.
# ---------------------------------------------------------------------------

replace_once(
    "packages/core/src/runtime/agent-adapter.ts",
    """  outputFiles: string[];\n  artifacts?: Artifact[];\n  timedOut?: boolean;\n""",
    """  outputFiles: string[];\n  artifacts?: Artifact[];\n  /** Final assistant prose when the provider exposes a documented boundary. */\n  assistantText?: string;\n  timedOut?: boolean;\n""",
)

replace_once(
    "packages/core/src/runtime/dsh-headless-adapter.ts",
    """import { basename, join } from 'node:path';\n""",
    """import { readFileSync } from 'node:fs';\nimport { basename, join } from 'node:path';\n""",
)

replace_once(
    "packages/core/src/runtime/dsh-headless-adapter.ts",
    """import type { Artifact, CommandInvocation } from '../types/domain.js';\n""",
    """import type { Artifact, CommandInvocation } from '../types/domain.js';\nimport { redactSecrets } from '../security/secrets.js';\n""",
)

replace_once(
    "packages/core/src/runtime/dsh-headless-adapter.ts",
    """const DSH_SAFE_ENV_KEYS = [\n  'PATH',\n  'HOME',\n  'TMPDIR',\n  'TMP',\n  'TEMP',\n  'LANG',\n  'LC_ALL',\n  'SHELL',\n] as const;\n""",
    """const DSH_SAFE_ENV_KEYS = [\n  'PATH',\n  'HOME',\n  'TMPDIR',\n  'TMP',\n  'TEMP',\n  'LANG',\n  'LC_ALL',\n  'SHELL',\n] as const;\n\nconst MAX_ASSISTANT_TEXT_CHARS = 16_000;\n\nfunction readFinalAssistantText(path: string): string | undefined {\n  try {\n    const raw = readFileSync(path, 'utf8').trim();\n    if (!raw) return undefined;\n    const bounded =\n      raw.length > MAX_ASSISTANT_TEXT_CHARS\n        ? `${raw.slice(0, MAX_ASSISTANT_TEXT_CHARS)}…`\n        : raw;\n    return redactSecrets(bounded).content;\n  } catch {\n    return undefined;\n  }\n}\n""",
)

replace_once(
    "packages/core/src/runtime/dsh-headless-adapter.ts",
    """        artifacts,\n        timedOut: result.timedOut,\n      };\n""",
    """        artifacts,\n        assistantText:\n          result.exitCode === 0\n            ? readFinalAssistantText(result.stdoutPath)\n            : undefined,\n        timedOut: result.timedOut,\n      };\n""",
)

replace_once(
    "packages/core/__tests__/runtime/dsh-headless-adapter.test.ts",
    """      provider: 'dsh-headless',\n      exitCode: 0,\n      timedOut: false,\n""",
    """      provider: 'dsh-headless',\n      exitCode: 0,\n      assistantText: 'final assistant answer',\n      timedOut: false,\n""",
)

replace_once(
    "packages/core/src/runtime/agent-step-events.ts",
    """import type { Role } from '../types/domain.js';\n""",
    """import type { Role } from '../types/domain.js';\nimport { redactSecrets } from '../security/secrets.js';\n""",
)

replace_once(
    "packages/core/src/runtime/agent-step-events.ts",
    """function summarize(text: string | undefined, max = 500): string | undefined {\n  if (!text) return undefined;\n  const oneLine = text.replace(/\\s+/g, ' ').trim();\n  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;\n}\n""",
    """function summarize(text: string | undefined, max = 500): string | undefined {\n  if (!text) return undefined;\n  const oneLine = redactSecrets(text.replace(/\\s+/g, ' ').trim()).content;\n  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;\n}\n""",
)

replace_once(
    "packages/core/src/runtime/agent-step-events.ts",
    """      error: error instanceof Error ? error.message : String(error),\n""",
    """      error: redactSecrets(\n        error instanceof Error ? error.message : String(error),\n      ).content,\n""",
)

regex_replace_once(
    "packages/core/src/runtime/agent-step-events.ts",
    r"  // Success path: node-level tool summary \+ synthesized assistant message\..*?\n  await emit\('step/end', \{",
    """  // Success path: node-level tool summary plus the provider's final\n  // assistant prose when it exposes a documented boundary (currently DSH\n  // headless stdout). Other providers remain explicitly synthesized.\n  const artifactRefs = (result.artifacts ?? []).map((a) => ({\n    type: a.type,\n    path: a.path,\n  }));\n  const assistantText = result.assistantText?.trim();\n  const syntheticText = `[${meta.role}] completed: ${artifactRefs.length} artifact(s), exit ${result.exitCode ?? 'n/a'}.`;\n  await emit(\n    'tool/call',\n    {\n      stepId,\n      nodeId: meta.nodeId,\n      role: meta.role,\n      provider: result.provider,\n      name: result.provider,\n      summaryLevel: 'node',\n    },\n    false,\n  );\n  await emit(\n    'tool/result',\n    {\n      stepId,\n      nodeId: meta.nodeId,\n      provider: result.provider,\n      name: result.provider,\n      exitCode: result.exitCode,\n      outputFiles: result.outputFiles,\n      artifacts: artifactRefs,\n      summary: `${result.outputFiles.length} output file(s), ${artifactRefs.length} artifact(s)`,\n      summaryLevel: 'node',\n    },\n    true,\n  );\n  await emit(\n    'assistant/message',\n    {\n      stepId,\n      nodeId: meta.nodeId,\n      role: meta.role,\n      text: assistantText ?? syntheticText,\n      synthetic: !assistantText,\n      artifacts: artifactRefs,\n      tokenUsage: result.tokenUsage,\n    },\n    true,\n  );\n  await emit('step/end', {""",
)

replace_once(
    "packages/core/__tests__/runtime/agent-step-events.test.ts",
    """    // all events share one correlationId (stepId groups the node's step).\n    expect(assistant.payload.stepId).toBe(events[0].payload.stepId);\n""",
    """    // all events share one correlationId (stepId groups the node's step).\n    expect(assistant.payload.stepId).toBe(events[0].payload.stepId);\n    expect(assistant.payload.synthetic).toBe(true);\n    expect(events.find((e) => e.type === 'tool/call')?.payload.name).toBe(\n      'mock',\n    );\n    expect(toolResult.payload.summary).toContain('1 artifact');\n""",
)

insert_before_last(
    "packages/core/__tests__/runtime/agent-step-events.test.ts",
    "});",
    r'''
  it('uses documented provider assistant text instead of a synthetic summary', async () => {
    const { sink, events } = collectingSink();
    const adapter = adapterReturning({
      assistantText: 'This is the provider final answer.',
    });

    await runAgentWithStepEvents(adapter, INPUT, META, sink);

    const assistant = events.find((event) => event.type === 'assistant/message')!;
    expect(assistant.payload.text).toBe('This is the provider final answer.');
    expect(assistant.payload.synthetic).toBe(false);
  });

''',
)

# ---------------------------------------------------------------------------
# 6. Human-first presentation: keep Advanced navigation out of the default
#    workspace, render prose as prose, and remove raw IDs/sequence counters from
#    the primary reading path while retaining them in data attributes/routes.
# ---------------------------------------------------------------------------

replace_once(
    "packages/web/src/client/lib/event-feed.ts",
    """        // Phase 2 M3: synthesized from artifact metadata, not real model prose.\n        synthetic: true,\n""",
    """        // Old events omit the flag and remain conservatively labelled as\n        // synthesized; providers with a documented final-output boundary emit\n        // synthetic:false.\n        synthetic: p.synthetic !== false,\n""",
)

replace_once(
    "packages/web/src/client/components/sessions/EventFeed.tsx",
    """        <span className=\"feed-seq\">#{row.seq}</span>\n      </div>\n      {row.body ? <CodeBlock content={row.body} truncated /> : null}\n""",
    """      </div>\n      {row.body ? (\n        row.kind === 'message' ? (\n          <div className=\"feed-message-body\">{row.body}</div>\n        ) : (\n          <CodeBlock content={row.body} truncated />\n        )\n      ) : null}\n""",
)

replace_once(
    "packages/web/src/client/components/sessions/EventFeed.tsx",
    """            <div className=\"feed-turn-label\">回合 · turn @{group.turnSeq}</div>\n""",
    """            <div className=\"feed-turn-label\">任务回合</div>\n""",
)

replace_once(
    "packages/web/src/client/styles/sessions.css",
    """.feed-title {\n  color: var(--text-s, #475569);\n}\n""",
    """.feed-title {\n  color: var(--text-s, #475569);\n}\n.feed-message-body {\n  margin-top: 8px;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  font-size: 14px;\n  line-height: 1.65;\n  color: var(--text-p, #0f172a);\n}\n""",
)

replace_once(
    "packages/web/__tests__/client/event-feed.test.ts",
    """  it('pairs tool/call with a tool kind and surfaces the tool name', () => {\n""",
    """  it('honors an explicit non-synthetic assistant message', () => {\n    const row = describeEvent(\n      ev(\n        'assistant/message',\n        { text: 'provider answer', synthetic: false },\n        { modelVisible: true },\n      ),\n    );\n    expect(row.synthetic).toBe(false);\n  });\n\n  it('pairs tool/call with a tool kind and surfaces the tool name', () => {\n""",
)

replace_once(
    "packages/web/src/client/layouts/Sidebar.tsx",
    """import { NavLink } from 'react-router';\n""",
    """import { NavLink, useLocation } from 'react-router';\n""",
)

replace_once(
    "packages/web/src/client/layouts/Sidebar.tsx",
    """export function Sidebar() {\n  const overviewQuery = useQuery<ProjectOverviewOutput>(\n""",
    """export function Sidebar() {\n  const { pathname } = useLocation();\n  const advancedMode = pathname.startsWith(routes.advanced);\n  const visibleGroups = advancedMode ? navGroups : [navGroups[0]!];\n  const overviewQuery = useQuery<ProjectOverviewOutput>(\n""",
)

replace_once(
    "packages/web/src/client/layouts/Sidebar.tsx",
    """          <div className=\"brand-tag\">Cockpit</div>\n""",
    """          <div className=\"brand-tag\">\n            {advancedMode ? 'Cockpit' : 'Workspace'}\n          </div>\n""",
)

replace_once(
    "packages/web/src/client/layouts/Sidebar.tsx",
    """        {navGroups.map((group) => (\n""",
    """        {visibleGroups.map((group) => (\n""",
)

replace_once(
    "packages/web/src/client/pages/SessionsPage.tsx",
    """                <option value={workspaceId}>{workspaceId}</option>\n""",
    """                <option value={workspaceId}>当前项目</option>\n""",
)

replace_once(
    "packages/web/src/client/pages/SessionsPage.tsx",
    """            <li key={session.id} className=\"session-list-item\">\n              <NavLink to={routes.session(session.id)} className=\"session-list-link\">\n""",
    """            <li\n              key={session.id}\n              className=\"session-list-item\"\n              title={session.runId ? `关联运行 ${session.runId}` : undefined}\n            >\n              <NavLink\n                to={routes.session(session.id)}\n                className=\"session-list-link\"\n              >\n""",
)

replace_once(
    "packages/web/src/client/pages/SessionsPage.tsx",
    """                {session.runId ? (\n                  <span className=\"session-list-run text-muted\">\n                    run {session.runId}\n                  </span>\n                ) : null}\n""",
    """                {session.runId ? (\n                  <span className=\"session-list-run text-muted\">交付运行</span>\n                ) : null}\n""",
)

replace_once(
    "packages/web/src/client/pages/SessionDetailPage.tsx",
    """                {session.runId ? ` · run ${session.runId}` : ''}\n""",
    """                {session.runId ? ' · 已关联交付运行' : ''}\n""",
)

# Link the annotated first report to this follow-up.
replace_once(
    "docs/reviews/2026-08-20-tekon-human-usability-and-deepseek-harness-migration-review.md",
    """# Tekon 人类可用性审查与 DeepSeek Harness 模式迁移评估\n""",
    """# Tekon 人类可用性审查与 DeepSeek Harness 模式迁移评估\n\n> 第二轮实现复审见：[2026-08-25 Tekon Harness Replatform 第二轮全面复审](./2026-08-25-tekon-harness-replatform-second-review.md)。\n""",
)

REPORT = r'''# Tekon Harness Replatform 第二轮全面复审

> 复审日期：2026-08-25  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 复审基线：Agent 修改后的 PR head `75382739c2adb11219c61594111e8f43767a5f72`，以及本轮审查修复提交。  
> 复审维度：产品逻辑、UI 信息架构、UX 交互、运行时与数据架构、代码正确性、安全边界、测试与交付可信度。  
> 证据范围：全量 PR diff、关键实现与测试、GitHub Actions、DeepSeek Harness 官方 README/architecture/headless 文档。当前执行环境不能拉取仓库并启动浏览器，因此 UI 部分是代码与 Playwright 用例审查，不冒充独立截图或人工视觉走查。

## 1. 结论

### 1.1 最终判断

**本轮仍不能判定“通过”。**

但结论已经与第一轮明显不同：PR #10 不再只是迁移设想，而是完成了一个有实质价值的 Harness-inspired replatform 骨架：

- `Workspace / Session / SessionEvent / Job` 数据模型已经落地；
- Web `project.run` 已从长 HTTP 请求改为准备 + 后台 Job；
- SSE replay、断线游标和 Session-first 路由已经落地；
- CLI、Web、Playwright 已进入持续集成；
- Demand Shape 审批链、后台恢复、provider registry、profile、goal、自动 prepare/readiness、DSH bridge 均有实现和测试；
- 旧 Cockpit 保留在 `/advanced`，默认入口切换到 Session。

这意味着 **阶段 0/1 的方向基本成立，底层工程质量也有明显进步**。然而，“普通人可用的连续 Agent 工作台”仍没有完成，当前 Session UI 主要是旧 Workflow 的事件投影，而不是可持续对话、可转向、可解释的 Agent Loop。

因此本报告给出两层判断：

| 验收对象 | 结论 |
| --- | --- |
| Phase 0/1：契约、事件脊柱、后台 Job、基础恢复 | **有条件通过**；本轮修复后可继续迭代 |
| Phase 2–5 当前实现：流式 Agent、Human-first UI、Profile/Goal/DSH 互操作 | **不通过**；仍有产品与架构阻断项 |
| 作为普通用户可发布产品 | **不通过** |
| 作为 Agent 自举/治理底盘的实验分支 | **可继续使用** |

### 1.2 更新评分

| 维度 | 第一轮 | 本轮 | 说明 |
| --- | ---: | ---: | --- |
| Agent 自动执行底盘 | 7.5 | 8.0 | 原有 Workflow/Gate/Artifact/Worktree 保持稳定 |
| 后台任务与恢复 | 2.5 | 7.0 | Durable Job、lease、checkpoint、cancel chain 已落地；本轮补跨进程 relay |
| 事件与可回放性 | 1.5 | 6.5 | typed event + SSE 已有；仍是 best-effort projection，不是唯一事实源 |
| 人类输入体验 | 2.0 | 4.5 | Session-first + composer，但仍默认启动完整交付 Workflow |
| 过程可见性 | 1.5 | 5.0 | 有连续 feed；主要输出仍为 node 级合成摘要，非主流 provider 原文流 |
| 人类干预能力 | 2.0 | 3.5 | pause/cancel/inline approval 改善；follow-up/steer 未接通 |
| 输出可读性 | 2.0 | 4.5 | 默认入口改善；事件仍偏内部模型，本轮降低部分 ID/seq 噪音 |
| 架构扩展性 | 4.0 | 7.0 | provider registry、profile、job executor routing、event contract 已建立 |
| 测试与交付可信度 | 3.0 | 8.0 | Core/CLI/Web/Playwright 全部进入 CI，显著改善 |
| 普通用户发布信心 | 3.0 | 4.5 | 基础设施提升，但连续协作与安全 onboarding 仍缺失 |

## 2. 已验证的实质进步

### 2.1 长 HTTP RPC 已被拆成 prepare + enqueue

`SessionService.startRun()` 先调用 `engine.prepareRun()`，再创建 Session、写入事件、enqueue Job；Web 请求可以毫秒级返回 `runId/sessionId/jobId`，后台 Runner 接管执行。这修复了第一轮最重要的产品/架构错误。

保留意见：这组写入目前不是一个原子事务，详见 P1-03。

### 2.2 Session/Event/Job 契约已经形成

当前实现具备：

- append-only `session_events`；
- per-session seq；
- replay cursor；
- `jobs` owner/lease/abort/checkpoint；
- stale recovery；
- workflow/job/session 状态映射；
- projection/event presentation；
- SSE reconnect。

这套骨架与 DeepSeek Harness 的 Session/Event/Agent live-control 分层在方向上是一致的。

### 2.3 默认产品入口已从 Cockpit 转为 Session

`/` 现在是 Sessions，旧 Runs/Approvals/Delivery/Config/Eval 放在 `/advanced`。这符合“人类先看任务叙事、治理对象退到 Inspector”的原则。

本轮进一步把默认 Sidebar 只保留 Session/Advanced，减少内部实体导航对新用户的干扰；原有高级能力没有删除。

### 2.4 CI 已补齐人类可用性表面

PR 当前 CI 覆盖：

- Root typecheck/lint；
- Core build/unit/e2e；
- CLI build/unit/e2e；
- Web build/typecheck/unit；
- Playwright 浏览器流程。

这是第一轮报告中的核心缺口之一，目前已实质修复。

### 2.5 DSH bridge 的边界总体诚实

实现明确：

- pin `@deepseek-ai/dsh` 版本；
- 固定 `--profile headless`；
- 拒绝用户覆盖 profile/patch/dump 等 launcher 控制面；
- 独立 `DSH_HOME`；
- 明确 DSH 网络无法被 Tekon 证明隔离，要求显式 acknowledgment；
- 明确 headless 是单任务、无 follow-up 的 goal-only 边界。

本轮补充读取官方 headless stdout 的最终 assistant 文本，使 DSH Session 不再只显示“产出 N 个 artifact”的合成句子。

## 3. 本轮发现并已修复的问题

### F-01 跨进程 pause/cancel 只写数据库，Web owner 不会 relay

**严重级别：High**

原实现允许一个 CLI Runner 修改另一个 Web Runner 所持 Job 的 `paused/cancelling` 状态，但 Web owner 没有观察控制行的循环。另一个进程无法触碰 owner 进程内的 `AbortController`、pause flag 和 subprocess registry。

本轮修复：

- owner poll 每轮同步自己持有 Job 的 durable control state；
- foreign pause 转成本地 pause flag；
- foreign cancel 转成本地 AbortSignal + `registry.killAll()`；
- owner 变化时本地 zombie executor 被 fence；
- 增加双 Runner 测试。

### F-02 cancelling 与 executor done 竞态会把 Job 写回 done

**严重级别：High**

原 `settle()` 只检查 owner，不检查当前 `cancelling/abortState`。外部取消落库后，executor 若先返回 `done`，可覆盖取消状态。

本轮修复：cancel request、propagated state 或 aborted controller 均强制 settle 为 `cancelled`，并用回归测试故意让 executor 在取消后返回 done。

### F-03 CLI `pause` 可把 passed/failed/cancelled Run 复活为 paused

**严重级别：High**

`commandPause()` 在 SessionService 返回 illegal transition 后保留了“legacy direct DB fallback”，会直接改 Node 和 Workflow 状态。这破坏终态单调性，并允许后续 cancel 把一个已 passed 的 Run 改成 cancelled。

本轮修复：终态统一抛 `WorkflowTerminalError`，其他非法状态也失败，不再直接写库；CLI unit/e2e 同步更新。

### F-04 非终态 Workflow 返回被映射为成功 Job

**严重级别：High**

`settleByWorkflowStatus()` 的 default 分支把 `running/pending` 等契约异常映射成 `job=done, session=idle`。这是明确的 fake pass。

本轮修复：记录 `agent/error`，Session 与 Job 均失败，turn/end 标记 failed。

### F-05 Session seq 只受进程内 WriteQueue 保护

**严重级别：High**

旧实现是 `SELECT max(seq) + INSERT`。CLI 与 Web 使用不同连接和不同 WriteQueue 时可能同时分配同一 seq。

本轮修复：使用 SQLite `BEGIN IMMEDIATE` 将序号读取和插入变成跨连接写临界区，并增加双连接回归测试。

### F-06 SSE live 只依赖 process-local EventBus

**严重级别：High**

连接建立后，CLI 写入同一个 SQLite 的事件不会进入 Web 进程的 EventEmitter，浏览器只能重连后看到。

本轮修复：

- local bus 继续提供低延迟；
- SSE 同时按 durable cursor 周期 catch-up SQLite；
- 用 contiguous seq buffer 处理“本地事件先看到、外部较低 seq 后读到”的顺序问题；
- replay/live/DB 三路统一去重；
- 新增“不 publish bus 仍能推送”的测试。

### F-07 DSH 官方最终输出被丢弃

**严重级别：Medium**

官方 headless 契约把最终 assistant text 写到 stdout，旧 adapter 只返回 stdout 文件路径，Session 仍显示合成摘要。

本轮修复：对 stdout 做长度限制和 secret redaction，填入 `AgentRunResult.assistantText`；step bridge 优先展示真实 final text，并通过 `synthetic` 标记区分。

### F-08 durable prompt/error 事件存储未先脱敏

**严重级别：Medium**

Presentation 层脱敏不能替代写入前脱敏。旧 step event 会把 prompt summary 和 adapter throw message 原样写入 Session DB。

本轮修复：step bridge 在摘要和错误写入前调用 core secret redaction。

### F-09 默认 Session UI 仍暴露过多调试信息

**严重级别：Medium**

原默认界面显示 workspace ID、完整 run ID、event seq、`turn @seq`，并把普通对话文本放在代码块里。

本轮修复：

- 默认 Sidebar 隐藏全部 Cockpit 分组，仅 Advanced 模式展开；
- workspace 显示“当前项目”；
- Run ID 从主列表/标题叙事移到 tooltip/路由；
- prose 用普通可换行文本展示；
- event seq 和 turn event seq 不再作为主视觉信息。

## 4. 仍然阻断“通过”的问题

### P0-01 主流 Provider 仍是 node 级黑盒，不是流式 Agent Loop

Codex/Claude/Mock 的核心接口仍是：

```ts
runAgent(input): Promise<AgentRunResult>
```

当前 `step/start → tool/call → tool/result → assistant/message` 是包在一次完整 node 执行外面的合成序列，并不代表真实模型 step/tool 生命周期。除 DSH final stdout 外，没有 assistant chunk、真实 tool call/result 或 request boundary。

影响：

- 用户看不到 Agent 实际正在做什么；
- 不能在一步中途 steer；
- tool card 无法还原真实命令与结果；
- “实时”主要是治理事件实时，不是模型输出实时。

验收要求：至少让一个主力 provider（Codex 或 Claude）实现真实增量事件，再把该协议推广到 registry。

### P0-02 Session Detail 没有 follow-up / steer composer

`AgentDriver.followUp()`、`steer()`、`resume()` 仍为 NotSupported；Session Composer 只负责创建新 Run。用户进入 Session 后不能继续提问、补充约束或纠正方向。

这意味着当前产品仍是“用 Session 看一次 Workflow”，不是“在 Session 中与 Agent 持续协作”。

验收要求：

- Session Detail 底部固定 composer；
- follow-up 进入 inbox；
- steer 明确作用于当前/下一 step；
- durable `user/message` / `agent/steered`；
- 重连后可恢复 pending input。

### P0-03 默认新 Session 仍启动完整 standard-delivery

UI 中的“开始会话”实际调用 `project.run` 的 workflow 模式，普通一句任务会进入 PM/RD/QA/Reviewer 全链路。Session 名称变了，底层用户心智仍然要求理解受控交付流程。

建议：默认提供两种清晰入口：

1. **协作任务**：轻量 Agent Session，适合解释、探索、小改动；
2. **受控交付**：完整 Workflow/Gate/PR 流程。

不要让用户通过模板下拉框猜测这两种产品模式。

### P0-04 Goal 模式可改代码却默认无 Gate/Artifact

`workflows/goal.yaml` 是单 Node、无 output、无 gate。虽然不允许 Delivery，但 Agent 可在 worktree 产生代码并最终 promoted 到 run branch，而没有 build/lint/diff review。

建议至少满足其一：

- goal 默认 read-only；
- 检测到代码变化时自动注入 diff/build/lint/human review；
- 明确区分 `research-goal` 与 `change-goal`。

### P1-01 Event Spine 仍是 best-effort projection，不是事实源

多个 `emit()/dual-write` 路径 catch 并吞掉事件存储失败，legacy workflow/jobs tables 才是 source of truth。Session log 可以永久缺事件，无法保证完整 replay。

这在迁移期可以接受，但文档不能把当前实现描述成 Harness 式 canonical log。

建议分阶段提升：

- 先把 user input、assistant output、tool result、approval 设为必须写入；
- 用 outbox/transactional event append 连接 legacy state write；
- projection 从 log 重建并做 invariant test；
- 最后再把 audit/hash 投影迁移过来。

### P1-02 Automation listeners 仍依赖 process-local bus

本轮修复了 SSE 的 DB catch-up，但 auto-prepare/readiness listener 仍只订阅本进程 EventBus。CLI 完成的 Run 不一定触发另一个 Web 进程中的 automation。

建议把 automation 变成 durable projection worker：

- 从 `projection_checkpoints` 读取 cursor；
- 扫描 DB event log；
- idempotent enqueue automation job；
- checkpoint 与 enqueue 使用事务/outbox。

### P1-03 StartRun 不是原子创建

当前顺序为：prepare legacy run → audit hook → workspace/session → 三个 event → job enqueue。任一步失败都可能留下：

- 有 Run、无 Session；
- 有 Session、无 opening events；
- 有 Session、无 Job；
- 用户重试后生成第二个 Run。

建议提供一个 repository-level transaction：一次写入 run/session/opening events/job，外部副作用只在 commit 后开始。

### P1-04 `tekon ui` 仍要求用户手工复制 Session token

CLI 已读取 `.tekon/web-session.json`，但没有完成浏览器安全 handoff，也没有自动打开页面。默认入口会直接发起需要 token 的 read，用户先看到错误，再去寻找 token 输入框。

不要恢复 query-string token。建议使用：

- loopback-only one-time bootstrap nonce；
- 同源 `/api/bootstrap`，仅本地、一次性、短 TTL；
- 浏览器拿到 token 后只保存在内存并立即销毁 nonce；
- SSH 模式只打印明确的手动步骤。

### P1-05 Delivery approval 没有绑定具体内容身份

自动 re-prepare 对 failed delivery 保留 `approvedBy/approvedAt`。如果 branch HEAD、PR body 或 evidence package 已变化，旧批准仍可复用。

建议审批对象包含：

```text
branch + headSha + baseSha + prBodySha + packageSha
```

任一变化都使 approval 失效。

### P1-06 Workspace 仍只是单项目占位符

UI 显示“当前项目”，但没有 workspace 切换、添加、移除和最近项目。作为第一阶段占位合理，但不能把它算作 Workspace 产品能力完成。

### P1-07 长 Session 没有虚拟化、折叠与查询

`useSessionStream` 将所有事件持续累积在内存，Feed 全量渲染。长程研发任务很容易有数千事件。

建议：

- windowed/virtualized list；
- step/tool 默认折叠；
- 按类型/状态过滤；
- 搜索；
- server pagination + SSE tail；
- spill 内容按需加载。

## 5. 产品逻辑评估

### 5.1 当前真正适合的使用场景

- Agent 自举；
- 固定交付模板；
- 有明确 Artifact/Gate 的代码任务；
- 需要审计、审批和 PR 证据的长程任务；
- 开发者愿意进入 Advanced Cockpit 排障。

### 5.2 当前不适合的使用场景

- 用户边看边问、边做边改目标；
- 探索性需求；
- 需要连续解释和方案比较的任务；
- 非工程用户；
- 不理解 Workflow/Role/Gate 的个人用户；
- 希望像 Codex/Claude Code 一样直接看到模型与工具过程的用户。

### 5.3 建议的产品双轨

```text
Tekon Workspace
├─ Collaborate（默认）
│  ├─ Session / message / plan / tool / changes
│  ├─ 可 follow-up / steer / approve
│  └─ 按风险动态升级治理
└─ Deliver（高级）
   ├─ Demand Shape
   ├─ Workflow / Role / Gate / Artifact
   ├─ Readiness / Delivery / CI
   └─ PR 受控交付
```

Advanced 不只是隐藏旧页面，而应成为明确的 Deliver/Operations 模式。

## 6. UI 与 UX 评估

### 6.1 做对的部分

- 默认 Session-first；
- continuous feed；
- SSE 状态可见；
- inline approval；
- right rail 汇总 Gate/Artifact/Result；
- legacy Cockpit 未被破坏；
- Playwright 覆盖 Session list/feed/approval/routing。

### 6.2 仍需重做的关键交互

1. **首次启动**：安全自动鉴权，而不是先报错再手输 token；
2. **新任务**：先选择“协作”或“受控交付”，不要先暴露模板/provider/毫秒超时；
3. **运行中**：底部输入、停止、暂停、转向必须始终可见；
4. **输出**：模型正文优先，工具和治理事件折叠；
5. **失败**：用“发生了什么 / 已保存什么 / 现在能做什么”表达，不只显示状态枚举；
6. **完成**：一个 Final Result 汇总变化、验证、风险、未完成项和下一动作；
7. **高级信息**：runId/nodeId/gateKey/seq 放 Debug Inspector，不占主叙事。

### 6.3 可访问性与视觉验证限制

本轮确认了语义元素、按钮名称和部分 keyboard/Playwright 路径，但没有独立启动页面并截图，因此不能声称：

- 颜色对比通过 WCAG；
- focus order 完整；
- 响应式布局无溢出；
- 长文本/大表格在真实浏览器中可读；
- screen reader announcement 完整；
- loading/reconnect 动画不会造成干扰。

下一轮应把真实浏览器截图、键盘遍历、axe 检查纳入 PR 验收，而不是只依赖 DOM 断言。

## 7. 架构评估

### 7.1 推荐继续保留的核心资产

- Workflow Engine；
- Gate registry；
- Artifact Store；
- Worktree/Command Gateway；
- Human approval；
- Audit Hash Chain；
- Delivery/Readiness；
- Provider registry；
- Session/Job/Event contracts。

### 7.2 下一步必须收敛的边界

| 边界 | 当前 | 目标 |
| --- | --- | --- |
| Agent runtime | node Promise 黑盒 | turn/step/chunk/tool event driver |
| Session event | best-effort dual-write | canonical log + transactional outbox |
| Job control | DB + process relay | durable command mailbox + fencing token |
| Automation | local EventEmitter | checkpointed durable projector |
| Product mode | template/provider 参数 | Collaborate vs Deliver |
| Goal | 无治理自由执行 | read-only 或变更触发治理 |
| Approval | 状态字段 | 绑定内容哈希的 capability |
| DSH | pinned headless bridge | anti-corruption adapter，持续 contract test |

### 7.3 不建议的做法

- 不要把 Tekon DB 直接替换成 DSH 私有 schema；
- 不要直接依赖 DSH 内部 packages 作为稳定 API；
- 不要为了“像 Harness”把现有 Gate/Artifact/Delivery 删除；
- 不要继续给 synthetic event 起“真实 streaming”名称；
- 不要在完成 Agent Loop 前继续扩展更多 profile/bundle 表面。

## 8. DeepSeek Harness 官方对照

复审时官方信息显示：

- Harness 仍处于 developer preview，明确允许 breaking changes；
- 核心是 plugin tree、typed durable session event 与 live agent events；
- headless profile 是一个 fresh persisted agent + one submitted task；
- headless 成功时把最终非空 assistant text 写到 stdout；
- headless 不提供 follow-up。

因此当前 Tekon 的 DSH bridge 适合做 **受控 one-shot goal provider**，不适合作为 Human-first Session 的完整后端。真正的连续协作仍必须由 Tekon 自己的 AgentDriver/Session inbox 抽象承担。

## 9. 测试与质量门槛

### 9.1 本轮修复应通过

- Core job-runner cross-owner pause/cancel；
- cancellation settle race；
- dual-connection session seq；
- DSH assistant stdout；
- step-event synthetic/real distinction；
- Web SSE cross-process DB catch-up；
- CLI terminal pause；
- root typecheck；
- 原 PR 全量 CI。

### 9.2 合并前还需要的产品验收

- 真实 Codex/Claude provider 的至少一条 streaming smoke；
- Session follow-up/steer E2E；
- Web 启动安全 bootstrap E2E；
- Goal 代码变更治理 E2E；
- CLI 完成 → Web 已连接 Session 实时看到 automation/result；
- server crash/restart → Job recovery + SSE replay；
- 1,000+ event Session 性能测试；
- axe + keyboard + responsive screenshot audit。

## 10. 推荐路线

### 下一里程碑 A：真正可协作的单 Session

只做一条窄闭环：

```text
输入任务
→ assistant 增量输出
→ 真实 tool call/result
→ 用户 follow-up/steer
→ diff + validation
→ final result
```

先支持一个主力 provider；不要同时扩所有 provider。

### 下一里程碑 B：治理动态升级

- 默认 collaborate；
- 发生文件写入时增加 changes inspector；
- 高风险工具触发 approval；
- 检测到代码变化自动 build/test；
- 用户选择 Deliver 时再进入完整 Workflow。

### 下一里程碑 C：Event Spine canonicalization

- transactional outbox；
- durable projector；
- session/event invariants；
- legacy table projection；
- 最后移除 best-effort dual-write。

## 11. 合并建议

**不建议按“完整 Harness 迁移已完成”合并。**

可选方案：

1. 将 PR 明确改名为“Event Spine / Durable Job / Session UI foundation”，以基础设施里程碑合并；或
2. 保持 PR 开放，继续完成 P0-01～P0-04。

若按方案 1 合并，必须在 README/CHANGELOG 中明确：

- Session feed 尚非完整模型 streaming；
- follow-up/steer 未开放；
- Goal 变更能力为实验性；
- DSH headless 是 one-shot provider；
- Event log 仍是迁移期 projection。

本轮结论：**基础设施阶段有条件通过，产品整体不通过。**
'''

write(
    "docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md",
    REPORT,
)

print("Second-review fixes and report applied.")
