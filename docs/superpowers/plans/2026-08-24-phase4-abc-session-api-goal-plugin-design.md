# 阶段 4（4a–4c）详细设计：Session API 统一 + Workflow 降级为 goal plugin + CLI 会话化

- 状态：设计 v3 —— **opus 复评裁定"未检出必须修复项，设计可进入实现"**（v2 的 3 MUST 已实质修复并经代码核实）；v3 吸收复评 4 项 SHOULD + NIT（requestPause 不 abort、观察范围收窄、kind 持久化列、schema strict 接纳标记字段）。可开工。
- 上游依据：报告 §10 阶段 4、§0.6 工程视角批注（实现级摸底订正）；三路 explorer 摸底（workflow/gate-delivery/CLI）
- 范围：本设计只覆盖 **4a–4c**（会话化闭环，可独立交付）。**4d profiles / 4e Gate·Delivery 事件订阅 / 4f Demand→clarification·plan flow** 待 4a–4c 落地后另出设计（原因见 §7）。
- 分阶段原则：分阶段是纪律不是打折。任一子步 e2e 不过即停在该子步。

## 0. 目标与非目标

### 0.1 目标（本设计交付）

- **4a**：把散在 web router（`project.ts` 的 run/resume/cancel 编排）里的会话启动逻辑抽成 core 的 `SessionService`，并把 `createWorkflowJobExecutor` 从 web 移入 core（它已零 web 耦合）。web 行为**逐字节不变**——纯重构 + 组合根改装。
- **4b**：新增内置单节点 `goal` 模板 + job kind 分发，让"不经具体交付模板、直接跑一个 agent goal"成为一条真实运行路径。Workflow Engine 由"唯一总入口"降为"plan 的一种来源"。gate 作为可选治理挂在 goal node 上。
- **4c**：CLI `run` 走 `SessionService` + 内嵌 jobRunner（await job 终态再退出），产生 session/事件/dual-write；CLI `pause/cancel` 改走 jobRunner 治理路径。CLI 与 Web 共享同一 Session API。

### 0.2 非目标（显式递延，勿当缺口）

- **profiles 行为分支（4d）**：本设计不引入 `autonomous-delivery`/`review-only` 的策略评估器。`sessions.profile` 仍为展示字段；CLI 建的 session 标 `'cli'`（或沿用 `'human-web'`，见 §3.3 决策）。
- **Gate/Delivery 事件订阅（4e）**：gate 触发模型不变（node 边界同步 pull）；不新增 `readiness/*` 事件；delivery 仍人工显式触发。
- **Demand→clarification/plan flow（4f）**：draft/shape 流不动。
- **goal run 接 delivery**：goal run 默认**不接** delivery（`pre-pr-readiness.ts:70-71` 硬编码 standard-delivery）；goal 是"轻量 agent 目标执行"，要交付走 workflow 模板。此边界在 §4b 明确。
- **CLI/Web 并发跑同一 repo 的 run**：jobRunner 有 per-run 单 active job 守卫（`project.ts:312-319`），跨入口并发的 UX 不在本设计定义；两进程共享 sqlite 靠 job claim 原子 SQL 安全，但不主动优化体验。

### 0.3 硬约束（治理零退化，贯穿）

- **假通过零容忍**：新增 job kind **必须显式分发**；严禁掉进"默认分支 → 空 plan → 秒 passed"陷阱（`job-executor.ts:127-129` + `engine.ts:436-449`）。用测试锁定"未知 kind 必须 failed，不得 passed"。
- **CLI 跑完即退出语义不变**：CLI `run` 内嵌 jobRunner 后必须 await job 终态再退出并返回正确 exit code；既有 CLI e2e 的"状态: passed/paused"断言须继续通过。
- **重构零行为漂移**：4a 是纯重构，web 全部现有测试（api + e2e）不改断言即通过；若必须改断言，说明理由。
- **取消链完整**：CLI 会话化后 pause/cancel 必须真正杀子进程（走 `jobRunner.requestCancel → registry.killAll`），不得只改 DB 状态。

## 1. 现状锚点（摸底事实，文件:行号）

