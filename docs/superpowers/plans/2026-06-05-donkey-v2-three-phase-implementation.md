# Donkey V2 Three-Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务完成后必须启动最高思考等级 reviewer 复查；若检出阻断项，先修复再复查。

**Goal:** 在三个阶段内实现 Donkey V2 技术方案中的核心能力：安全可恢复的 Agent 执行内核、角色化 Workflow 编排、动态 Workflow、硬 Gate、Artifact/Audit、CLI/Web 驾驶舱、PR 交付和 dogfooding 验收。

**Architecture:** 采用 `pnpm` monorepo：`packages/core` 提供纯 TypeScript 领域模型、状态机、仓储、执行内核和编排 API；`packages/cli` 提供本地命令入口和 TUI；`packages/web` 提供本地只读优先、受控写操作的 Next.js 驾驶舱。核心执行路径按“持久化状态机 -> worktree 隔离 -> 权限受控子进程 -> Artifact Store -> Gate Engine -> Audit Logger”推进，避免把安全、恢复和审计能力后补。

**Tech Stack:** TypeScript, pnpm workspaces, tsup, Commander.js, Ink, Next.js App Router, tRPC, SQLite with `better-sqlite3`, Vitest, Playwright, Zod, js-yaml, Mustache, Git worktree, GitHub CLI, Claude Code headless mode, optional custom Agent command adapters.

**Release Readiness Note:** Vitest 已迁移到根 `vitest.config.ts` 的 `test.projects`，不再使用旧 workspace 配置文件。

---

## 0. 计划原则

### 0.1 三阶段边界

| 阶段                             | 目标                                                               | 可验收结果                                                                        | 不允许后移的能力                                                             |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 阶段一：安全可恢复内核           | 先把执行边界、持久化、worktree、Gate、Artifact/Audit 打实          | mock Agent 跑完最小 workflow；中断后可恢复；危险命令被拒绝；human gate 会暂停     | Tool Gateway、WorktreeManager、状态持久化、GateResult、Audit hash chain      |
| 阶段二：角色化 Workflow 产品闭环 | 实现角色文件系统、模板 workflow、动态 workflow、约束注入、完整 CLI | `donkey run` 可用模板或动态 spec 执行到本地证据包；`pause/resume/status/log` 可用 | Dynamic dry-run、Constraint mutation、角色技能/知识注入、autoFix repair node |
| 阶段三：交付与可观察产品面       | 实现 PR 交付、Web 驾驶舱、人工确认、指标、手册、dogfooding         | 能从需求到 PR URL 和证据包；Web 可审阅项目、产物、Gate 和审计；完成自举验收       | SCM Delivery、Web human approval、指标沉淀、HTML 用户手册                    |

### 0.2 外部资料依据

| 资料                                                                                            | 资料内容                                                                            | 对 Donkey 的判断依据                                                                               |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Git worktree 官方文档：`https://git-scm.com/docs/git-worktree`                                  | 一个 Git 仓库可支持多个 working tree，每个 worktree 是带独立元数据的工作目录        | Donkey 的并行 Agent 必须真实创建独立 worktree，不能把原仓库路径直接传给所有 Agent                  |
| Node.js child_process 官方文档：`https://nodejs.org/api/child_process.html`                     | `spawn` 管道容量有限，需要持续消费 stdout/stderr；同步 child process 会阻塞事件循环 | Agent Runner 和 Gate Runner 必须流式消费输出，Gate 不使用 `execSync(commandString)` 执行任意字符串 |
| SQLite WAL 官方文档：`https://sqlite.org/wal.html`                                              | WAL 支持读写并发，但仍要按 SQLite 的写入锁模型设计事务                              | Donkey 可以用 SQLite，但需要单写者队列、busy timeout、短事务和恢复索引                             |
| Claude Code permissions 文档：`https://code.claude.com/docs/en/agent-sdk/permissions`           | Agent 可通过 permission modes、hooks、allow/deny 规则控制工具使用                   | `tools.yaml` 不能只是 prompt 文本，必须编译成 Claude permission 配置或外层 gateway 规则            |
| OpenAI Codex approvals/security：`https://developers.openai.com/codex/agent-approvals-security` | Codex 安全运行依赖 sandbox、approval 和网络访问边界组合                             | Donkey 的 AgentAdapter 合约必须显式表达 sandbox/approval 能力，不把 provider 差异藏在 prompt 中    |
| pnpm workspace 文档：`https://pnpm.io/pnpm-workspace_yaml`                                      | `pnpm-workspace.yaml` 是 workspace 包发现的根配置                                   | V2 采用 pnpm workspace 管理 core/cli/web，根 lockfile 固化依赖                                     |
| tRPC Next.js App Router 文档：`https://trpc.io/docs/client/nextjs/app-router-setup`             | tRPC 在 App Router 下通过初始化 router/procedure 暴露端到端类型 API                 | Web 只通过 core API 和 tRPC 读写 SQLite 状态，避免复制业务逻辑                                     |
| GitHub CLI PR 文档：`https://cli.github.com/manual/gh_pr_create`                                | `gh pr create` 可从当前分支创建 PR，成功后输出 PR URL                               | PR 交付必须有显式 SCM Delivery 模块、认证检查和失败恢复，不放在 PMO prompt 里                      |

