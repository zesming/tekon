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
# Session identity and run-execution job semantics.
# ---------------------------------------------------------------------------

STORE = "packages/core/src/session/session-store.ts"

replace_once(
    STORE,
    """} from '../types/session-contract.js';\n\n/**\n * `jobs.payload` is a runner implementation detail and intentionally outside\n""",
    """} from '../types/session-contract.js';\n\n/** Jobs that drive a workflow/goal and therefore share run controls. */\nconst RUN_EXECUTION_JOB_KINDS = new Set<string>([\n  'workflow-run',\n  'workflow-resume',\n  'goal-run',\n]);\n\n/**\n * `jobs.payload` is a runner implementation detail and intentionally outside\n""",
)

regex_replace_once(
    STORE,
    r"    async getOrCreateDefaultWorkspace\(root\) \{.*?\n    \},\n\n    async createSession\(input\) \{.*?\n    \},\n\n    async getSession",
    """    async getOrCreateDefaultWorkspace(root) {\n      return writeQueue.enqueue(() => {\n        // Web and CLI open independent SQLite connections. Acquire the writer\n        // lock before the lookup so first use from two processes converges on\n        // one canonical workspace instead of creating split session lists.\n        const tx = db.transaction(() => {\n          const existing = db\n            .prepare(\n              `select * from workspaces\n               where root = ?\n               order by created_at asc, rowid asc\n               limit 1`,\n            )\n            .get(root) as WorkspaceRow | undefined;\n          if (existing) {\n            return mapWorkspace(existing);\n          }\n          const workspace = workspaceSchema.parse({\n            id: `ws_${randomUUID()}`,\n            root,\n            repo: null,\n            branchPolicy: null,\n            permissionProfile: null,\n            createdAt: now(),\n          });\n          db.prepare(\n            `insert into workspaces (id, root, repo, branch_policy, permission_profile, created_at)\n             values (@id, @root, @repo, @branchPolicy, @permissionProfile, @createdAt)`,\n          ).run({\n            ...workspace,\n            repo: workspace.repo ?? null,\n            branchPolicy: workspace.branchPolicy ?? null,\n            permissionProfile: workspace.permissionProfile ?? null,\n          });\n          return workspace;\n        });\n        return tx.immediate();\n      });\n    },\n\n    async createSession(input) {\n      return writeQueue.enqueue(() => {\n        // A run has one canonical Session. This is an idempotent get-or-create\n        // under the same cross-process writer lock used by event seq allocation.\n        const tx = db.transaction(() => {\n          if (input.runId) {\n            const existing = db\n              .prepare(\n                `select * from sessions\n                 where run_id = ?\n                 order by created_at asc, rowid asc\n                 limit 1`,\n              )\n              .get(input.runId) as SessionRow | undefined;\n            if (existing) {\n              return mapSession(existing);\n            }\n          }\n\n          const createdAt = now();\n          const session = sessionSchema.parse({\n            id: `sess_${randomUUID()}`,\n            workspaceId: input.workspaceId,\n            title: input.title,\n            profile: input.profile,\n            status: 'active',\n            createdAt,\n            updatedAt: createdAt,\n          });\n          db.prepare(\n            `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)\n             values (@id, @workspaceId, @title, @profile, @status, @runId, @createdAt, @updatedAt)`,\n          ).run({\n            ...session,\n            title: session.title ?? null,\n            runId: input.runId ?? null,\n          });\n          return session;\n        });\n        return tx.immediate();\n      });\n    },\n\n    async getSession""",
)

replace_once(
    STORE,
    """          'select * from sessions where run_id = ? order by created_at desc limit 1',\n""",
    """          `select * from sessions\n           where run_id = ?\n           order by created_at asc, rowid asc\n           limit 1`,\n""",
)