- 引擎已劈成两半：`engine.startRun` = `prepareRun` + `executePreparedRun`（`packages/core/src/workflow/engine.ts:237-241`）。
- web run 编排：`packages/web/src/server/api/routers/project.ts:149-283`（prepareRun → createSession → 补发 session/created+workflow/started+user/message → enqueue `workflow-run`）。
- web job executor：`packages/web/src/server/api/job-executor.ts:36-218`，唯一 web 专属件，只依赖 core + 纯接口 `WebProjectContext`（`project-context.ts:9-17`）；kind 分发二元（`workflow-resume` vs 其余走 `executePreparedRun`，:127-129）；无 runId 即 failed（:114-119）。
- 组合根：`packages/web/src/server/api/root.ts:41-125`（writeQueue → repositories/audit → sessionEventStore/jobRepository/bus/registry → dual-write → jobExecutor → jobRunner.start()）。
- core 已导出全部脊柱件：`packages/core/src/index.ts:10-23`（session-store、job-runner、dual-write、event-bus、subprocess-registry）。
- CLI run：`packages/cli/src/commands/run.ts:133-159`（裸 engine.startRun，同步阻塞，无 session/job/bus）；CLI context 无 write queue（`packages/cli/src/lib/context.ts:33-47`）。
- CLI pause/cancel 直改 DB：`packages/cli/src/commands/approval.ts:197-227`（pause）、`:368-398`（cancel）。
- 事件词汇 `kind:'workflow'` 硬编码：`dual-write.ts:91`、`project.ts:261`；client 按此渲染 `event-feed.ts:163-165`、`session-side-panel.ts:50`。
- job kind 是自由字符串（`session-contract.ts:102`）；session.runId 可空（`session-store.ts:124`）。

## 2. 4a — SessionService 抽取 + executor 移入 core

### 2.1 新增 `packages/core/src/session/session-service.ts`

`createSessionService(deps)` — deps 为组合根已装配的 `{ sessions, jobs, bus, repositories, audit, createEngine }`。方法：

- `startRun(input): Promise<{ runId, sessionId, jobId, workflow }>`：内部按现 project.ts:149-283 的顺序——`createEngine(input) → engine.prepareRun → [onPrepared 钩子] → sessions.createSession(runId 绑定) → append session/created + workflow/started + user/message → jobs.enqueue(kind, {runId})`。**编排逻辑逐行搬迁，不改语义。**
  - **返回 `workflow`（M-S6）**：web 响应需要 `mapWorkflowFromDomain(prepared.workflow)`（project.ts:279），故返回值须带 `prepared.workflow`，否则 router 要多一次 DB 读。
  - **`onPrepared(runId)` 钩子（M3 修复）**：prepareRun 之后、createSession 之前，`project.ts:222-235` 追加 `run.demand-shaped` 治理审计（P0-03 需求卡批准证据，**故意不映射为 session 事件**，S9 unmapped 清单）。它需要中间态 runId，在"router→service→map"结构里无落点。故 `startRun` 入参增加可选 `onPrepared?: (runId) => Promise<void>`（或结构化 `demandShapeEvidence?`），service 在 prepareRun 后原样调用/追加。web router 传入原 shapedDraft 审计逻辑；CLI 传对应证据或不传。**此审计不得静默丢失**（§0.3 零漂移）。
- `resumeRun(input)`、`requestCancel(input)`、`requestPause(input)`：搬迁 project.ts 对应编排（resume :285-343、cancel :345-408、pause :117-147 的 CAS 状态、发事件、enqueue resume / requestCancel）。

**边界（M-S6：完整归属清单）**：`SessionService` 只做**编排**。以下**留在 web router**（service 不含）：token/scope 校验（`assertSessionToken`）、`ApiError`、redaction、mapper（`mapWorkflowFromDomain`）、`loadProjectWorkflowIfPresent`、shapedDraft 校验与 `assertCleanBase`/`allowDirtyBase`。`createEngine` 工厂由组合根注入，**封装** web 的 `createWebAgentRuntime`/`providerRuntimeFromRunInput`（`agents.ts`，抛 ApiError）+ `registry`——即 provider/adapter 构建在工厂内，service 只调工厂。CLI 注入自己的 `createEngine` 工厂（含 `builtInRolesDir`，见 §4.1/S10）。web router 退化为"鉴权 → 组装 createEngine 与 onPrepared → 调 service → map 结果"。

### 2.2 executor 移入 core

`createWorkflowJobExecutor` 从 `packages/web/src/server/api/job-executor.ts` 移到 `packages/core/src/session/workflow-job-executor.ts`。`WebProjectContext` 里 executor 实际用到的字段（projectRoot/dataDir 等）抽成 core 的 `RunProjectContext` 接口；web 的 `WebProjectContext` extends 它。engine 重建（`buildEngine`，job-executor.ts:86-92，从 `run_provider_configs` 快照）随之移入 core。