### 0.3 全局验收门槛

- 所有新模块先写 Vitest 单测，关键 CLI/Web 流程写 Playwright 或 CLI E2E。
- 每个 task 独立 commit；提交前运行该 task 的最小测试，阶段结束运行全量测试。
- 任何会修改文件、执行命令、push、创建 PR、删除 worktree 的动作必须经过 CommandGateway 或 HumanGate。
- `.donkey/` 中不可提交的运行产物必须把关键 run id、Gate 结果、PR URL、评估摘要写入 `docs/reviews/` 或可提交报告。
- 正式交付文档必须同时提供 Markdown 源稿和 HTML 审阅版。

---

## 1. File Structure

```text
donkey/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── constraints.yaml
├── roles/
│   ├── pm/
│   ├── rd/
│   ├── qa/
│   ├── reviewer/
│   └── pmo/
├── workflows/
│   ├── standard-feature.yaml
│   └── bugfix.yaml
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types/
│   │   │   │   ├── domain.ts
│   │   │   │   ├── config.ts
│   │   │   │   └── events.ts
│   │   │   ├── db/
│   │   │   │   ├── connection.ts
│   │   │   │   ├── migrations.ts
│   │   │   │   ├── repositories.ts
│   │   │   │   └── write-queue.ts
│   │   │   ├── audit/
│   │   │   │   └── logger.ts
│   │   │   ├── artifact/
│   │   │   │   ├── store.ts
│   │   │   │   └── schemas.ts
│   │   │   ├── runtime/
│   │   │   │   ├── command-gateway.ts
│   │   │   │   ├── worktree-manager.ts
│   │   │   │   ├── agent-adapter.ts
│   │   │   │   ├── claude-code-adapter.ts
│   │   │   │   └── mock-agent-adapter.ts
│   │   │   ├── gate/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── runners.ts
│   │   │   │   └── human-gate.ts
│   │   │   ├── role/
│   │   │   │   ├── loader.ts
│   │   │   │   ├── skill-loader.ts
│   │   │   │   ├── tool-policy.ts
│   │   │   │   └── prompt-builder.ts
│   │   │   ├── workflow/
│   │   │   │   ├── template.ts
│   │   │   │   ├── dynamic.ts
│   │   │   │   ├── state-machine.ts
│   │   │   │   ├── scheduler.ts
│   │   │   │   └── engine.ts
│   │   │   ├── constraint/
│   │   │   │   └── validator.ts
│   │   │   └── delivery/
│   │   │       ├── scm.ts
│   │   │       └── evidence.ts
│   │   └── __tests__/
│   ├── cli/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   └── ui/
│   │   └── __tests__/
│   └── web/
│       ├── src/app/
│       ├── src/server/api/
│       └── src/components/
└── docs/
    ├── manual/
    ├── reviews/
    └── superpowers/plans/
```

---

## 2. 阶段一：安全可恢复内核

**阶段目标：** 先实现一个不依赖真实 LLM 的安全执行内核。完成后，mock Agent 可以在独立 worktree 中产出 artifact，状态写入 SQLite，Gate 会真实执行，human gate 会暂停，审计日志可追溯。

**阶段验收命令：**

```bash
pnpm install
pnpm --filter @donkey/core test -- --run
pnpm --filter @donkey/core build
pnpm --filter @donkey/core test:e2e -- --run
```