regex_replace_once(
    STORE,
    r"    async enqueueIfNoActiveByRunId\(runId, job\) \{.*?\n    \},\n\n    async get\(jobId\)",
    """    async enqueueIfNoActiveByRunId(runId, job) {\n      const parsed = jobSchema.parse(job);\n      if (!RUN_EXECUTION_JOB_KINDS.has(parsed.kind)) {\n        throw new Error(\n          `enqueueIfNoActiveByRunId only accepts run-execution jobs, got: ${parsed.kind}`,\n        );\n      }\n      const payload = JSON.stringify(job.payload ?? {});\n      return writeQueue.enqueue(() => {\n        // BEGIN IMMEDIATE acquires the database writer lock BEFORE the\n        // active-job check, so a concurrent resume on another connection cannot\n        // slip its INSERT between our check and our INSERT. Automation jobs are\n        // deliberately excluded: readiness/delivery projection work must not\n        // block or receive pause/cancel controls intended for the live workflow.\n        const tx = db.transaction(() => {\n          const binding = db\n            .prepare('select run_id from sessions where id = ?')\n            .get(parsed.sessionId) as\n            | { run_id: string | null }\n            | undefined;\n          if (!binding) {\n            throw new Error(`session not found: ${parsed.sessionId}`);\n          }\n          if (binding.run_id !== runId) {\n            throw new Error(\n              `session ${parsed.sessionId} is bound to ${binding.run_id ?? 'no run'}, not ${runId}`,\n            );\n          }\n\n          const existing = db\n            .prepare(\n              `select j.* from jobs j\n               join sessions s on s.id = j.session_id\n               where s.run_id = @runId\n                 and j.kind in ('workflow-run', 'workflow-resume', 'goal-run')\n                 and j.status in ('queued', 'running', 'paused', 'cancelling')\n               order by j.created_at desc, j.id desc\n               limit 1`,\n            )\n            .get({ runId }) as JobRow | undefined;\n          if (existing) {\n            return { outcome: 'active-job' as const, job: mapJob(existing) };\n          }\n          db.prepare(\n            `insert into jobs (\n               id, session_id, kind, status, owner, lease, abort_state,\n               checkpoint, payload, created_at, updated_at\n             ) values (\n               @id, @sessionId, @kind, @status, @owner, @lease, @abortState,\n               @checkpoint, @payload, @createdAt, @updatedAt\n             )`,\n          ).run({\n            ...parsed,\n            owner: parsed.owner ?? null,\n            lease: parsed.lease ?? null,\n            checkpoint: parsed.checkpoint ?? null,\n            payload,\n          });\n          return { outcome: 'enqueued' as const, job: parsed };\n        });\n        return tx.immediate();\n      });\n    },\n\n    async get(jobId)""",
)

regex_replace_once(
    STORE,
    r"    async findActiveByRunId\(runId\) \{.*?\n    \},\n\n    async cancelStaleActiveJobs",
    """    async findActiveByRunId(runId) {\n      const row = db\n        .prepare(\n          `select j.* from jobs j\n           join sessions s on s.id = j.session_id\n           where s.run_id = ?\n             and j.kind in ('workflow-run', 'workflow-resume', 'goal-run')\n             and j.status in ('queued', 'running', 'paused', 'cancelling')\n           order by j.created_at desc, j.id desc\n           limit 1`,\n        )\n        .get(runId) as JobRow | undefined;\n      return row ? mapJob(row) : null;\n    },\n\n    async cancelStaleActiveJobs""",
)

replace_once(
    STORE,
    """             where session_id in (select id from sessions where run_id = @runId)\n               and (\n                 (status = 'queued' and created_at < @cutoff)\n""",
    """             where session_id in (select id from sessions where run_id = @runId)\n               and kind in ('workflow-run', 'workflow-resume', 'goal-run')\n               and (\n                 (status = 'queued' and created_at < @cutoff)\n""",
)

# Make the public contract explicit: this guard is for run-driving jobs, not
# projection/automation work that may legitimately overlap a workflow.
replace_once(
    "packages/core/src/types/session-contract.ts",
    """   * F5-P0-01: atomically enqueue a job for `runId` only if that run has no\n   * active job. Collapses the resume-path find-active + enqueue into one\n""",
    """   * F5-P0-01/F6: atomically enqueue a run-execution job for `runId` only\n   * if that run has no active run-execution job. Automation/projection jobs are\n   * a separate control domain and do not block pause/resume/cancel. Collapses\n   * the resume-path find-active + enqueue into one\n""",
)

# gate.approve may lose the enqueue race to a job already bound to a different
# historical Session. Return the authoritative job's Session, not the local
# candidate, so the client follows the actual execution stream.
replace_once(
    "packages/web/src/server/api/routers/gate.ts",
    """    return {\n      ...mappedDecision,\n      sessionId: session.id,\n      jobId: enqueued.job.id,\n    };\n""",
    """    return {\n      ...mappedDecision,\n      sessionId: enqueued.job.sessionId,\n      jobId: enqueued.job.id,\n    };\n""",
)