### 2.3 web 组合根改装

`root.ts` 改为：装配 deps → `createSessionService(deps)` → router 注入 service。executor 从 core import。jobRunner 注册 core 的 executor。**行为不变**。

### 2.4 4a 测试

- 新增 core 单测 `session-service.test.ts`：startRun 建 session + 绑 runId + 发三事件 + enqueue 正确 kind；resume/cancel/pause 编排正确。
- 既有 web api 测试（`project-run-job`、`gate-approve-async`、`write-auth`、`read-api`、`session-*`）**不改断言全通过**（重构验证）。
- 既有 Playwright 全绿。

## 3. 4b — workflow 降级为 goal plugin

### 3.1 内置 `goal` 模板（M1：加载层改动集 + 有界豁免）

核实结论（reviewer M1，已到代码验证）：engine **执行层**对 goal 单节点/空 gates 确实零改动（`node-executor.ts` 空 outputs/空 gates 自然兼容，`requiredArtifactTypesForNode` 返回空集），**但加载层挡两处**：`normalizeWorkflowTemplate` 强制 reviewer 不变量（`template.ts:314-316`），`roleSchema` 是闭合枚举（`domain.ts:5`，`['pm','rd','qa','reviewer','pmo']`）。模板经 `parseWorkflowTemplate(readFileSync(...))` 从 `workflows/<name>.yaml` 加载（`template.ts:183-203`）。故 goal 模板落地的**完整改动集**：

1. **role 枚举扩展**：`domain.ts:5` `roleSchema` 增加 `'goal'`（`rawNodeSchema` 经它校验，`template.ts:150`）。
2. **新增 role 定义**：`roles/goal/agent.yaml`（+ system prompt）。`agent.yaml` 的 `role` 字段须匹配新枚举（loader 有一致性校验）。goal role 是通用执行者：读 demand 文本、产出结果 artifact，无强制 prior-node 依赖。
3. **reviewer 不变量的有界豁免**：改 `normalizeWorkflowTemplate` —— 仅对显式标记的 goal 模板（如模板级 `governance: 'none'` 或 `kind: 'goal'` 字段）豁免 reviewer 要求；**standard-delivery 等所有既有治理模板的 reviewer 强制不变**。豁免是白名单式、显式、有边界，不是全局弱化校验器。
4. **schema 接纳标记字段（复评补）**：`rawWorkflowTemplateSchema` 是 `.strict()`（`template.ts:177`），第 3 步的模板级标记字段**必须先加进该 schema**，否则 `goal.yaml` 在 `parseWorkflowTemplate` 阶段就因未知字段抛错，走不到 normalize 的豁免分支。
5. **内置模板文件**：新增 `workflows/goal.yaml`（单 phase 单 node，role=goal，gates 默认空，带豁免标记）。
6. gate 作为可选治理：goal node 的 `gates` 由 `startRun` 参数注入（空=纯 agent goal；非空=goal+治理），gate 引擎零改动。

**验收锚点**：goal 模板经 engine 的 `loadWorkflowTemplate({name:'goal'})` 自由字符串路径（`engine.ts:300-302`）成功加载（不抛 reviewer 错）；若改用 typed loader `loadBuiltInWorkflowTemplate`（`template.ts:207`），须把 `BuiltInWorkflowTemplateId` 联合（`template.ts:86-92`）加 `'goal'`——本设计走前者，不扩联合。且对 standard-delivery 传入无 reviewer 的畸形模板仍抛错（豁免不外溢）。（引用订正：roleSchema 在 `types/domain.ts:5`。）

### 3.2 job kind 分发改为显式 map

`workflow-job-executor` 的 kind 分发从二元 if 改为显式 map：`{ 'workflow-run': executePreparedRun, 'workflow-resume': resumeRun, 'goal-run': executePreparedRun }`。**未知 kind → 显式 throw/failed，绝不静默走空 plan**（§0.3 硬约束）。注意现二元 if 的"非 resume 即 executePreparedRun"默认分支正是陷阱来源，改 map 后 default 必须显式 fail。

### 3.3 事件词汇：`kind` 扩展为 `'workflow' | 'goal'`

