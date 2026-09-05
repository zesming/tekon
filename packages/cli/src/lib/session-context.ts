import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  createAuditLogger,
  createAutomationJobExecutor,
  createCommandGateway,
  createDualWriteAuditLogger,
  createDualWriteRepositories,
  createGateEngine,
  createJobRepository,
  createJobRunner,
  createRepositories,
  createRoutingJobExecutor,
  createSessionDualWriteBridge,
  createSessionEventBus,
  createSessionEventStore,
  createSessionService,
  createSubprocessRegistry,
  createWorkflowEngine,
  DshCapabilityError,
  DshHostNodeError,
  createWorkflowJobExecutor,
  createWorktreeManager,
  createWriteQueue,
  migrateDatabase,
  type AuditLogger,
  type DurableJobRunner,
  type JobRepository,
  type JobStatus,
  type SessionEventBus,
  type SessionEventStore,
  type SessionService,
  type SubprocessRegistry,
  type TekonDatabase,
  type TekonRepositories,
  type RunPlan,
  type WorkflowEngine,
} from '@tekon/core';

import {
  createAgentAdapter,
  type ProviderRuntimeOverrides,
} from './agent-factory.js';
import type { CliIO } from './context.js';
import { ensureInitialized, openProjectDb } from './context.js';
import { selectLatestRunId } from './db-helpers.js';
import { resolveProjectRepoPath } from './path-utils.js';
import { runDshPreflight } from '../commands/provider.js';
import { getBuiltInRolesDir } from './utils.js';

/**
 * 4c (design §4.1): CLI session composition root. Mirrors the web composition
 * root (packages/web/src/server/api/root.ts) assembly order: write queue →
 * repositories/audit → sessionEventStore/jobRepository/bus/registry →
 * dual-write bridge → workflow job executor → job runner → SessionService.
 *
 * The CLI embeds the job runner so `tekon run`/`tekon resume` await the job's
 * terminal state before exiting ("跑完即退出" semantics preserved) and so
 * pause/cancel governance requests land through the same Session API as web.
 */

/** Per-run knobs for the CLI run-engine factory (opaque to SessionService). */
export interface CliRunEngineInput {
  agent: string;
  allowDirtyBase: boolean;
  runtime?: ProviderRuntimeOverrides;
  canonicalPlan?: RunPlan;
  planDigest?: string;
  planSnapshot?: string;
}

export interface CliSessionContext {
  db: TekonDatabase;
  /** Dual-write wrapped repositories (engine/executor emit session events). */
  repositories: TekonRepositories;
  /** Dual-write wrapped audit logger. */
  audit: AuditLogger;
  sessions: SessionEventStore;
  jobs: JobRepository;
  bus: SessionEventBus;
  registry: SubprocessRegistry;
  jobRunner: DurableJobRunner;
  sessionService: SessionService<CliRunEngineInput>;
}

/**
 * CLI run-engine factory injected into SessionService. Used ONLY for
 * prepareRun (the job executor rebuilds its own engine from the persisted
 * provider snapshot). S10: builtInRolesDir is required so the goal role
 * (roles/goal/) loads in CLI runs.
 */
function createCliRunEngineFactory(deps: {
  projectRoot: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  registry: SubprocessRegistry;
}): (input: CliRunEngineInput) => WorkflowEngine {
  return (input) => {
    const gateway = createCommandGateway({
      repositories: deps.repositories,
    });
    const agentRuntime = createAgentAdapter({
      agent: input.agent,
      repoPath: deps.projectRoot,
      gateway,
      runtime: input.runtime,
    });
    return createWorkflowEngine({
      repoPath: deps.projectRoot,
      dataDir: '.tekon',
      repositories: deps.repositories,
      audit: deps.audit,
      adapter: agentRuntime.adapter,
      agentProvider: agentRuntime.provider,
      agentConfigSummary: agentRuntime.configSummary,
      profile: 'cli',
      timeoutMs: input.runtime?.timeoutMs,
      noProgressTimeoutMs: input.runtime?.noProgressTimeoutMs,
      progressHeartbeatMs: input.runtime?.progressHeartbeatMs,
      allowDirtyBase: input.allowDirtyBase,
      canonicalPlan: input.canonicalPlan,
      planDigest: input.planDigest,
      planSnapshot: input.planSnapshot,
      registry: deps.registry,
      gateEngine: createGateEngine({
        repositories: deps.repositories,
        gateway,
      }),
      worktreeManager: createWorktreeManager({
        repositories: deps.repositories,
        gateway,
      }),
      builtInRolesDir: getBuiltInRolesDir(),
    });
  };
}