# ---------------------------------------------------------------------------
# Core regression tests.
# ---------------------------------------------------------------------------

TEST = "packages/core/__tests__/session/session-store.test.ts"

replace_once(
    TEST,
    """    expect(other.id).not.toBe(first.id);\n    expect(other.root).toBe('/repo/b');\n  });\n\n  it('upserts projection checkpoints', async () => {\n""",
    """    expect(other.id).not.toBe(first.id);\n    expect(other.root).toBe('/repo/b');\n  });\n\n  it('converges default workspace creation across independent connections', async () => {\n    const dir = mkdtempSync(join(tmpdir(), 'tekon-workspace-race-'));\n    tempDirs.push(dir);\n    const filename = join(dir, 'tekon.sqlite');\n    const dbA = openTekonDatabase({ filename });\n    const dbB = openTekonDatabase({ filename });\n    try {\n      migrateDatabase(dbA);\n      migrateDatabase(dbB);\n      const storeA = createSessionEventStore(dbA, createWriteQueue());\n      const storeB = createSessionEventStore(dbB, createWriteQueue());\n\n      const [a, b] = await Promise.all([\n        storeA.getOrCreateDefaultWorkspace(dir),\n        storeB.getOrCreateDefaultWorkspace(dir),\n      ]);\n\n      expect(a.id).toBe(b.id);\n      const count = dbA\n        .prepare('select count(*) as n from workspaces where root = ?')\n        .get(dir) as { n: number };\n      expect(count.n).toBe(1);\n    } finally {\n      dbA.close();\n      dbB.close();\n    }\n  });\n\n  it('converges one canonical run session across independent connections', async () => {\n    const dir = mkdtempSync(join(tmpdir(), 'tekon-session-race-'));\n    tempDirs.push(dir);\n    const filename = join(dir, 'tekon.sqlite');\n    const dbA = openTekonDatabase({ filename });\n    const dbB = openTekonDatabase({ filename });\n    try {\n      migrateDatabase(dbA);\n      migrateDatabase(dbB);\n      const storeA = createSessionEventStore(dbA, createWriteQueue());\n      const storeB = createSessionEventStore(dbB, createWriteQueue());\n      const workspace = await storeA.getOrCreateDefaultWorkspace(dir);\n\n      const [a, b] = await Promise.all([\n        storeA.createSession({\n          workspaceId: workspace.id,\n          title: 'first candidate',\n          profile: 'human-web',\n          runId: 'run_same',\n        }),\n        storeB.createSession({\n          workspaceId: workspace.id,\n          title: 'second candidate',\n          profile: 'human-web',\n          runId: 'run_same',\n        }),\n      ]);\n\n      expect(a.id).toBe(b.id);\n      const count = dbA\n        .prepare('select count(*) as n from sessions where run_id = ?')\n        .get('run_same') as { n: number };\n      expect(count.n).toBe(1);\n    } finally {\n      dbA.close();\n      dbB.close();\n    }\n  });\n\n  it('upserts projection checkpoints', async () => {\n""",
)