- `startRun` 增加 `mode: 'workflow' | 'goal'`（web `project.run` 入参可选，默认 `'workflow'` 保后向兼容；缺 template 且 mode='goal' 时用 goal 模板）。**优先级（NIT 补）**：`mode:'goal'` 与显式 `template` 同时提供时，以 `mode:'goal'` 为准并忽略 template（或校验拒绝，实现时二选一并测试锁定），不产生歧义。
- **命名不碰撞（S8）**：事件 payload 现有 `mode` 字段（`'template' | 'dynamic'`，engine.ts:61 / project.ts:260）**保持不动**；本设计扩展的是 payload 的 **`kind`** 字段（`'workflow' | 'goal'`），二者正交。
- **`kind:'workflow'` 硬编码共 3 处（S1，非 1 处）**：`dual-write.ts:91`（run.started）、**:97（run.resumed）、:103（run.passed）**，另 `project.ts:261`（router 补发）。映射纯函数拿不到 run 的 mode。**kind 的持久化来源（复评补）**：`run.started`/`run.resumed`/`run.passed` 三处 audit 追加点里，只有 `run.started`（prepareRun 时）拿得到 mode；`run.resumed`（engine.ts:280）与 `run.passed`（engine.ts:446）**无 mode 输入**。故须在 prepareRun 时把 run 类型持久化——**新增 `workflow_instances.kind` 列**（默认 `'workflow'`），engine 在 resumed/passed 审计时回读该列填 payload.kind，dual-write 映射透传（缺省 `'workflow'`）。四处 + 一个 schema 列一并改，否则 goal run 的 resumed/passed 事件仍标 workflow。
- **client 改动是新功能，非兼容修复（S2 事实订正）**：核实 client **无任何代码消费 `payload.kind`**（event-feed.ts:163-165、session-side-panel.ts:50 都按事件 **type** switch，不读 kind；rpc-contract 无 workflow/started payload 类型约束）。故"词汇变更致 UI 错乱"风险不存在；client 若要区分"目标运行/工作流运行"文案是**新增**渲染分支（可选增强），不做也不影响既有渲染。设计动机据此订正：扩展 kind 是为**事件流语义正确**（下游/审计可分辨 run 类型），client 展示分支列为 4b 可选项。

### 3.4 goal run 与 gate/delivery 边界

- gate：goal node 的 gates 由 `startRun` 参数决定（空=纯 agent goal；非空=goal+治理）。gate 引擎零改动（`runGate` 只需 runId/nodeId/gate/cwd）。
- delivery：goal run 默认不接 delivery（§0.2）。`pre-pr-readiness.ts:70-71` 的 standard-delivery 硬编码检查对 goal run 恒 false——本设计**不放宽**该检查，改为 web/CLI 在 goal run 上**不暴露 delivery 入口**（UI/CLI 层 guard），并在设计中显式声明"goal run 要交付请改用 workflow 模板"。

### 3.5 4b 测试

- core 单测：goal 模板 → plan → 单节点执行 → run.passed；goal node 带 gate 时 gate 正常判定；goal 模板加载不抛 reviewer 错、standard-delivery 无 reviewer 仍抛错（§3.1 豁免不外溢）。
- **假通过防护测试（S7：必须锁住陷阱路径，防测试自身假通过）**：测试须**先 prepareRun 绑定 runId 且 plan 非空**，再 enqueue 一个未知 kind 的 job，断言 job **failed** 且 **run 未被写成 passed**。若测试用无 runId 的 session，失败来自 job-executor.ts:114-119 的 no-runId 守卫（不是未知 kind 分发），陷阱没锁住却假绿——必须避免。
- web api 测试：`project.run({mode:'goal'})` → 事件 `kind:'goal'`（含 resumed/passed 三处）→ job `goal-run` → 终态 passed。
- client 单测：仅当实现了 `kind:'goal'` 展示分支时补（S2：非必须）。

## 4. 4c — CLI 会话化

### 4.1 CLI context 升级

`packages/cli/src/lib/context.ts` 的 `withProjectContext` 增加 write queue + dual-write 包装 + session-store/job-repository/bus/subprocess-registry 装配（复用 core 导出件，镜像 web 组合根的装配顺序）。提供一个 CLI 版组合根 helper。

### 4.2 CLI run 改造

`run.ts` 改为：建组合根 → `SessionService.startRun({mode, template, demandText, ...})` → **本进程 `jobRunner.start()` 并 await 该 job 抵达终态** → 打印 Run ID + 终态状态（输出格式尽量不变）→ `jobRunner.stop()` → 按终态 exit code 退出。