export async function withCliSessionContext<T>(
  repoPath: string,
  io: CliIO,
  fn: (ctx: CliSessionContext) => Promise<T>,
): Promise<T> {
  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);

    // One shared write queue serializes legacy tables, session_events, jobs,
    // and the audit hash chain (mirrors web root.ts).
    const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
    const repositories = createRepositories(db, writeQueue);
    await repositories.admissionStore.scanAndRecoverAdmissions();
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus({
      // S3: safety net for an unexpected synchronous throw in a listener (every
      // listener self-catches, but a bug that escapes must surface, not be
      // swallowed by per-listener isolation).
      onError: (error) => {
        io.stderr.write(
          `[session bus] listener error: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      },
    });
    const registry = createSubprocessRegistry();

    // Dual-write: engine/executor writes transparently emit session events
    // (best-effort; the hash chain and legacy tables are unchanged).
    const bridge = createSessionDualWriteBridge({
      sessions,
      bus,
      onError: (error) => {
        io.stderr.write(
          `[session dual-write] 事件投影失败: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      },
    });
    const dualRepositories =
      createDualWriteRepositories(repositories, bridge);
    const dualAudit = createDualWriteAuditLogger(audit, bridge);

    // 4e (review M1): CLI is run-to-exit and never *enqueues* automation kinds
    // (delivery-auto-prepare / readiness-evaluate are long-lived-server
    // features, wired only in web/headless — design §1.4/§2.2), and it does NOT
    // install the auto-prepare/readiness listeners. BUT the jobs table is shared
    // across processes: a web-enqueued automation job left `queued` (server
    // stopped before draining) will be claimed by the CLI runner's poll
    // (claimNext has no kind filter). Routing it through the automation executor
    // keeps that stray job isolated (idempotent, never touches session/run
    // terminal state); the plain workflow executor would set session 'active'
    // before its kind switch, throw on the unknown kind, and flip the session to
    // 'failed' — polluting an already-`passed` run's session cross-process.
    // Autonomous delivery from CLI still stays explicit via `tekon delivery
    // prepare`; routing only defends against inherited jobs.
    const executor = createWorkflowJobExecutor({
      repositories: dualRepositories,
      audit: dualAudit,
      projectContext: { projectRoot: repoPath },
      sessions,
      bus,
      registry,
      agentEventSink: bridge,
    });
    const automationExecutor = createAutomationJobExecutor({
      repositories: dualRepositories,
      audit: dualAudit,
      sessions,
      bus,
      projectRoot: repoPath,
    });
    const jobRunner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: createRoutingJobExecutor({
        workflow: executor,
        automation: automationExecutor,
      }),
      workerId: `cli-${process.pid}-${randomUUID().slice(0, 8)}`,
    });

    let activeAgent: string | undefined;
    const engineFactory = createCliRunEngineFactory({
      projectRoot: repoPath,
      repositories: dualRepositories,
      audit: dualAudit,
      registry,
    });
    const sessionService = createSessionService<CliRunEngineInput>({
      sessions,
      jobs,
      jobRunner,
      bus,
      repositories: dualRepositories,
      audit: dualAudit,
      projectRoot: repoPath,
      // Design §8 decision 2: CLI-created sessions are labeled 'cli'.
      sessionProfile: 'cli',
      createEngine: (input: CliRunEngineInput) => {
        activeAgent = input?.agent;
        return engineFactory(input);
      },
      preflight: async () => {
        if (activeAgent === 'dsh-headless') {
          const preflight = await runDshPreflight({
            onWarn: (msg) => {
              io.stderr.write(`${msg}\n`);
            },
          });
          if (!preflight.compatible) {
            if (preflight.failureKind === 'host-node') {
              throw new DshHostNodeError(preflight.hostNodeVersion);
            }
            throw new DshCapabilityError(
              preflight.error ??
                `dsh-headless 环境预检未通过 (tested: ${preflight.testedVersion}, actual: ${preflight.actualVersion ?? '未安装'})。` +
                `请根据安装指引安装兼容版本: ${preflight.installHint}`,
            );
          }
        }
      },
    });

    try {
      return await fn({
        db,
        repositories: dualRepositories,
        audit: dualAudit,
        sessions,
        jobs,
        bus,
        registry,
        jobRunner,
        sessionService,
      });
    } finally {
      // Wait for in-flight jobs to settle (5s cap) before closing the db, so
      // no job writes to a closed handle.
      await jobRunner.stop();
    }
  } finally {
    // P0-ARCH-02 增量：与 Web 关停序列一致，关闭前置位 closed 栅栏，
    // 拒绝 deadline 后迟到的 repository/db 写入。
    db.markClosed();
    db.close();
  }
}