replace_once(
    TEST,
    """  it('enqueueIfNoActiveByRunId enqueues when the run has no active job, and rejects when one exists', async () => {\n""",
    """  it('keeps automation jobs outside run execution controls and resume exclusion', async () => {\n    const { sessions, jobs } = setupStore();\n    const { session } = await seedSession(sessions);\n\n    await jobs.enqueue(\n      makeJob(session.id, {\n        id: 'job_readiness',\n        kind: 'readiness-evaluate',\n        status: 'queued',\n        createdAt: '2020-01-01T00:00:00.000Z',\n        updatedAt: '2020-01-01T00:00:00.000Z',\n      }),\n    );\n\n    // A readiness projection is not the live workflow: it must not receive\n    // run pause/cancel, block resume, or be reclaimed as a stale run job.\n    expect(await jobs.findActiveByRunId('run_1')).toBeNull();\n    expect(await jobs.cancelStaleActiveJobs('run_1')).toBe(0);\n    expect(await jobs.get('job_readiness')).toMatchObject({ status: 'queued' });\n\n    const resumed = await jobs.enqueueIfNoActiveByRunId(\n      'run_1',\n      makeJob(session.id, { id: 'job_resume', kind: 'workflow-resume' }),\n    );\n    expect(resumed.outcome).toBe('enqueued');\n    expect(await jobs.findActiveByRunId('run_1')).toMatchObject({\n      id: 'job_resume',\n      kind: 'workflow-resume',\n    });\n  });\n\n  it('rejects an atomic enqueue whose Session is missing or bound to another run', async () => {\n    const { sessions, jobs } = setupStore();\n    const { workspace } = await seedSession(sessions);\n    const other = await sessions.createSession({\n      workspaceId: workspace.id,\n      title: 'other run',\n      profile: 'human-web',\n      runId: 'run_other',\n    });\n\n    await expect(\n      jobs.enqueueIfNoActiveByRunId(\n        'run_1',\n        makeJob(other.id, { id: 'job_wrong_binding', kind: 'workflow-resume' }),\n      ),\n    ).rejects.toThrow(/bound to run_other/u);\n\n    await expect(\n      jobs.enqueueIfNoActiveByRunId(\n        'run_1',\n        makeJob('sess_missing', {\n          id: 'job_missing_session',\n          kind: 'workflow-resume',\n        }),\n      ),\n    ).rejects.toThrow(/session not found/u);\n  });\n\n  it('rejects automation kinds at the run-execution-only atomic enqueue boundary', async () => {\n    const { sessions, jobs } = setupStore();\n    const { session } = await seedSession(sessions);\n\n    await expect(\n      jobs.enqueueIfNoActiveByRunId(\n        'run_1',\n        makeJob(session.id, {\n          id: 'job_wrong_kind',\n          kind: 'readiness-evaluate',\n        }),\n      ),\n    ).rejects.toThrow(/only accepts run-execution jobs/u);\n  });\n\n  it('enqueueIfNoActiveByRunId enqueues when the run has no active job, and rejects when one exists', async () => {\n""",
)

# ---------------------------------------------------------------------------
# Human-facing wording, controls, and event narration.
# ---------------------------------------------------------------------------

replace_once(
    "packages/web/src/client/layouts/Sidebar.tsx",
    """        label: '会话 Sessions',\n""",
    """        label: '受控交付',\n""",
)

TOPBAR = "packages/web/src/client/layouts/TopBar.tsx"
replace_once(
    TOPBAR,
    """import { useState } from 'react';\n\nimport { useSessionToken } from '../hooks/use-session-token.js';\n""",
    """import { useState } from 'react';\nimport { useLocation } from 'react-router';\n\nimport { useSessionToken } from '../hooks/use-session-token.js';\n""",
)
replace_once(
    TOPBAR,
    """export function TopBar(props: TopBarProps) {\n  const { title = 'Tekon Cockpit', subtitle } = props;\n  const { token, setToken } = useSessionToken();\n""",
    """export function TopBar(props: TopBarProps) {\n  const { pathname } = useLocation();\n  const defaultTitle = pathname.startsWith('/advanced')\n    ? 'Tekon Cockpit'\n    : 'Tekon Workspace';\n  const { title = defaultTitle, subtitle } = props;\n  const { token, setToken } = useSessionToken();\n""",
)
replace_once(
    TOPBAR,
    """        <button\n          type=\"button\"\n          className=\"btn btn-ghost btn-sm\"\n          onClick={() => setMasked((prev) => !prev)}\n        >\n""",
    """        <button\n          type=\"button\"\n          className=\"btn btn-ghost btn-sm\"\n          title={masked ? '显示会话令牌' : '隐藏会话令牌'}\n          aria-label={masked ? '显示会话令牌' : '隐藏会话令牌'}\n          aria-pressed={!masked}\n          onClick={() => setMasked((prev) => !prev)}\n        >\n""",
)