- 保"跑完即退出"：await 终态而非 fire-and-forget。
- **await 机制用轮询 job 行（S4）**：jobs 表是 source of truth；`job/status` bus 事件是 best-effort（notifySettled 吞错，job-runner.ts:120-122，且 `requestPause` 不发 job/status），只能做加速不能做判据。以 ~200ms 轮询 job.status 抵达终态（done/failed/cancelled）为准。
- **输出语义钉死（S3）**：job 终态 ≠ workflow 终态——engine 在 gate 处 paused 时 executor 把 job settle 成 `done`（job-executor.ts:188-197）。CLI 打印的"状态"必须是 **workflow_instance 状态 + pendingHuman 计算**（沿用 run.ts:160-169 现有逻辑：job settle 后重读 workflow 状态），否则 `cli-flow.test.ts:93` 的 `状态: paused` + `人工确认: pending` 断言会红。
- **SIGINT 处理（S9）**：`tekon run` 前台跑长任务时 `process.on('SIGINT') → jobRunner.requestCancel(jobId) → stop()`，避免 job lease 卡 30s。这也是同进程取消链完整的落点（§4.3）。
- **roles 目录传参（S10）**：CLI 的 `createEngine` 工厂必须保留 `builtInRolesDir: getBuiltInRolesDir()`（run.ts:150 现有），否则 goal role（`roles/goal/`）在 CLI 加载不到。
- **保留既有早退/特殊路径**：`--dynamic --dry-run` 早退（run.ts:90-116）与 `--draft-file` 路径不动，勿在会话化时误拆。
- `--goal` 标志触发 goal 模式。**默认仍 `standard-delivery`**（保 CLI e2e）。

### 4.2.1 CLI `resume` 一并会话化（S5）

`approval.ts:229-366` 的 `commandResume` 现直连 `engine.resumeRun`（同步、无 job、无 session 事件）。若只会话化 `run` 而 resume 不动，则 `tekon run` 有 session/job、`tekon resume` 没有，违反 §0.1"CLI 与 Web 共享同一 Session API"。故 4c **一并**把 `commandResume` 改走 `SessionService.resumeRun` + 内嵌 jobRunner await 终态（与 run 同构）。若实现工作量超预期，退路是显式递延并在设计与 CHANGELOG 说明"resume 会话化留待 4c 后续"，不默默留不一致。

### 4.3 CLI pause/cancel 改造（M2：进程内模型 vs CLI 多进程模型的错配）

核实结论（reviewer M2，已到代码验证）：`SubprocessRegistry`、`controllers`、`pauseFlags` 全是**进程内内存态**（job-runner.ts:98-101）；executor 只观察进程内 `ctx.signal` / `ctx.pauseRequested()`（job-executor.ts:104-105,133,172），**无任何代码观察 job 行的 `cancelling`/`paused` 状态变化**（grep 全仓确认）。故 `tekon cancel`（独立进程）对**另一进程持有**的 run：`requestPause` 因 owner fence 静默 no-op（job-runner.ts:321-323）；`requestCancel` 把 job 行翻 `cancelling` 但运行方无人观察 → run 跑完 → owner 的 `settle()` 凭 ownership fence 覆写回 done/passed → **cancel 被吞、run 显示 passed**。这是**治理退化**：今天 CLI 直改 DB 状态（approval.ts:216-221,387-392），旧引擎虽不杀子进程，但 run 状态**诚实保持 paused/cancelled**。设计 v1 的 fallback 条件（"无 active job 时直改 DB"）也是反的——跨进程恰恰有 active job。

本设计的分场景处置（诚实边界，不假装能做到瞬停）：