### Task 1: Monorepo and Test Harness

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/__tests__/smoke.test.ts`

- [ ] **Step 1: Write smoke test**  
       `packages/core/__tests__/smoke.test.ts` asserts that `@donkey/core` exports `DONKEY_CORE_VERSION`.

- [ ] **Step 2: Create workspace files**  
       Root scripts must include `build`, `test`, `lint`, `typecheck`, `format:check`. `pnpm-workspace.yaml` includes only `packages/*`; root Vitest config uses `test.projects` for `packages/*`.

- [ ] **Step 3: Implement minimal core export**  
       `packages/core/src/index.ts` exports `DONKEY_CORE_VERSION = '0.1.0'`.

- [ ] **Step 4: Verify**  
       Run `pnpm install`, `pnpm --filter @donkey/core test -- --run`, `pnpm --filter @donkey/core build`.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): scaffold monorepo and test harness"`

### Task 2: Domain Types and Runtime Config

**Files:**

- Create: `packages/core/src/types/domain.ts`
- Create: `packages/core/src/types/config.ts`
- Create: `packages/core/src/types/events.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/__tests__/types/domain.test.ts`
- Create: `packages/core/__tests__/types/config.test.ts`

- [ ] **Step 1: Define domain model**  
       Include `Demand`, `Project`, `WorkflowInstance`, `Phase`, `Node`, `RoleRun`, `Artifact`, `ArtifactRef`, `GateConfig`, `GateResult`, `AuditEvent`, `HumanDecision`, `RunSummary`.

- [ ] **Step 2: Define provider/runtime model**  
       Include `AgentAdapterConfig`, `PermissionProfile`, `CommandPolicy`, `ToolPolicy`, `WorktreeLease`, `RunContext`.

- [ ] **Step 3: Add Zod schemas for external inputs**  
       Validate `donkey.config.yaml`, `agent.yaml`, workflow YAML, dynamic workflow spec, constraint rules.

- [ ] **Step 4: Verify**  
       Type tests must prove all public types export from `@donkey/core`; schema tests must reject unknown gate types and unsafe command policy.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): define domain types and runtime config schemas"`

### Task 3: SQLite Persistence, Migrations, and Single Writer Queue

**Files:**

- Create: `packages/core/src/db/connection.ts`
- Create: `packages/core/src/db/migrations.ts`
- Create: `packages/core/src/db/repositories.ts`
- Create: `packages/core/src/db/write-queue.ts`
- Create: `packages/core/__tests__/db/migrations.test.ts`
- Create: `packages/core/__tests__/db/repositories.test.ts`
- Create: `packages/core/__tests__/db/recovery.test.ts`

- [ ] **Step 1: Write migration tests**  
       Tests assert all tables exist: `demands`, `projects`, `workflow_instances`, `phases`, `nodes`, `artifacts`, `role_runs`, `gate_results`, `human_decisions`, `audit_events`, `schema_migrations`, `run_locks`.

- [ ] **Step 2: Implement DB connection**  
       Use `better-sqlite3`, `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, and a process-local write queue for all writes.

- [ ] **Step 3: Implement repositories**  
       Repositories expose explicit methods such as `createProject`, `createWorkflowInstance`, `transitionNode`, `recordGateResult`, `appendAuditEvent`, `findRecoverableRun`.

- [ ] **Step 4: Implement recovery test**  
       Simulate `PM passed -> RD running -> process exit`; `findRecoverableRun` returns RD as the resume point and marks stale `running` role run as `interrupted`.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add durable sqlite persistence and recovery queue"`

### Task 4: Artifact Store and Append-Only Audit Logger

**Files:**

- Create: `packages/core/src/artifact/store.ts`
- Create: `packages/core/src/artifact/schemas.ts`
- Create: `packages/core/src/audit/logger.ts`
- Create: `packages/core/__tests__/artifact/store.test.ts`
- Create: `packages/core/__tests__/artifact/schemas.test.ts`
- Create: `packages/core/__tests__/audit/logger.test.ts`

- [ ] **Step 1: Implement artifact storage contract**  
       Artifacts are written under `.donkey/runs/<runId>/artifacts/<nodeId>/<artifactType>.v<version>.md` with metadata in SQLite.

- [ ] **Step 2: Implement schemas**  
       Provide Zod schemas for `demand-card`, `prd`, `tech-design`, `code-changes`, `test-report`, `review-report`, `security-report`, `rollback-plan`, `delivery-package`.

- [ ] **Step 3: Implement audit hash chain**  
       Each audit event includes `prevHash` and `hash`; logger is append-only from public API. Tests verify tampering breaks hash validation.

- [ ] **Step 4: Verify**  
       Artifact tests cover versioning, summary fallback, oversized artifact truncation for prompt injection, and missing file errors.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add artifact store and append-only audit log"`

### Task 5: CommandGateway and Safe Process Runner

**Files:**

- Create: `packages/core/src/runtime/command-gateway.ts`
- Create: `packages/core/src/gate/runners.ts`
- Create: `packages/core/__tests__/runtime/command-gateway.test.ts`
- Create: `packages/core/__tests__/gate/runners.test.ts`

- [ ] **Step 1: Define command policy model**  
       Commands are represented as `{ tool: 'git', args: ['status', '--short'] }`, not shell strings. Policy supports `allow`, `deny`, `requiresHumanApproval`, `cwdScope`, `network`.

- [ ] **Step 2: Implement argv runner**  
       Use `spawn(command, args, { cwd, env, stdio: 'pipe', detached: true })`; stream stdout/stderr to log files; enforce timeout; kill process group on timeout.

- [ ] **Step 3: Implement deny tests**  
       Tests prove `rm -rf`, `git push --force`, command paths outside allowlist, and shell metacharacter strings are rejected before spawn.

- [ ] **Step 4: Implement human approval boundary**  
       If policy requires approval, create a `human_decisions` row with `pending` and return `CommandBlockedForApproval`; do not spawn process.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add command gateway with argv policy enforcement"`

### Task 6: WorktreeManager

**Files:**

- Create: `packages/core/src/runtime/worktree-manager.ts`
- Create: `packages/core/__tests__/runtime/worktree-manager.test.ts`
- Create: `packages/core/__tests__/runtime/worktree-manager.e2e.test.ts`

- [ ] **Step 1: Define worktree lease API**  
       API: `createLease({ repoPath, runId, nodeId, role, baseRef })`, `releaseLease(leaseId)`, `pruneStaleLeases(repoPath)`, `listLeases(runId)`.

- [ ] **Step 2: Implement branch and path rules**  
       Path: `.donkey/worktrees/<runId>/<nodeId>-<role>`; branch: `donkey/<runId>/<nodeId>-<role>`. Reject dirty main worktree unless command has `--allow-dirty-base`.

- [ ] **Step 3: Implement git operations**  
       Use CommandGateway argv commands for `git worktree add`, `git worktree remove`, and `git worktree prune`. WorktreeManager must not call `spawn`, `execFile`, `exec`, or `execSync` directly. Never delete a path that is not under `.donkey/worktrees/`.

- [ ] **Step 4: Verify**  
       E2E test creates a temp git repo, leases two worktrees, confirms distinct branches and independent files, then releases and prunes.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add git worktree isolation manager"`

### Task 7: AgentAdapter Interface and Claude/Mock Runners

**Files:**

- Create: `packages/core/src/runtime/agent-adapter.ts`
- Create: `packages/core/src/runtime/claude-code-adapter.ts`
- Create: `packages/core/src/runtime/mock-agent-adapter.ts`
- Create: `packages/core/__tests__/runtime/agent-adapter.test.ts`
- Create: `packages/core/__tests__/runtime/claude-code-adapter.test.ts`
- Create: `packages/core/__tests__/runtime/mock-agent-adapter.test.ts`

- [ ] **Step 1: Define adapter contract**  
       `runAgent({ roleConfig, prompt, worktreeLease, outputDir, commandPolicy, runContext })` returns `AgentRunResult` with exit code, duration, output files, token/cost metadata if provider emits it.

- [ ] **Step 2: Implement mock adapter**  
       Writes deterministic artifacts for all built-in artifact types. Used by unit/E2E tests.

- [ ] **Step 3: Implement Claude Code adapter**  
       Supports `promptMode: stdin | arg-append | file`, `--output-format json` when configured, and permission config generation from `tools.yaml`. Default mode must not be `bypassPermissions`.

- [ ] **Step 4: Enforce provider capability checks**  
       Adapter startup must prove how sandbox, approval, filesystem scope, network scope, and tool allow/deny are mapped for the configured provider. If the provider cannot prove those controls, real Agent execution is rejected and the run may only continue with `mock` or `dry-run`.

- [ ] **Step 5: Verify streaming and timeout**  
       Tests use small Node fixture scripts that emit large stdout/stderr and sleep; runner must not deadlock and must kill timed-out process group.

- [ ] **Step 6: Commit**  
       `git commit -m "feat(core): add agent adapter contract and claude runner"`

### Task 8: Gate Engine and HumanGate

**Files:**

- Create: `packages/core/src/gate/engine.ts`
- Create: `packages/core/src/gate/human-gate.ts`
- Create: `packages/core/__tests__/gate/engine.test.ts`
- Create: `packages/core/__tests__/gate/human-gate.test.ts`
- Create: `packages/core/__tests__/gate/schema-gate.test.ts`

- [ ] **Step 1: Implement deterministic gates**  
       Gate types: `build`, `test`, `lint`, `e2e-pass`, `schema`, `security-scan`, `human`. Command gates go through CommandGateway. Schema gate validates Artifact Store content.

- [ ] **Step 2: Implement GateResult persistence**  
       Every gate attempt writes `gate_results` with status, output path, duration, retries, fix attempt id, and failure classification.

- [ ] **Step 3: Implement human gate pause/resume**  
       Human gate writes pending decision and transitions workflow to `paused`. `approveHumanGate(decisionId, actor, note)` resumes the blocked node.

- [ ] **Step 4: Implement autoFix as repair node**  
       Auto-fix creates a child node with role `rd` or configured fixer role, linked to failed gate result. Retries are counted against node and gate limits.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add deterministic gate engine and human approvals"`

### Phase 1 Exit Gate

- [ ] `pnpm --filter @donkey/core test -- --run` passes.
- [ ] A temp repo E2E creates a run, leases worktree, executes mock Agent, saves artifact, runs schema gate, writes audit events, and cleans worktree.
- [ ] A dangerous command fixture is rejected before process spawn.
- [ ] A human gate fixture pauses and resumes through repository APIs.
- [ ] A real Agent adapter that lacks explicit sandbox/approval/permission capability mapping is rejected before execution.
- [ ] Review record is saved to `docs/reviews/<date>-donkey-v2-phase1-kernel-review.md`.

---

## 3. 阶段二：角色化 Workflow 产品闭环

**阶段目标：** 在阶段一内核上实现技术方案中的角色系统、Workflow 模板、动态 Workflow、约束系统和核心 CLI。完成后，用户可以用模板或动态模式运行一个需求到本地交付证据包。

**阶段验收命令：**

```bash
pnpm --filter @donkey/core test -- --run
pnpm --filter @donkey/cli test -- --run
pnpm --filter @donkey/cli test:e2e -- --run
pnpm build
```

### Task 9: Role File System

**Files:**

- Create: `packages/core/src/role/loader.ts`
- Create: `packages/core/src/role/skill-loader.ts`
- Create: `packages/core/src/role/tool-policy.ts`
- Create: `packages/core/src/role/prompt-builder.ts`
- Create: `roles/pm/**`
- Create: `roles/rd/**`
- Create: `roles/qa/**`
- Create: `roles/reviewer/**`
- Create: `roles/pmo/**`
- Create: `packages/core/__tests__/role/*.test.ts`

- [ ] **Step 1: Implement role resolution**  
       Priority: project `.donkey/roles/<role>`, user `~/.donkey/roles/<role>`, built-in `roles/<role>`. Role folder override is whole-folder; skills merge by ID with higher priority override.

- [ ] **Step 2: Implement skill/knowledge loading**  
       Parse YAML frontmatter; respect `injectMode`, `priority`, `maxSkills`, `knowledgeFiles`.

- [ ] **Step 3: Compile tools.yaml to policy**  
       Convert role tool declarations to CommandGateway policy and provider permission config. Tests assert prompt text and policy stay consistent.

- [ ] **Step 4: Implement prompt builder**  
       Inject role identity, task instruction, skills, tools, knowledge, artifact summaries, and project context. Oversized artifacts are summarized with explicit truncation notice.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add filesystem role system and prompt builder"`

### Task 10: Workflow Templates and State Machine

**Files:**

- Create: `packages/core/src/workflow/template.ts`
- Create: `packages/core/src/workflow/state-machine.ts`
- Create: `workflows/standard-feature.yaml`
- Create: `workflows/bugfix.yaml`
- Create: `packages/core/__tests__/workflow/template.test.ts`
- Create: `packages/core/__tests__/workflow/state-machine.test.ts`

- [ ] **Step 1: Implement template parser**  
       Parse YAML into typed `WorkflowTemplate`; expand input/output shorthand; validate roles, artifact refs, gate configs, retry policy, and phase/node IDs.

- [ ] **Step 2: Implement state machine**  
       Legal transitions cover `pending`, `running`, `awaiting-gate`, `passed`, `needs-revision`, `blocked`, `paused`, `interrupted`, `skipped`, `failed`.

- [ ] **Step 3: Add built-in templates**  
       `standard-feature` covers PM -> RD -> QA -> Reviewer -> PMO. `bugfix` covers PM -> RD -> QA/Reviewer -> PMO with shorter retry defaults.

- [ ] **Step 4: Verify invalid workflow failures**  
       Tests reject missing reviewer phase, code-producing node without build/lint gate, invalid artifact dependency, and phase parallelism with conflicting output IDs.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add workflow template parser and state machine"`

### Task 11: Constraint Validator and Workflow Mutation

**Files:**

- Create: `packages/core/src/constraint/validator.ts`
- Create: `constraints.yaml`
- Create: `packages/core/__tests__/constraint/validator.test.ts`
- Create: `packages/core/__tests__/constraint/mutation.test.ts`

- [ ] **Step 1: Implement hard constraints**  
       Enforce build+lint for code changes, independent review phase, and validation phase or e2e gate.

- [ ] **Step 2: Implement conditional constraints**  
       High-risk demand injects human gate; auth/security/permission tags inject security review and security-scan; data/migration tags require rollback-plan artifact.

- [ ] **Step 3: Implement soft suggestions**  
       Suggestions are returned in dry-run preview and audit logs; they do not mutate workflow without explicit user choice.

- [ ] **Step 4: Verify mutation output**  
       Tests assert injected phases/nodes/gates have `source: constraint`, stable IDs, and visible explanation strings.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): enforce constraints and workflow mutation"`

### Task 12: Workflow Engine Scheduler

**Files:**

- Create: `packages/core/src/workflow/scheduler.ts`
- Create: `packages/core/src/workflow/engine.ts`
- Create: `packages/core/__tests__/workflow/engine-template.e2e.test.ts`
- Create: `packages/core/__tests__/workflow/engine-recovery.e2e.test.ts`
- Create: `packages/core/__tests__/workflow/engine-gate-repair.e2e.test.ts`

- [ ] **Step 1: Implement project/run creation**  
       `startRun({ repoPath, demand, templateName | workflowSpec, mode })` creates demand, project, workflow instance, phases and nodes in SQLite before executing any Agent.

- [ ] **Step 2: Implement scheduler**  
       Execute phases sequentially; execute nodes in parallel only when artifact dependencies and worktree leases are independent. Every transition goes through state machine and repository.

- [ ] **Step 3: Implement artifact dependency resolution**  
       Resolve `ArtifactRef` by node ID, phase index, or nearest previous artifact type. Missing dependency blocks node with audit event.

- [ ] **Step 4: Implement gate and repair loop**  
       Node completion triggers artifact schema gate and configured gates. Gate failures create repair node when `autoFix` is true; exhausted retries block or pause according to `onExhausted`.

- [ ] **Step 5: Verify recovery**  
       E2E interrupts after a running node, restarts engine, resumes from the interrupted node, and preserves previous artifacts and audit chain.

- [ ] **Step 6: Commit**  
       `git commit -m "feat(core): add durable workflow scheduler"`

### Task 13: Dynamic Workflow Mode

**Files:**

- Create: `packages/core/src/workflow/dynamic.ts`
- Create: `packages/core/__tests__/workflow/dynamic.test.ts`
- Create: `packages/core/__tests__/workflow/dynamic-constraint.e2e.test.ts`

- [ ] **Step 1: Define dynamic spec schema**  
       PM Agent must output `WorkflowSpecDraft` JSON with demand summary, phases, nodes, artifact outputs, risk tags, assumptions, and open questions.

- [ ] **Step 2: Implement dry-run generation path**  
       `generateDynamicWorkflow({ demandText, adapter })` runs PM through adapter, validates JSON, applies constraints, and returns preview without executing worktree commands.

- [ ] **Step 3: Implement save-as template**  
       `saveDynamicTemplate(spec, name)` writes `workflows/<name>.yaml` only after schema validation and command approval.

- [ ] **Step 4: Verify invalid agent output**  
       Tests cover malformed JSON, missing reviewer/validation phase, high-risk demand human gate injection, and `--save-as` path traversal rejection.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add dynamic workflow generation and dry-run"`

### Task 14: CLI Core Commands

**Files:**

- Create: `packages/cli/package.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/run.ts`
- Create: `packages/cli/src/commands/status.ts`
- Create: `packages/cli/src/commands/pause.ts`
- Create: `packages/cli/src/commands/resume.ts`
- Create: `packages/cli/src/commands/cancel.ts`
- Create: `packages/cli/src/commands/role.ts`
- Create: `packages/cli/src/commands/workflow.ts`
- Create: `packages/cli/src/commands/constraints.ts`
- Create: `packages/cli/src/commands/log.ts`
- Create: `packages/cli/src/commands/clean.ts`
- Create: `packages/cli/__tests__/commands/*.test.ts`

- [ ] **Step 1: Implement `donkey init`**  
       Creates `.donkey/config.yaml`, `.donkey/roles/`, `.donkey/runs/`, `.donkey/worktrees/`, and initializes DB.

- [ ] **Step 2: Implement `donkey run`**  
       Supports `--template`, `--dynamic`, `--dry-run`, `--save-as`, `--repo`, `--agent mock|claude-code`, `--allow-dirty-base`.

- [ ] **Step 3: Implement control commands**  
       `status`, `pause`, `resume`, `cancel` read/write persisted workflow state and print current phase/node/gate/human decision state.

- [ ] **Step 4: Implement management commands**  
       `role list/show/path/create`, `workflow list/show/create`, `constraints show`, `log`, `clean`.

- [ ] **Step 5: Verify CLI E2E**  
       Temp repo test runs `init`, `run --template bugfix --agent mock`, `status`, `log`, `clean`, and confirms DB/artifacts/reviews exist.

- [ ] **Step 6: Commit**  
       `git commit -m "feat(cli): add core donkey commands"`

### Task 15: Real Agent Smoke and Template Product Loop

**Files:**

- Create: `packages/cli/__tests__/e2e/full-template-flow.test.ts`
- Create: `packages/cli/__tests__/e2e/dynamic-dry-run.test.ts`
- Create: `docs/reviews/<date>-donkey-v2-phase2-cli-evidence.md`

- [ ] **Step 1: Run mock full flow**  
       `donkey run "给示例模块加批量重试" --template standard-feature --agent mock` reaches local delivery package.

- [ ] **Step 2: Run dynamic dry-run**  
       `donkey run --dynamic --dry-run "给支付模块加退款功能" --agent mock` prints injected human/security gates and does not create worktrees.

- [ ] **Step 3: Run optional Claude smoke**  
       If `claude` CLI is configured, run a bounded non-production fixture with read/write permissions scoped to temp worktree. Record CLI version and permission profile in review evidence.

- [ ] **Step 4: Save evidence**  
       Write run IDs, Gate results, human decision fixture, and failures to `docs/reviews/`.

- [ ] **Step 5: Commit**  
       `git commit -m "test: validate template and dynamic donkey flows"`

### Phase 2 Exit Gate

- [ ] `donkey run --template standard-feature --agent mock` completes to delivery package.
- [ ] `donkey run --dynamic --dry-run --agent mock` shows constrained workflow preview.
- [ ] `donkey pause/resume/cancel/status/log/clean` work against persisted state.
- [ ] Constraint validator blocks unsafe dynamic workflow.
- [ ] Review record is saved to `docs/reviews/<date>-donkey-v2-phase2-review.md`.

---

## 4. 阶段三：交付、Web 驾驶舱和 Dogfooding

**阶段目标：** 补齐技术方案中的 PR 交付、Web Dashboard、人工确认界面、效果评估、用户手册和 Donkey-on-Donkey 自举验收。

**阶段验收命令：**

```bash
pnpm test -- --run
pnpm build
pnpm --filter @donkey/web test:e2e -- --run
pnpm --filter @donkey/cli test:e2e -- --run
```

### Task 16: SCM Delivery and PR Creation

**Files:**

- Create: `packages/core/src/delivery/scm.ts`
- Create: `packages/core/src/delivery/evidence.ts`
- Create: `packages/core/__tests__/delivery/scm.test.ts`
- Create: `packages/core/__tests__/delivery/evidence.test.ts`
- Modify: `roles/pmo/system.md`
- Modify: `roles/pmo/tools.yaml`

- [ ] **Step 1: Implement SCM status checks**  
       Detect remote, current branch, dirty worktree, auth availability (`gh auth status`), and whether push/PR creation requires human approval.

- [ ] **Step 2: Implement delivery package**  
       Evidence package includes demand, workflow summary, artifacts, gate results, audit hash validation, test output paths, risk gates, and rollback plan when present.

- [ ] **Step 3: Implement commit/push/PR flow**  
       Use CommandGateway argv commands for `git add`, `git commit`, `git push`, `gh pr create`. No auto merge. If branch is not pushed, require human approval before push.

- [ ] **Step 4: Verify dry-run and real fixture**  
       Dry-run prints commands and required approvals without side effects. Local fixture uses a bare remote repo and a fake `gh` executable to assert PR URL capture.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(core): add scm delivery and pr evidence"`

### Task 17: Web API and Project Context

**Files:**

- Create: `packages/web/package.json`
- Create: `packages/web/src/server/api/trpc.ts`
- Create: `packages/web/src/server/api/root.ts`
- Create: `packages/web/src/server/api/routers/project.ts`
- Create: `packages/web/src/server/api/routers/artifact.ts`
- Create: `packages/web/src/server/api/routers/gate.ts`
- Create: `packages/web/src/server/api/routers/audit.ts`
- Create: `packages/web/src/server/api/routers/role.ts`
- Create: `packages/web/src/server/api/routers/workflow.ts`
- Create: `packages/web/src/server/project-context.ts`
- Create: `packages/web/__tests__/api/*.test.ts`

- [ ] **Step 1: Implement project context**  
       Web server reads an explicit `DONKEY_PROJECT_ROOT` or CLI-provided config; it never assumes `getDbPath('.')` silently.

- [ ] **Step 2: Implement read routers**  
       Project list/detail, artifacts, gates, audit, roles, workflows.

- [ ] **Step 3: Implement controlled write routers**  
       Human approval, pause, resume, cancel, clean require local session token stored in `.donkey/web-session.json`.

- [ ] **Step 4: Verify API tests**  
       Tests use temp DB and assert routers cannot read outside project root.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(web): add typed api routers for donkey project state"`

### Task 18: Web Dashboard UI

**Files:**

- Create: `packages/web/src/app/layout.tsx`
- Create: `packages/web/src/app/page.tsx`
- Create: `packages/web/src/app/project/[id]/page.tsx`
- Create: `packages/web/src/app/project/[id]/artifacts/page.tsx`
- Create: `packages/web/src/app/project/[id]/audit/page.tsx`
- Create: `packages/web/src/app/project/[id]/gates/page.tsx`
- Create: `packages/web/src/app/roles/page.tsx`
- Create: `packages/web/src/app/workflows/page.tsx`
- Create: `packages/web/src/app/settings/page.tsx`
- Create: `packages/web/src/components/cockpit/*.tsx`
- Create: `packages/web/__tests__/e2e/dashboard.test.ts`

- [ ] **Step 1: Build cockpit layout**  
       Dense operational UI with project status, current phase, nodes, gates, artifacts, and run controls.

- [ ] **Step 2: Build human decision flow**  
       Pending human gates show exact command/gate/request context, risk label, approve/reject buttons, and note input.

- [ ] **Step 3: Build audit/artifact views**  
       Artifact versions show summaries and file paths; audit view verifies hash chain status and filters by node/gate/role.

- [ ] **Step 4: Verify with Playwright**  
       Start local web server against fixture DB, screenshot dashboard at desktop/mobile widths, approve a pending human gate, and assert state change in DB.

- [ ] **Step 5: Commit**  
       `git commit -m "feat(web): add donkey dashboard and human gate ui"`

### Task 19: Metrics, Evaluation, and Dogfooding Reports

**Files:**

- Create: `packages/core/src/eval/metrics.ts`
- Create: `packages/core/src/eval/report.ts`
- Create: `packages/core/__tests__/eval/metrics.test.ts`
- Create: `docs/reviews/<date>-donkey-v2-dogfooding-report.md`
- Create: `docs/reviews/<date>-donkey-v2-dogfooding-report.html`

- [ ] **Step 1: Implement metrics extraction**  
       Metrics: time to PR/local package, automation ratio, gate pass rate, retry count, human interventions, PR review result, high-risk action count.

- [ ] **Step 2: Implement run report**  
       Report generator reads SQLite + Artifact Store and outputs Markdown/HTML summary with run ID, artifacts, gates, audit hash verification, known failures.

- [ ] **Step 3: Run dogfooding**  
       Use Donkey to manage one Donkey repo change. If real PR creation is not safe, run `--delivery dry-run` and record why.

- [ ] **Step 4: Commit**  
       `git commit -m "feat(core): add evaluation metrics and dogfooding reports"`

### Task 20: Documentation and Manual

**Files:**

- Create: `docs/manual/donkey-v2-user-manual.md`
- Create: `docs/manual/donkey-v2-user-manual.html`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md` if workflow rules change
- Create: `docs/reviews/<date>-donkey-v2-release-readiness.md`

- [ ] **Step 1: Write user manual**  
       Cover install, init, first run, template vs dynamic, reading status, approving gates, role customization, workflow creation, logs, cleanup, current limitations.

- [ ] **Step 2: Update README and CHANGELOG**  
       README links technical plan, three-phase plan, manual, and quickstart. CHANGELOG records V2 rebuild milestones.

- [ ] **Step 3: Generate HTML review versions**  
       Manual and release readiness docs must have HTML review copies.

- [ ] **Step 4: Verify docs**  
       Search generated docs for common unfinished-marker keywords, broken local paths, and missing HTML counterpart.

- [ ] **Step 5: Commit**  
       `git commit -m "docs: add donkey v2 user manual and release notes"`

### Task 21: Release Packaging and Final Acceptance

**Files:**

- Create: `packages/cli/__tests__/e2e/release-flow.test.ts`
- Create: `packages/web/__tests__/e2e/release-dashboard.test.ts`
- Create: `docs/reviews/<date>-donkey-v2-final-acceptance.md`
- Create: `docs/reviews/<date>-donkey-v2-final-acceptance.html`

- [ ] **Step 1: Build packages**  
       `pnpm build` must produce `packages/core/dist`, executable `packages/cli/dist/index.js`, and `packages/web/.next`.

- [ ] **Step 2: Run full tests**  
       `pnpm test -- --run --coverage`; target line coverage >= 80% for core, >= 70% for cli/web, with no failing tests.

- [ ] **Step 3: Run final E2E**  
       Fixture repo executes `init -> run --dynamic --dry-run -> run --template standard-feature --agent mock -> approve human gate -> delivery dry-run -> dashboard review`.

- [ ] **Step 4: Save acceptance evidence**  
       Final acceptance report includes commands, run IDs, Gate summary, coverage summary, known limitations, and release decision.

- [ ] **Step 5: Commit**  
       `git commit -m "test: add donkey v2 final acceptance evidence"`

### Phase 3 Exit Gate

- [ ] CLI can create a local evidence package and PR dry-run; real PR creation works in an authenticated fixture or is explicitly gated by human approval.
- [ ] Web dashboard shows project overview, artifacts, gates, audit, roles, workflows, settings, and human approvals.
- [ ] User manual HTML exists and matches current CLI behavior.
- [ ] Dogfooding report exists in Markdown and HTML.
- [ ] Final acceptance report exists in Markdown and HTML.

---

## 5. Scope Decisions

### 5.1 本计划覆盖的技术方案能力

- TypeScript monorepo, core/cli/web 分层。
- 角色文件夹系统：`agent.yaml`, `system.md`, `skills/`, `tools.yaml`, `knowledge/`。
- Workflow 模板、动态 Workflow、约束系统和 dry-run preview。
- Orchestrator 纯确定性调度；LLM 仅由角色 Agent 调用。
- Artifact Store、Schema Gate、Gate Engine、Human Gate、Audit Logger。
- Git worktree 隔离、可恢复 SQLite 状态、pause/resume/cancel。
- CLI 命令集、Web Dashboard、PR 交付证据包。
- Dogfooding 和效果评估指标沉淀。

### 5.2 仍然不做的事项

- 不自动合入 PR，不自动上线。
- 不做远程多租户服务；Web 是本地项目驾驶舱。
- 不做飞书 IM 通知集成。
- 不做多人协作权限模型；所有本地写操作归当前操作者负责。
- 不把 Codex 做成一等内置 provider；通过 `AgentAdapter` 和自定义 command 协议可接入，正式 Codex preset 需单独验收其 sandbox/approval 映射。
- Schema Gate 的 Phase 1 实现使用 Zod schema 作为统一校验层；技术方案中提到的 AJV/JSON Schema 可在后续兼容导出，不作为第一版阻塞项。
- 真实 PR 创建依赖本机 GitHub CLI 认证和远程仓库权限；无认证或高风险仓库场景必须降级为 `--delivery dry-run` 并输出可审阅命令清单与证据包。
- 文档中的 `<date>` 是未来执行阶段生成审阅记录时替换的文件名模板变量，不是占位实现或敏感信息。

### 5.3 阶段工期建议

| 阶段   | 建议周期 | 说明                                           |
| ------ | -------: | ---------------------------------------------- |
| 阶段一 |   2-3 周 | 核心边界最多，不能压缩；失败会影响所有后续能力 |
| 阶段二 |   3-4 周 | 产出第一个可用 CLI 产品闭环                    |
| 阶段三 |   2-3 周 | 补齐交付、Web、文档和 dogfooding               |

总周期建议为 7-10 周。若只能投入 6-8 周，优先保证阶段一和阶段二，阶段三中的 Web 深度和真实 PR 创建可以降级为 dry-run + 证据包。

---

## 6. Execution Handoff

推荐执行方式：

1. **Subagent-Driven（推荐）**：每个 task 派一个 worker，主线程做 review 和集成。适合阶段一、二。
2. **Inline Execution**：主线程按 task 执行，每个阶段结束再集中 review。适合阶段三文档和 UI 收口。

进入执行前必须先做一次计划审阅，并把结论写入 `docs/reviews/`。