SESSIONS = "packages/web/src/client/pages/SessionsPage.tsx"
replace_once(
    SESSIONS,
    """// Phase 3 3b: Session List + composer. The human-first entry point — sessions\n// are the main axis (workspace/session/message), replacing run-centric reads.\n""",
    """// Phase 3 3b: controlled-delivery list + composer. Until Collaborate and\n// follow-up exist, this page names the product behavior honestly rather than\n// presenting a full workflow launch as a chat session.\n""",
)
replace_once(
    SESSIONS,
    """          <h1 className=\"page-title\">会话 Sessions</h1>\n          <p className=\"page-subtitle\">\n            以会话为主轴查看 Agent 交付 · a continuous, replayable narrative\n          </p>\n""",
    """          <h1 className=\"page-title\">受控交付</h1>\n          <p className=\"page-subtitle\">\n            发起并跟踪完整研发交付，查看执行过程、审批与结果\n          </p>\n""",
)
replace_once(
    SESSIONS,
    """          {/* Workspace picker placeholder: today there is exactly one (the\n              default) workspace, so this is a read-only indicator rather than a\n              selector. Multi-workspace management is deferred to a later phase;\n              session.list already returns the workspaceId this shows. */}\n          {workspaceId ? (\n            <label\n              className=\"workspace-picker\"\n              title=\"当前工作区（暂只支持默认工作区）\"\n            >\n              <span className=\"workspace-picker-label\">工作区</span>\n              <select\n                className=\"workspace-picker-select\"\n                value={workspaceId}\n                disabled\n                aria-label=\"工作区 Workspace\"\n              >\n                <option value={workspaceId}>当前项目</option>\n              </select>\n            </label>\n          ) : null}\n""",
    """          {/* There is one workspace today. Render it as information, not a\n              disabled selector that suggests a choice the product cannot make. */}\n          {workspaceId ? (\n            <div\n              className=\"workspace-picker\"\n              role=\"group\"\n              aria-label=\"当前工作区\"\n              title=\"暂只支持当前项目\"\n            >\n              <span className=\"workspace-picker-label\">工作区</span>\n              <span className=\"workspace-picker-value\">当前项目</span>\n            </div>\n          ) : null}\n""",
)
replace_once(
    SESSIONS,
    """          message=\"还没有会话\"\n          hint=\"使用上方输入框描述需求，开始你的第一个会话。\"\n""",
    """          message=\"还没有交付任务\"\n          hint=\"使用上方输入框描述需求，启动第一个受控交付。\"\n""",
)

replace_once(
    "packages/web/src/client/styles/sessions.css",
    """.workspace-picker-select {\n  font-size: 12px;\n  padding: 2px 6px;\n  border-radius: 6px;\n  border: 1px solid var(--border, #334155);\n  background: var(--surface, #1e293b);\n  color: var(--text, #e2e8f0);\n  cursor: not-allowed;\n}\n""",
    """.workspace-picker-value {\n  font-size: 12px;\n  padding: 3px 8px;\n  border-radius: 999px;\n  border: 1px solid var(--border, #cbd5e1);\n  background: var(--surface-2, #f8fafc);\n  color: var(--text-s, #475569);\n}\n""",
)