- **同进程（`tekon run` 前台 + Ctrl+C）**：CLI `run` 内嵌 jobRunner 且 job 在**本进程**执行，`controllers`/`registry`/`pauseFlags` 就在手边。新增 `process.on('SIGINT') → jobRunner.requestCancel(jobId)`：本进程 `controller.abort()` + `registry.killAll(runId)` 真正杀子进程，取消链完整。这是 4c 能做到"取消链完整"的**唯一**场景，§0.3 硬约束**收窄到此**。
- **跨进程（`tekon cancel/pause` 目标 run 由 web 或其他进程持有）**：**新增运行方观察机制**——run 进程在 await job 终态的轮询循环里同时读自己的 job 行，见 `cancelling` → 调 `jobRunner.requestCancel(jobId)`（幂等：cancelling 态重入走 `controllers.get()?.abort()` + `killAll`，job-runner.ts:307-316，真正杀本进程子进程）；见 `paused` → 调 `jobRunner.requestPause(jobId)`（**只 `pauseFlags.add`，绝不 abort**——引擎节点边界先查 `signal.aborted` 后查 `isPauseRequested`（engine.ts:389-395），abort 会让 run settle 成 **cancelled** 而非 paused，pause 语义直接坏掉）。观察循环只能经 `requestCancel/requestPause` 公共 API 触发，摸不到 runner 私有的 `controllers`/`pauseFlags`。同时把 `requestPause` 改为**跨 owner 也持久化 `status='paused'`**（去掉 owner-fence 静默 return，改为"持久化 paused + 若本进程持有则 pauseFlags.add"；`updateJob` 无 owner 校验，跨进程写生效，session-store.ts:446-482）。
  - **适用范围（复评订正）**：此观察循环只存在于 **CLI run 的 await 轮询**里。**web 持有方无观察循环**（web jobRunner 不轮询外部 status，引擎节点边界也只查 signal/pauseFlags 不查 workflow 行）。故 CLI cancel 一个 **web 持有**的 run：workflow 行经 CAS 护栏诚实变 cancelled，但 web 的 agent 子进程会跑到引擎下次终态写入抛错才停（可能空耗剩余节点 token）。要消除此空耗，需把同一观察 hook 加进 web jobRunner 的 poll/heartbeat（成本低，可作 4c 内选做）；否则声明收窄为"取消链完整仅保证 **CLI 持有方**，跨进程只保证 workflow 状态诚实 + 不假 passed"。
- **兜底（无任何进程持有该 run，例如 run 已 stale）**：直改 DB 状态（保留今日语义），并靠 `recoverStale` 收敛。

**防"cancel 被吞、run 假 passed"的真正护栏（复评订正层级）**：护栏**不在** job settle（`job-runner.ts:155-188` 只按 executor 返回值写 job 状态，job 无 'passed' 概念），而在 **workflow 终态写入器的 CAS**：web cancel 编排**首步**即 `writeWorkflowTerminal(runId,'cancelled')`（project.ts:353-358），该 writer 是 CAS+幂等+冲突抛错（state-machine.ts:199-254，重读→同态 written=false→异态抛 `WorkflowTerminalError`）。外部 cancel 先落 workflow 终态后，引擎正常完成的 passed 写入（走同一 writer，engine.ts:436-449）必抛 `WorkflowTerminalError` → executor 收敛为 job cancelled（job-executor.ts:144-152）。故只要 `SessionService.requestCancel` **整体搬迁** web cancel 编排（含 writeWorkflowTerminal 首步顺序，§2.1），"假 passed"在 workflow 层被 CAS 根本杜绝——这是 M2 不退化的关键，与谁持有 run、观察循环是否及时**无关**。

> 说明：web 单进程模型下此问题不存在（发起 cancel 与执行 job 同进程）；这是 CLI 引入第二进程模型后的**新问题**，§0.6 摸底与设计 v1 均漏识别，本次修订补齐。若观察机制实现成本超预期，退路是**诚实收窄**：跨进程只保证 DB 状态诚实（不杀远端子进程，与今日等价），并在 §0.3 删去"跨进程取消链完整"的表述——但不接受"cancel 被吞、run 假 passed"的退化。

### 4.4 4c 测试

- CLI e2e（`cli-flow`、`release-flow`、`run-cli`）：run 仍返回终态、`状态: passed/paused` + `人工确认` 断言不变（S3 输出语义）；**新增**断言 run 产生了 session + 事件（查 session-store）。
- 新增 CLI e2e：`tekon run --goal "..."` 走 goal 路径、产生 session、终态 passed。
- resume e2e（S5）：`tekon resume` 走 SessionService、产生 session 事件、终态正确。
- **取消链测试（M2 分场景）**：同进程 SIGINT → 子进程真被杀（取消链完整）；跨进程 `tekon cancel` → run 状态诚实变 cancelled 且 **settle 不覆写回 passed**（防吞）。若采诚实收窄路线，则断言跨进程只保证 DB 状态诚实、不断言远端子进程被杀，并在测试注释说明边界。