/**
 * 4c §4.2 (S4): poll the job row until it reaches a terminal status. The jobs
 * table is the source of truth; bus notifications are best-effort and can
 * only accelerate, never decide.
 *
 * M2 (design §4.3): while waiting, the holder (this process) observes its own
 * job row for cross-process governance requests and relays them through the
 * runner's in-process APIs:
 * - `cancelling` → requestCancel (idempotent: aborts the in-process
 *   controller and kills this process's subprocesses via registry.killAll).
 * - `paused` → requestPause (sets the in-memory pause flag ONLY — never
 *   abort, since the engine checks signal.aborted BEFORE isPauseRequested at
 *   node boundaries; aborting would settle the run cancelled instead of
 *   paused).
 */
export async function awaitJobTerminal(input: {
  jobs: JobRepository;
  jobRunner: DurableJobRunner;
  jobId: string;
  pollIntervalMs?: number;
}): Promise<JobStatus> {
  const interval = input.pollIntervalMs ?? 200;
  for (;;) {
    const job = await input.jobs.get(input.jobId);
    if (!job) {
      throw new Error(`job not found: ${input.jobId}`);
    }
    if (
      job.status === 'done' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return job.status;
    }
    if (job.status === 'cancelling') {
      await input.jobRunner
        .requestCancel(input.jobId, 'observed cross-process cancel')
        .catch(() => {});
    } else if (job.status === 'paused') {
      await input.jobRunner.requestPause(input.jobId).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Exit code for a workflow terminal status: failures and cancellation are
 * non-zero; passed/paused/blocked complete successfully (a paused run awaits
 * human approval, it is not a failure).
 */
export function exitCodeForWorkflowStatus(status: string): number {
  return ['failed', 'cancelled', 'interrupted'].includes(status) ? 1 : 0;
}

/**
 * Parse `--repo` / `--run-id` (same resolution rules as withCommandCtx) but
 * provide the session composition root, for the pause/cancel governance
 * commands.
 */
export async function withSessionCommandCtx<T>(
  argv: string[],
  io: CliIO,
  fn: (
    ctx: CliSessionContext & { repoPath: string; runId: string },
  ) => Promise<T>,
): Promise<T> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  return withCliSessionContext(repoPath, io, async (ctx) => {
    const runId =
      args.values['run-id'] ??
      args.positionals[0] ??
      selectLatestRunId(ctx.db);
    if (!runId) {
      throw new Error(
        '无法推断运行 ID，请使用 --run-id <runId> 指定',
      );
    }
    return fn({ ...ctx, repoPath, runId });
  });
}