FEED = "packages/web/src/client/lib/event-feed.ts"
replace_once(
    FEED,
    """    case 'agent/steered':\n      // NOTE: agent/steered is declared in the session contract but has no\n      // emitter yet — the payload field name (text/message/guidance) is a\n      // forward-looking guess. asText degrades to an empty body if none match;\n      // revisit when a steer path actually emits this event.\n      return {\n        ...base,\n        kind: 'message',\n        author: 'user',\n        title: '你 You · 转向',\n        body: asText(p, 'text', 'message', 'guidance') ?? '',\n      };\n    case 'gate/result': {\n""",
    """    case 'agent/steered':\n      // NOTE: agent/steered is declared in the session contract but has no\n      // emitter yet — the payload field name (text/message/guidance) is a\n      // forward-looking guess. asText degrades to an empty body if none match;\n      // revisit when a steer path actually emits this event.\n      return {\n        ...base,\n        kind: 'message',\n        author: 'user',\n        title: '你 You · 转向',\n        body: asText(p, 'text', 'message', 'guidance') ?? '',\n      };\n    case 'job/status': {\n      const kind = asText(p, 'kind') ?? 'job';\n      const status = asText(p, 'status') ?? 'updated';\n      const label =\n        kind === 'readiness-evaluate'\n          ? '准备度检查'\n          : kind === 'delivery-auto-prepare'\n            ? '交付材料准备'\n            : '执行任务';\n      return {\n        ...base,\n        kind: 'governance',\n        title: `${label} · ${status}`,\n      };\n    }\n    case 'readiness/evaluated': {\n      const result =\n        p.ready === true ? '通过' : p.ready === false ? '未通过' : '已更新';\n      return {\n        ...base,\n        kind: 'governance',\n        title: `交付准备度 · ${result}`,\n      };\n    }\n    case 'delivery/prepared':\n      return { ...base, kind: 'governance', title: '交付材料已准备' };\n    case 'gate/result': {\n""",
)
replace_once(
    FEED,
    """    case 'workflow/node-started':\n    case 'workflow/node-ended':\n    case 'workflow/started': {\n      const nodeId = asText(p, 'nodeId');\n      const status = asText(p, 'status');\n      return {\n        ...base,\n        kind: 'governance',\n        title: `${event.type}${nodeId ? ` ${nodeId}` : ''}${status ? ` · ${status}` : ''}`,\n      };\n    }\n""",
    """    case 'workflow/node-started': {\n      const nodeId = asText(p, 'nodeId');\n      return {\n        ...base,\n        kind: 'governance',\n        title: nodeId ? `节点开始 · ${nodeId}` : '节点开始',\n      };\n    }\n    case 'workflow/node-ended': {\n      const nodeId = asText(p, 'nodeId');\n      const status = asText(p, 'status');\n      return {\n        ...base,\n        kind: 'governance',\n        title: `节点结束${nodeId ? ` · ${nodeId}` : ''}${status ? ` · ${status}` : ''}`,\n      };\n    }\n    case 'workflow/started':\n      return {\n        ...base,\n        kind: 'governance',\n        title: p.resumed === true ? '受控交付已恢复' : '受控交付已开始',\n      };\n""",
)

replace_once(
    "packages/web/__tests__/client/event-feed.test.ts",
    """  it('renders governance events (gate/artifact/approval/node) as governance rows', () => {\n""",
    """  it('renders job and automation lifecycle events as human-readable governance rows', () => {\n    const workflow = describeEvent(\n      ev('job/status', { kind: 'workflow-resume', status: 'running' }),\n    );\n    expect(workflow.kind).toBe('governance');\n    expect(workflow.title).toContain('执行任务');\n    expect(workflow.title).not.toBe('job/status');\n\n    const readiness = describeEvent(\n      ev('readiness/evaluated', { ready: true }),\n    );\n    expect(readiness.title).toContain('通过');\n    const delivery = describeEvent(ev('delivery/prepared'));\n    expect(delivery.title).toContain('交付材料');\n  });\n\n  it('renders governance events (gate/artifact/approval/node) as governance rows', () => {\n""",
)

E2E = "packages/web/__tests__/e2e/session-feed.test.ts"
replace_once(
    E2E,
    """  // Report item 1: the workspace picker placeholder renders the current\n  // (default) workspace as a read-only indicator.\n  await expect(page.getByLabel('工作区 Workspace')).toBeVisible({\n    timeout: 15_000,\n  });\n\n  const link = page.locator(`a[href=\"/sessions/${sessionId}\"]`);\n""",
    """  // The single workspace is information, not a disabled fake selector.\n  const workspace = page.getByRole('group', { name: '当前工作区' });\n  await expect(workspace).toBeVisible({ timeout: 15_000 });\n  await expect(workspace).toContainText('当前项目');\n  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible();\n  await expect(\n    page.getByRole('button', { name: '启动受控交付' }),\n  ).toBeVisible();\n  await expect(\n    page.getByRole('button', { name: '显示会话令牌' }),\n  ).toBeVisible();\n\n  const link = page.locator(`a[href=\"/sessions/${sessionId}\"]`);\n""",
)

replace_once(
    "README.md",
    """- **默认发起 = 受控交付全链路**：Web「开始会话」与 `tekon run`（默认 `standard-delivery`）会进入 PM/RD/QA/Reviewer 完整交付流程，而非轻量对话。轻量协作会话（Collaborate）为后续方向。\n""",
    """- **默认发起 = 受控交付全链路**：Web「启动受控交付」与 `tekon run`（默认 `standard-delivery`）会进入 PM/RD/QA/Reviewer 完整交付流程，而非轻量对话。轻量协作会话（Collaborate）为后续方向。\n""",
)

print('Applied sixth-review identity, job-control, and UX fixes.')