## 5. 关键风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 未知 job kind 静默空转 passed | 假通过，比报错危险 | 显式 kind map + failed-not-passed 测试，且测试须绑 runId+非空 plan 才锁住陷阱（§0.3、§3.5 S7） |
| 4a 重构引入行为漂移（含 demand-shaped 审计丢失） | web 回归 / 治理审计链断裂 | 纯搬迁不改语义；`onPrepared` 钩子保 demand-shaped 审计（M3）；既有测试不改断言全过为门槛 |
| CLI 同步→异步破坏"跑完即退出" | CLI e2e 全红 / 体验变 | await job 终态再退出；打印 workflow 状态而非 job 状态（S3）；轮询 job 行为判据（S4） |
| **CLI 跨进程 pause/cancel 无效且吞掉 cancel（M2）** | **治理退化：run 假 passed** | 同进程 SIGINT 真杀子进程；跨进程新增运行方观察 job 行（cancelling→abort+killAll、paused→pauseFlags）+ requestPause 跨 owner 持久化；settle 不覆写外部终态；退路=诚实收窄边界（§4.3） |
| `kind` 事实前提错（client 不消费 kind） | 动机误述，但不致回归 | client 改动是新功能非兼容修复；dual-write 3 处 + router 1 处 kind 一并改（§3.3 S1/S2） |
| goal run 误接 delivery | standard-delivery 检查恒红 | `assertPrePullRequestReady` 服务端已强制（pr-package.ts:42-47），goal run 调 delivery RPC 会抛错；UI/CLI guard 为纵深防御（§3.4） |
| CLI 缺 write queue 致事件/legacy 表交错 | 数据不一致 | CLI 组合根启用 queue + dual-write（§4.1） |
| CLI `jobRunner.start()` 的 recoverStaleJobs 捞走 web stale job | CLI 进程执行了 web 的 job、web 取消不到 | 已知副作用，§0.2"不主动优化 CLI/Web 并发体验"已声明接受；实现时注意 workerId 隔离 |
| SessionService 返回值不足 web 响应 | router 多一次 DB 读 | startRun 返回 `workflow`（S6，§2.1） |

## 6. 验收（每子步独立 e2e）

- 4a：core `session-service` 单测绿 + web 全部既有测试不改断言绿 + Playwright 绿。
- 4b：goal 模板执行 + 假通过防护 + `mode:'goal'` web 链路 + client 渲染，全绿。
- 4c：CLI run/pause/cancel e2e（含会话产生断言、取消链、goal 路径）全绿。
- 全阶段：root 聚合 `pnpm test` 全绿 + Playwright 基线 + typecheck clean。

## 7. 为何 4d–4f 另出设计

摸底证明 4e（Gate/Delivery 事件订阅）是**触发模型变更**而非接线（gate registry 死代码、事件驱动需 validation-only 旁路重设计、readiness 事件不存在、bus 无回放/背压/幂等），4d（profiles）含治理红线决策，4f（demand flow）需新增 plan 产物与审批点——三者与 4a–4c 的"会话化闭环"耦合度低，且各自有独立设计面。先交付 4a–4c 建立"统一 Session API + workflow 可选"的地基，再在其上评估 4d–4f，符合"分阶段是纪律"，也避免单轮设计过重导致评审失焦。

## 8. 已定决策（原待决项，reviewer 复核后落定）

1. **CLI 引入 `--goal`**：**是**（CLI/Web 能力对齐，goal 路径的 CLI e2e 是最直接验收）。默认模板仍 standard-delivery。
2. **CLI session 的 profile 值**：标 `'cli'`（profile 是自由字符串 `session-store.ts:39`、无消费方，无风险；为 4d 预留区分）。仅展示，无行为差异。
3. **kind 扩展 vs 新增事件类型**：**扩展 `kind` 字段**（`'workflow'|'goal'`），改动面小于新增事件类型 + 新映射；且与事件 payload 现有 `mode:'template'|'dynamic'` 正交不碰撞（S8）。
4. **M2 跨进程取消**：首选"运行方观察 job 行 + requestPause 跨 owner 持久化"（§4.3 option ①）；实现成本超预期时退"诚实收窄"（跨进程只保证 DB 状态诚实、不杀远端子进程），但**任何情况下不接受 cancel 被 settle 吞掉致 run 假 passed**。
5. **CLI resume 一并会话化**（S5）：4c 同步改造 `commandResume`；工作量超预期则显式递延并在 CHANGELOG 声明。
