# 变更日志

## v0.14.0

Harness-inspired replatform 阶段 5a：**legacy 清理**。把已废弃的 `demand.*` 兼容别名层彻底移除,统一到 `draft` 词汇;并把 runner 自发的 `job/status` 加入 CONTROL_EVENT_TYPES(S9 对账排除,只对 §1.2 映射类型计数相等)。纯清理与词汇收敛,无新用户能力;`draftShape` RPC 命名空间、`tekon draft` 命令、需求卡文件格式均不变。

### 移除（breaking：仅影响直接调用已废弃别名的外部集成）

- **`demand.*` RPC 别名删除**:`rpc-contract.ts` 移除 3 个 `demand.*` procedure(`demand.shape`/`demand.approve`/`demand.detail`)与 6 个别名 schema;`root.ts` 移除 `demand: demandRouter` 挂载(保留 `draftShape: demandRouter`,同一实现);`context.ts` 移除 `ApiCaller.demand`。所有能力经 `draftShape.*` 命名空间提供,行为等价。
- **`demand*` 核心别名删除**:`packages/core/src/draft/shape.ts` 移除 13 个 `@deprecated` `demand*` 兼容导出;`packages/core/src/demand/shape.ts`(纯 re-export 垫片)删除。
- **CLI `demand` 命令别名删除**:`index.ts` 移除 `aliases:['demand']` 与 `case 'demand'` 分派;内部 `demand*` 标识统一 rename 为 `draft*`(draft.ts/eval.ts/run.ts/workflow.ts/path-utils.ts,约 36 处),CLI 用户面命令 `tekon draft ...` 不变。
- **Web `Demand*` 组件别名删除**:`DemandForm.tsx`/`DemandShapeCard.tsx`/`DemandPage.tsx` 删除;`DraftForm`/`DraftPage` 移除 `DemandForm`/`DemandPage` 兼容别名导出。`AcceptanceCriteria.tsx` 保留(DraftCard 在用)。

### 行为变化

- runner 自发的 `job/status` session_event 归入 `CONTROL_EVENT_TYPES`:S9 会话-run 事件对账排除该类型,只对 §1.2 映射类型做计数相等断言(runner 生命周期事件不参与 run 事件计数)。

### 测试

- core:`demand/shape.test.ts` 删除(对应 shim 已删);`types/session-contract.test.ts` +1(`job/status` ∈ CONTROL_EVENT_TYPES)。
- 全量根聚合 1228 passed(107 文件)/ 三包 typecheck 全绿。别名删除后无残留引用(全仓 grep 校验)。

## v0.13.0

Harness-inspired replatform 阶段 4（4d–4f）：把 `sessions.profile` 从纯展示字段变成**真实行为分支**（4d），把 Gate/Delivery 生命周期做成**事件订阅 + readiness 投影**（4e），并给需求卡加上**独立的计划产物与计划审批点**（4f-2）。三者各自独立可交付，且共同守住同一条红线——高自治可以自动准备交付，但**合入、PR 创建、人工审批 gate 仍须人工**，不因 profile 削弱。

### 新功能

**profiles 策略层（4d，autonomous-delivery 自动准备交付，红线不越）:**
- 新增 `packages/core/src/session/profile-policy.ts`（纯函数，无 IO）：`SessionProfile = 'human-web' | 'autonomous-delivery' | 'review-only'`；`canAutoPrepareDelivery`（仅 autonomous-delivery 为真）、`canMutate`（review-only 为假）。
- `project.run` 接受显式 per-run `profile`（`human-web` | `autonomous-delivery`；自治永不被推断）；Web StartRunForm 加 Profile 下拉。省略时回落组合根默认 `human-web`。
- autonomous-delivery 的真实新自动化：run 抵达 `passed` 时，组合根 listener 查 session profile，为真则 enqueue `delivery-auto-prepare` job——打包证据 + 写 `prepared` 行 + 发 `delivery/prepared`，**绝不创建 PR**（治理红线）。仅长驻服务（Web/headless）接线；CLI 跑完即退出，不接此自动化。
- **executor 隔离（M1）**：自动化 job kind（`delivery-auto-prepare`、`readiness-evaluate`）走独立轻量 executor（`createRoutingJobExecutor` 按 job kind 派发），绝不触碰 workflow/session 终态；自捕获错误（发 `agent/error`、返回 failed，绝不抛出污染 run 状态）。
- review-only：`canMutate` 原语已备并测，但**入口尚未接线**（发起 run 本身即是 mutation，当前无只读入口）；review-only 未纳入 `project.run` schema，避免装饰性 guard。enforcement 待专门只读入口设计。

**Gate/Delivery 事件订阅（4e）:**
- `event-bus.ts` 加 `subscribeAll(listener)` + `SessionEventBusOptions.onError`，publish 内 `safeInvoke` try/catch 隔离——单个 listener 抛错不再中断 fan-out 或传播给 publisher。
- readiness 投影：gate result 落库时（`gate/result` 事件）**或人工决策落定时**（`approval/decided` 事件）按 session 去抖 500ms 后 enqueue `readiness-evaluate` job，评估 pre-PR readiness 并发 `readiness/evaluated` 事件，UI/交付无需轮询即可反应（订阅 approval 事件使报告 §10「readiness/approval events」名副其实——审批改变 gate 状态后投影不再陈旧到下一个 gate/result）。新增事件类型 `readiness/evaluated`。
- `createPr` 幂等：分支断言后查 `delivery_pull_requests`，已 `created` 且有 prUrl 直接短路返回，重复调用不再重复建 PR。

**需求卡计划产物 + 独立计划审批（4f-2）:**
- draft shape schema 加可选 `hasPlan` / `planApproved` / `planApprovedBy` / `planApprovedAt`（`.strict()` 下加已知可选字段不影响旧 draft 文件读取）。
- `markDraftPlanGenerated`（显式生成计划产物，置 `hasPlan=true`；重新生成使旧计划审批失效）+ `planApproveDraftShape`（独立计划审批，未生成计划则抛错）。`approveDraftShape`（需求审批）**不触碰** `planApproved`——两审批正交。
- 新 RPC `draftShape.generatePlan` / `draftShape.planApprove`；新 CLI 子命令 `tekon draft plan` / `tekon draft plan-approve`。
- **`project.run` 与 CLI `run` 双侧门控（非装饰）**：`hasPlan && planApproved !== true` → 拒绝。语义：**已生成计划的需求卡必须先计划审批才能 run**；**未生成计划的需求卡（含所有旧 draft）恒豁免**，既有 approve→run 路径零破坏。

### 行为变化

- `sessions.profile` 不再是纯展示：`autonomous-delivery` 会在 run 通过后自动准备交付（不创建 PR）；其余 profile 行为不变。
- 已生成计划（`hasPlan`）的需求卡：`tekon run` 与 Web 发起运行在计划审批前一律拒绝。未生成计划的需求卡不受影响。

### 已知边界（诚实标注）

- **4f-1（澄清事件化）递延**：澄清发生在 run 前、session 尚未创建，`clarification/*` 事件挂靠哪个 session、draft 与 session 如何绑定是独立设计问题，不在本轮范围。与 4e 旁路 gate、4d review-only enforcement 同属"原语已备、消费入口待专门设计"的诚实收窄。
- 旁路 gate（schema-only 放开）在 4e 递延——复用 stableGateKey / 写前查 latest / 过滤 human gate 的机制已在设计中定稿，实现单列。
- auto-prepare 仅长驻服务特性；CLI 显式 `delivery prepare` 不变。CLI 未提供 `--profile` 标志（M2 决策下它对 CLI 行为惰性，会是装饰性标志）——CLI 自治交付通过 `tekon delivery prepare` 显式进行。

### 测试

- core：`profile-policy.test.ts`（5）、`automation-job-executor.test.ts`（6，含 M1 跨进程路由隔离 / M1 同进程隔离 / goal-skip / delivery-ready 自动 prepare 只到 prepared 不 created / S2 保留人工审批 / 幂等）、`event-bus.test.ts`（+3 subscribeAll/onError 隔离）、`scm.test.ts`（+1 createPr 幂等 + dry-run 尊重调用方）、`types/session-contract.test.ts`（+1 readiness/evaluated）、`draft/shape.test.ts`（+2 计划生成/审批正交 + 重新生成使审批失效）。
- web：`project-run-job.test.ts`（+3 autonomous auto-prepare vs human-web 不 prepare + gate/result 去抖 readiness 链路）、`write-auth.test.ts`（+3 计划审批门控 + 向后兼容旧 draft 仍 run + plan-approve 无计划报 400）、`gate-approve-async.test.ts`（+1 approval/decided 触发 readiness 投影）。
- CLI：`cli-flow.test.ts`（+1 e2e：draft plan→plan-approve 门控 + 旧 draft 无计划仍 passed）。
- 全量根聚合 1229 passed（108 文件）/ Playwright 11 passed + 5 flaky-then-pass（与 v0.12.0 基线一致）/ 三包 typecheck 全绿。

## v0.12.0

Harness-inspired replatform 阶段 4（4a–4c）：把 run 编排收敛为**共享 Session API**，让 CLI 与 Web 走同一条 `SessionService` + 后台 Job 路径；并把 workflow 从"唯一入口"降级为可选的 goal plugin。分阶段是纪律不是打折——4d–4f（profiles、Gate/Delivery 事件订阅、Demand→澄清/plan）单列后续设计，不在本次范围。

### 新功能

**SessionService + executor 移入 core（4a，零行为漂移）:**
- 把 web project router 的 run/resume/cancel/pause 编排抽成 `packages/core` 的 `createSessionService`，`workflow-job-executor` 一并从 web 迁入 core。web 组合根经 `createWebRunEngineFactory` 注入 provider/adapter 构造，router 只保留鉴权/ApiError/redaction/清洁基线断言等 web 专属校验；服务层用判别式 outcome（非抛错）回传校验失败，鉴权与错误映射仍归 router。

**workflow 降级为可选 goal plugin（4b）:**
- 新增内置单节点 `goal` 模板 + `goal` 角色：`governance: none` 仅豁免"必须有 reviewer 节点"这一条白名单不变量，其余模板不变量照常。goal run 是一次轻量 Agent 目标，不产出 code-changes、不接交付流程。
- `workflow_instances` 新增 `kind`（`workflow`|`goal`）列（默认 `workflow`，零迁移风险）；`run.started`/`run.resumed`/`run.passed` 审计与 dual-write 事件按 run 真实 kind 派生。
- 未知 job kind 显式 `throw`→job failed，绝不回落到空 plan 静默写 `run.passed`（§0.3 硬约束）。

**CLI 会话化（4c）:**
- `tekon run` / `tekon resume` 改走 `SessionService` + 内嵌 job runner，产生 session（profile=`cli`）、会话事件与 dual-write 投影，与 Web 共享同一 Session API。"跑完即退出"语义不变：await job 终态后重读 **workflow 状态**再退出，退出码依 workflow 终态派生。
- `tekon run --goal`：CLI 侧发起轻量 goal 运行（与 `--template` 互斥）。
- `tekon pause` / `tekon cancel` 改走 job runner 治理路径：真正杀子进程（`requestCancel → registry.killAll`），不再只改 DB 状态。
- 跨进程治理（M2）：`requestPause` 跨 owner 持久化 `status='paused'`；CLI 持有方在 `awaitJobTerminal` 轮询里观察自身 job 行——见 `cancelling`→`requestCancel`（abort+killAll）、`paused`→`requestPause`（仅置 in-process pauseFlags，绝不 abort，否则 run 会 settle 成 cancelled 而非 paused）。防"cancel 被吞、run 假 passed"的根本护栏是 `writeWorkflowTerminal` 首步 CAS（与谁持有 run、观察是否及时无关）。

### 行为变化

- `run_provider_config` 快照不再承载 run 级执行策略；`allow-dirty-base` 作为 run 级策略持久化到 `workflow_instances.allow_dirty_base`，后台 Job executor 重建引擎时回读该策略——修复"CLI run 走异步 Job 后 `--allow-dirty-base` 丢失导致 dirty 基线 run 失败"的潜伏缺陷。
- `resumeRun` 守卫顺序修正：**先判终态**再判 pending 决策——cancelled/passed/failed 的 run 即便残留 pending 决策也一律报"终态"（CLI → 退出码 1 + "终态"提示），不再误报"存在待审批"。
- `tekon resume --approve-human` 对齐 web `gate.approve`：批准单个决策后驱动 run 前进，不再因**其它**未决决策被 pending 守卫挡回（引擎会在下一个人工 gate 处重新暂停）；裸 `tekon resume` 仍保留 pending 守卫。

### 已知边界（诚实标注）

- 取消链完整仅保证 **CLI 持有方**（同进程 SIGINT / CLI await 观察循环）；CLI 取消一个 **Web 持有**的 run 时，workflow 状态经 CAS 护栏诚实变 cancelled，但 Web 侧 Agent 子进程会跑到引擎下次终态写入抛错才停（可能空耗剩余节点 token）。消除此空耗需把同一观察 hook 加进 web jobRunner，列为后续。
- goal run 默认不接 delivery（standard-delivery 的 pre-PR readiness 检查对 goal 恒 false）；权威硬 guard 是**服务端** `assertPrePullRequestReady`（goal run 恒红、无法创建 PR）。UI/CLI 层的 delivery 入口尚未按 kind 收窄（Delivery tab 与 `tekon delivery` 对所有 run 无条件可见），纵深防御的 UI/CLI guard 待后续补齐——治理不退化由服务端保证。
- 4d（profiles）、4e（Gate/Delivery 事件订阅）、4f（Demand→澄清/plan flow）单列后续设计，不在本次范围。

### 测试

- core：`session-service.test.ts`（startRun 建 session/绑 runId/发三事件/enqueue 正确 kind；resume 守卫顺序 + afterApproval；cancel writeWorkflowTerminal 首步 + terminalConflict）、`job-runner.test.ts`（requestPause 跨 owner 持久化 / 队列态不搁浅 / 幂等）。
- CLI：新增 goal 路径（run→passed + kind=goal）、cli-profile 会话产生断言、`--goal`/`--template` 互斥、`awaitJobTerminal` 观察循环（paused→requestPause、cancelling→requestCancel、终态直返、job 消失抛错）；既有 cli-flow e2e 的"状态: passed/paused"+ 人工确认断言在异步 Job 路径下继续通过。
- 全量根聚合 1201 passed / Playwright 16（11 clean + 5 flaky-then-pass）/ 三包 typecheck 全绿。

## v0.11.0

Harness-inspired replatform 阶段 3：Human-first Session UI。第一次把已在事件流里的会话事实（阶段 1/2 的 session/turn/step/tool/assistant/治理事件）接到**客户端**，形成连续叙事交互。默认路由 `/` 改为 Session UI；旧 run-centric Cockpit 完整保留在 `/advanced/*`（双轨并存，零删除）。

### 新功能

**会话读路径（报告 §10 阶段 3，3a）:**
- core `SessionEventStore.listSessions(workspaceId)`：按 `created_at desc, rowid desc` 稳定排序的纯 SELECT（零迁移），返回 `SessionListEntry`（Session + run_id 列）。
- web `session.list` / `session.get` RPC（`auth:'session'`）：`session.list` 无客户端入参，服务端经 `getOrCreateDefaultWorkspace(projectRoot)` 解析 workspace 并回传 workspaceId；`session.get` 经 `getRunIdBySessionId` 组合 runId（不改冻结 Session 契约）。事件本身走既有 SSE 端点（初始快照 = `sinceSeq=0` replay），不新增 `session.events` RPC。

**SSE 客户端 + 实时会话（3a/3b/3d）:**
- `lib/session-stream.ts`：`fetch` + `ReadableStream` 手写 SSE 客户端（非 `EventSource`——后者无法设置 `x-session-token` 头，query-param token 会泄漏进日志）。纯函数 `createSseParser`/`mergeEventsBySeq`/`lastEventId` 单测覆盖（半包/心跳/CRLF/去重/seq 单调/Last-Event-ID）；断线指数退避重连 + `Last-Event-ID` 续播（服务端 0..k∪k..end 拼接零丢失/零重复）。
- `use-session-stream` hook：live 累积 + `connState`（连接/实时/重连/关闭）+ 状态翻转事件 invalidate `session.list`。

**三栏 Session UI（3b/3c）:**
- Session 列表（`/`）+ composer（起新 run；不注入运行中消息——follow-up/steer 递延 2b）+ workspace 只读占位（顶栏显示 `session.list` 回传的默认 workspaceId，多 workspace 管理递延后续阶段）。
- Session Detail（`/sessions/:id`）：中栏 event feed（`describeEvent` 把 15+ 事件类型映射为连续叙事，按 turn 分组，合成 assistant 标"摘要"、截断标"已截断"，未知类型降级不崩）；右栏 = 运行控制（复用 RunControls）+ inline 审批（复用 DecisionCard，上下文从 `gate.list` 补全，approve/reject 走既有 `gate.approve/reject`，治理语义不变）+ tool/artifact/error 卡片 + run 达终态后的 final-result 收尾卡（终态状态 + artifact/error 计数）。

**token 接线修复（3a，顺带还债）:**
- `AuthProvider` 同步 `setRpcSessionToken`：修复 `auth:'session'` 读 RPC 在生产中因 token 头从未发送而全部 401 的预存缺陷（此前仅被 e2e fetch 猴补掩盖）。补 HTTP 层 200/401 测试（不经猴补）防假绿。

### 行为变化

- 默认路由 `/` 从旧 Dashboard 改为 Human-first Session UI；旧 Dashboard/Runs/Run-detail/Approvals/Delivery/Draft/Config/Eval 全部移到 `/advanced/*`（保留不删，报告 C2）。侧栏新增"会话 Sessions"（默认）与"高级 Advanced"两个入口。

### 已知边界（诚实标注）

- `assistant/message` 仍是产物元数据合成（非模型原文，阶段 2 M3）；feed 显式标"摘要"。真正逐块流式 `assistant/chunk` 递延 2b。
- composer 不支持运行中 follow-up/steer（`AgentHandle` 相应方法在 2b 才实现，现抛 `NotSupportedYet`），UI 诚实提示。
- 写操作（inline approve/reject）需在顶栏输入会话令牌（服务端校验请求体 token）；只读会话浏览在配置了令牌后即可。
- workspace picker 为只读占位（当前单默认 workspace）；多 workspace 管理递延后续阶段。diff 卡片本阶段不做（会话事件流无 diff 数据源；diff 在 delivery 投影里，随阶段 4 delivery 事件订阅补 diff 事件后再做）。

### 删除

- 删死代码 `hooks/use-run-poller.ts`（无消费者；实时更新由 SSE 取代）。

### 测试

- 新增 core `listSessions`（3）、web api `session-read-api`（4，含 M1 HTTP 200/401 防假绿）、client `session-stream`（11 解析器/reducer）、`session-stream-reconnect`（7 断线重连/Last-Event-ID/致命状态 400·401·403·404 不重连/503 重试）、`event-feed`（13 事件映射/turn 分组）、`session-side-panel`（15 右栏派生/终态状态/final-result 卡）。
- 新增 Playwright：`session-feed`（2，真实 mock-agent run→建流→replay→live→feed 有序）、`session-approval`（1，human-gate run→inline 卡片→两步批准→gate.approve→清空）、`session-routing`（1，`/`=Session UI、`/advanced`=旧 Cockpit 保留）。
- e2e fixture 新增 `feature-approval.yaml`（human gate 模板）；既有 12 Playwright 路径同步到 `/advanced/*`。
- 提交前全量 `pnpm test` 通过：core 894 / web 235 / cli 37 / 聚合 1166 + Playwright 11+5-flaky-then-pass（含 code review 修复的 +12、报告完整性终审的 +3 单测）。

## v0.10.0

Harness-inspired replatform 阶段 2（2a）：流式 Agent Loop 兼容层 + Provider Registry + Snapshot 版本契约 + 会话事件词汇补齐。让**真实 agent 产出**（每 node 的 step/tool/assistant 事件）进入会话事件流，并可从 event log 重建模型可见历史（报告 §13.6）。无 breaking change，事件为向后兼容的加法。

### 新功能

**Provider Registry（报告 §P1-02）:**
- 新增 `provider-registry.ts`：`ProviderDefinition`/`ProviderRegistry`/`createBuiltInProviderRegistry`，照搬 gate registry 范式；`createAgentRuntime`/`createAgentAdapterFromSnapshot` 改为委派 registry，删除两处重复 if/else（签名与行为不变，CLI/Web 构造路径回归锁定）。能力护栏 `assertAgentProviderCapabilities` 仍在 adapter 工厂内，registry 未绕过。

**Provider Snapshot 版本契约（报告 §10 阶段 2）:**
- `ProviderSnapshotVersionError` + `schemaVersion`（存于 config_summary JSON，零迁移）：缺省=1（旧快照兼容），高于当前版本抛错，防 provider 升级静默破坏 replay/resume。

**Agent Loop 事件桥（报告 §8.3/§8.4/§P0-04 桥接部分）:**
- 新增 `agent-step-events.ts`：`runAgentWithStepEvents` 单一拥有 `step/start → (tool/call → tool/result → assistant/message | agent/error) → step/end` 序列，包住 **4 处**真实 agent 调用（node-executor 主执行、rework 重跑、review 重跑、gate-repair 自动修复），确保经历 rework 或 gate 修复的 run 也有完整 §13.6 replay；事件经 dual-write bridge best-effort 发射（C1 治理零回归）。
- 新增 `legacy-agent-driver.ts`：冻结的 `AgentDriver`/`AgentHandle` 契约的首个实现（legacy 桥接，一次 runAgent = 一个 step）；`followUp`/`steer`/`resume` 抛 `NotSupportedYet`（递延 2b）。
- 补齐会话事件词汇：`step/start`、`step/end`、`tool/call`、`tool/result`、真实的 `assistant/message`（取代合成的 "Run passed."）；`tool/result` 与 `assistant/message` 标 `modelVisible`。

### 行为变化

- run 完成后不再发合成的 "Run passed." assistant/message；改为每个执行的 node 发一条真实的（产物元数据合成的）assistant/message。
- 事件流现在含真实 agent 步骤（step/tool/assistant），可经 SSE 消费并从 log replay 重建模型可见历史。

### 已知边界（诚实标注）

- 2a 的 `assistant/message` 由产物元数据合成，**非模型原文**；真正的增量 `assistant/chunk` 逐块流式依赖 provider 增量输出能力，递延阶段 2b。
- `followUp`/`steer`（运行中转向）、细粒度 tool 事件、spill reference 递延阶段 2b。
- dashboard 客户端尚未消费事件流（阶段 3）；`tool/call` 为 node 级摘要（`summaryLevel:'node'`）。
- §13.6 replay 覆盖跑过 agent 的 node（含 rework/gate-repair）；从 gate 断点恢复（resumeFromGate）不重跑 agent、不发 step 事件，故升级前已完成的 node 视图不含其 step/tool/assistant 事件——这是恢复语义，非缺陷。CLI 路径当前不接事件流（阶段 4），`--dynamic --dry-run` 预览的 `dynamic.ts` agent 调用不发 step 事件。
- `AgentDriver.cancel()` 对真实 provider 的中断依赖 adapter 透传 `signal`（现 codex/claude-code adapter 未透传），driver 尚无生产调用方，完整 provider→driver cancel 接线递延 2b（web job 路径的取消经 `ctx.signal` 独立生效，不受影响）。

### 测试

- 新增 `runtime/provider-registry.test.ts`（10：注册/未知/能力护栏/版本往返/缺失兼容/高版本抛错）、`runtime/agent-step-events.test.ts`（7：三分支 + C1 故障注入 + 无 sink）、`runtime/legacy-agent-driver.test.ts`（5：序列 + seq 单调 + cancel + pause + NotSupportedYet）。
- `phase1/session-job-e2e` 新增 journey 5（§13.6 模型可见 replay：三要素 + 顺序 + 真实 payload + 断线拼接一致）；harness 镜像 web 路径（agentEventSink + user/message modelVisible + 移除合成消息）；闭集泄漏断言扩展第四类 agent-loop 事件。
- 提交前全量 `pnpm test` 通过：core 892 / web 185 / cli 37 + Playwright 12。

## v0.9.0

Harness-inspired replatform 阶段 1：Event Spine（session/event/job 持久化 + dual-write）、真实后台 Job Runner（lease/心跳/崩溃恢复/fencing）、SSE 事件端点、AbortSignal + 子进程注册表取消链，以及 P0/P1/评审必修的运行时语义修复。**run / approve / resume 由同步阻塞改为后台 job 异步驱动**——这是面向使用者的行为变化。

### 新功能

**Event Spine 与后台 Job（报告 §8.2/§8.3，设计 §2）:**
- `core/session/`：`session-store`（Workspace/Session/SessionEvent/Job 持久化 + `listEventsSince` 回放）、`event-bus`（进程内 pub/sub）、`job-runner`（durable 轮询 runner，lease 续租 + stale 恢复 + owner fencing）、`subprocess-registry`（子进程句柄注册，取消链末端）、`dual-write`（AuditLogger/Repositories 包装器：仓储写入与 audit 事件透明投影为 session 事件）、`present`（传输层脱敏 + 限长）
- migrations v4：新增 `workspaces`/`sessions`/`session_events`/`jobs`/`projection_checkpoints` 五表，旧 15 表不动
- `nodes.node_order` 持久列：node 顺序确定化（消除跨进程加载顺序不确定）

**Web SSE 事件端点（设计 §3）:**
- `GET /api/sessions/:sessionId/events`：`x-session-token` 头鉴权（复用 RPC 的 origin/Sec-Fetch 校验）、`sinceSeq`/`Last-Event-ID` 回放、live 推送；**先订阅后回放（M6）消除回放/订阅交界丢事件**；payload 脱敏 + internal 事件不下发（C5）

**运行异步化（设计 §2.5/§2.11）:**
- `project.run` / `project.resume` / `gate.approve` 改为 enqueue 后台 `workflow-run`/`workflow-resume` job 后立即返回 `{sessionId, jobId}`；工作流由 job runner 出带驱动，取消可中断（P0-02 不回退）
- `project.run` 的既有同步校验（脏工作区、模板、agent runtime、P0-03 审批双校验、demandText 非空）全部保留在 enqueue 之前

### 修复

**P0/P1 与评审必修（设计 §0.2/§0.3）:**
- P0-02：resume/approve 不再阻塞，取消可中断后台续跑 job
- P0-03：服务端强制 shaped draft `approved && readyForRun`，否则 400
- P1-04/M8：终态 run 的 resume/approve/reject 抛 `WorkflowTerminalError` → CLI exit 1 + 中文提示 / Web 400，不复活
- §12-P1.7：run 级状态机 validator + 幂等终态写 `writeWorkflowTerminal`（CAS 收敛并发竞态，Gap A）。注：报告 §5 的 P1-07（任务续聊/运行中转向）是不同条目，属阶段 2 范围
- MF1：cancel 经 web 路径单发 `agent/cancel-requested` + `agent/cancelled`，落 session 终态
- MF2：`project.resume` / `gate.approve` 清理旧 job 后 `findActiveByRunId`，仍有活跃 job → 409（同 run 不允许双活跃 job）
- MF3：web reject 补终态检查 → 400，`casWorkflowInstanceStatus(paused→blocked)` 防并发 cancel 被覆盖复活
- 复审 A1：`cancelStaleActiveJobs` 的 queued 分支加 `created_at` 年龄阈值——并发双 approve/resume 时败者不再误杀胜者刚入队的新鲜 job
- 复审 S1：单活跃 job 护栏从 approve 提升到覆盖 approve + reject——resume job 在途（run 瞬时 `running`）时 reject 不再落 run 级 CAS 失败的误导性 200，改 409
- gate.approve/reject 决策翻转改幂等 CAS（`expectedStatus='pending'`），并发双提交零重复副作用

### 测试

- core 新增 `phase1/session-job-e2e`（run-to-passed / cancel / crash-recovery 四 journey + audit↔session_events 对账）、`session/*`（store/bus/job-runner/dual-write/present/subprocess-registry 单测）
- web 新增 `session-sse`（鉴权/回放/live/M6 边界/断连清理/getSession 失败前置于开流）、`gate-approve-async`（异步契约 + MF2 + A1 并发 + S1 reject 活跃 job 409 + P0-02 取消）、`project-run-job`（run 异步契约）；既有 write-auth / e2e 改轮询至终态
- 提交前全量 `pnpm test` 通过：core 869 / web 185 / cli 37 + Playwright 12

## v0.8.0

Harness-inspired replatform 阶段 0：修稳既有 flaky 测试、P1 纯 UI/API 修复、CI 覆盖三包、Session/Event 契约冻结。不动 core 运行时主路径。

### 修复

**CLI/Web 测试稳定性:**
- `run-cli.test.ts`：新增 anchor cwd 复位（`afterEach` 无条件 `process.chdir(anchorCwd)`），消除测试间共享进程级 cwd 导致的 `ENOENT chdir` 级联失败；超时 15s→30s 匹配真实子进程耗时
- `cli-flow.test.ts` / `release-flow.test.ts`：超时 30s→90s，消除并行负载下的 flaky 超时

**P1 人类可用性（报告 §12）:**
- P1.1 Resume 覆盖 `blocked`/`interrupted`：`RunControls` 抽出纯函数 `runControlAffordances`，Resume 不再仅对 `paused` 显示（`RunControls.tsx`）
- P1.2 terminal "眼睛"按钮：从 `stopPropagation` 无行为改为 `onView` 回调导航到 run 详情（`RunControls.tsx` + `RunTable.tsx`）
- P1.3 Run 列表展示需求标题：API 新增 `demandTitle` 字段（`mappers.ts`/`queries.ts`/`rpc-contract.ts`），`RunTable` Demand 列显示标题而非内部 ID
- P1.4 Run Detail 展示真实 provider：`review.get` 响应新增 `provider` 字段（`review.ts`/`context.ts`），`deriveAgent` 不再固定返回 `—`

### 新功能

**CI 覆盖三包（报告 P1-06）:**
- 新增 `.github/workflows/ci.yml`：root typecheck + CLI build/unit/e2e + Web build/typecheck/unit + Playwright e2e（含 `playwright install --with-deps chromium`）
- 既有 `core.yml` 保留为 core 专项门禁

**Session/Event 契约冻结（报告 §8.2/§8.3/§8.4）:**
- 新增 `core/types/session-contract.ts`：Workspace/Session/SessionEvent/Job schema + 事件词汇（core/control/tekon-governance）+ AgentDriver/JobRunner/EventSubscription/Projection 接口签名（纯类型，无实现）
- 新增 `core/__tests__/types/session-contract.test.ts`：9 个测试锁定 schema 版本、必需事件核心、merge-extensible 兼容策略

### 测试

- 新增 `web/__tests__/client/run-controls.test.ts`：8 个测试覆盖 `runControlAffordances` 全状态矩阵
- `read-api.test.ts`：新增 2 个 API 级测试覆盖 demandTitle/provider enrichment（含缺 provider 快照的 null 路径）
- `contract-strict.test.ts`：同步 `apiWorkflowSchema` 新必需字段
- e2e 断言同步当前中文 UI：`demand` 页标题 `Demand`→`需求澄清`、gates 页 `human`→`人工审批`、approve 按钮 `✓ Approve`→`✓ 批准`
- `playwright.config.ts`：`expect.timeout` 10s、`navigationTimeout` 20s、`retries: 1`（Vite dev-server 冷启动抖动兜底）

### 文档

- `docs/reviews/2026-08-20-...migration-review.md`：新增 §0 维护方决策批注（事实核验结论 + 定位判断 + 处置决策）
- 新增 `docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md`：六阶段总体执行方案

## v0.7.0

### 新功能

**Web Cache Token Invalidation:**
- 新增 `query-keys.ts`：集中式 auth-scoped query key 工厂
- 新增 `use-auth-scope.ts`：React hook 派生当前 auth scope
- 扩展 QueryCache：`clearByScope`、`clearAllInFlight`、scope metadata
- AuthProvider token 变更时自动清除旧 session 缓存和 in-flight 请求
- 13 个 Web 组件统一使用 queryKeys 工厂，消除分散 key 拼接

**Gate Engine 注册表模式:**
- 新增 `gate/registry.ts`：GateDefinition + GateMetadata + GateRegistry 接口
- 新增 `gate/helpers.ts`：提取共享 gate 工具函数
- Gate runners 拆分为独立文件：command, security, schema, review, semantic, human
- Engine 支持可选 registry 参数，向后兼容旧 if/else 分派
- work-readiness 和 pre-pr-readiness 使用 registry 常量替代硬编码 gate 类型

**约束系统增强:**
- `agent.yaml` 新增 `autonomy`（level + riskTolerance）、`requiresHumanApprovalFor`、`defaultTimeoutMs`、`allowedGateTags` 字段（向后兼容）
- 新增 `runtime-policy.ts`：compileRoleRuntimePolicy + requiresHumanApproval + canSatisfyGate
- `constraints.yaml` 升级为有限 DSL：requiresGate / injectGate / requirePhase / requireOutput / suggest
- 新增 `dsl.ts`：loadConstraintRules + evaluateConstraints（支持 glob pattern matching）
- validator 集成 DSL 规则（硬编码规则作为 fallback）

**CLI/Web Agent Runtime 去重:**
- 新增 `core/runtime/agent-runtime.ts`：共享 createAgentRuntime + createAgentAdapterFromSnapshot + defaultProviderConfig
- CLI agent-factory.ts：thin wrapper，approvalDefault: 'on-failure'
- Web agents.ts：thin wrapper，approvalDefault: 'on-request'
- Web gate.ts：去除重复 resume/snapshot 函数
- CLI 减少 ~130 行重复，Web 减少 ~220 行重复

### 测试

**新增 234 个测试（641 → 875）：**
- scheduler.test.ts (8): phase 顺序、节点过滤、空 phase、未知 phaseId
- write-queue.test.ts (14): 串行执行、错误恢复、20 并发 FIFO
- query-keys.test.ts (25): auth scope 一致性、key 格式、token 隔离
- query-cache-scope.test.ts (9): clearByScope、clearAllInFlight、token 变更流
- agent-runtime.test.ts (30): factory/snapshot/config/overrides
- registry.test.ts (10): 12 gate 类型、metadata、category 过滤
- runtime-policy.test.ts (17): defaults、pattern matching、gate satisfaction
- dsl.test.ts (15): loading、validation、evaluation、glob patterns
- agent-config-extended.test.ts (7): 向后兼容、新字段、非法输入拒绝
- execution-plan.test.ts (23): templateToPlan、persistPlan、planFromRepository
- lease-service.test.ts (18): worktree lease、audit events、error handling
- workflow-runtime.test.ts (32): scopedId、stableGateKey、resolveReviewTarget、isChangesRequested
- helpers.test.ts (26): mustGetWorkflow/Demand、assertSuccessfulAgentRun

## v0.6.0

### 重构

**CLI 模块化拆分:**
- `packages/cli/src/index.ts` 从 3040 行缩减到 304 行（仅路由入口）
- 新增 `commands/` 目录：14 个命令文件（init, run, draft, workflow, delivery, approval, eval, review, role, status, ui, help）
- 新增 `lib/` 目录：5 个工具文件（agent-factory, context, db-helpers, path-utils, utils）

**Workflow Engine 模块化拆分:**
- `packages/core/src/workflow/engine.ts` 从 2389 行缩减到 335 行（仅编排层）
- 新增 8 个子模块：execution-plan, node-executor, gate-runner, rework, prompt-builder, lease-service, helpers, workflow-runtime
- gate-runner ↔ rework 通过 lazy getter 注入解决循环依赖

## v0.5.2

### 修复（全面审查第二轮）

**UX CLI 改进:**
- `draft new` 删除不存在的 `tekon draft review` 命令提示
- `tekon run` 输出增加中文上下文（🚀 运行已启动）和后续操作提示
- `delivery create-pr` 输出增加可读 PR URL 格式（✅ PR 已创建）
- 错误消息系统性国际化（约 30 处英文→中文）
- `delivery dry-run` 加入帮助子命令列表
- `constraints` 子命令帮助完善
- `update` 命令输出改中文

**UX Web 改进:**
- Session token 自动从 URL 读取并存入 `sessionStorage`
- Sidebar 底部从 API 动态读取项目名称和路径
- RunControls "View details" 按钮添加导航行为
- NotFoundPage 增加"返回 Dashboard"链接
- Flash 消息统一为中文
- `LoadingState`/`EmptyState` 默认消息改中文

**测试质量:**
- `engine-unit.test.ts` 19 个假测试修复：提取 `resolveReviewTargetNode` 等纯函数为导出函数，直接测试源码
- 新增 engine 纯函数单元测试

## v0.5.1

### 修复（全面审查第一轮）

**Critical:**
- 修复 rework 逻辑缺陷：`changes-requested` rework 后现在会重新运行 target node 的所有 gates 并重新生成 review artifact
- 修复 rework node 空 `outputs`/`gates` 导致真实 provider 不产出也通过的问题

**Major 引擎正确性:**
- `resumeRun()` 增加终态拒绝检查，防止恢复已完成/已取消的 run
- Human gate 幂等处理，防止 resume 时重复创建 pending decision
- Gate retry 循环完善，正确映射 `block`/`pause`/`fail`
- Gate 执行增加外层异常处理，防止 `running`/`awaiting-gate` 半状态
- Lease 生命周期 `try/finally` 管理，失败时正确释放
- 引入 `checkedTransitionNode` 状态机校验，防止非法状态转换

**Major 安全:**
- `role create` 增加 `ensureSafeName()` 校验，防止 `../` 路径逃逸
- Web 读 API（artifact/gate/audit/review/progress）增加 session token 鉴权
- CLI 不再将 token 放入 URL query string
- Secret scan 使用 `lstatSync` 跳过 symlink，增加深度和文件数限制
- `web-session.json` 写入时设置 `mode: 0o600`

**Major DB 连接管理:**
- 引入 `withProjectContext` 辅助函数，统一 DB 连接生命周期管理

**Major 类型安全:**
- 移除 `as never` 类型断言，增加 `validRoles` 运行时校验
- `assertAgentProviderCapabilities` 使用具体类型替代 `unknown`
- `TEKON_CORE_VERSION` 从 `package.json` 动态读取
- 清理 20+ 处未使用的 import 和变量

## v0.5.0

### 新增

- CLI `help` 命令：`tekon help` 输出分组命令概览，`tekon help <command>` 查看子命令详情；`--help`/`-h` 和 `--version`/`-v` 作为全局 flag 支持。
- Agent 驱动需求澄清：`draft new` 支持调用 Claude Code agent 生成上下文相关澄清问题并精炼需求草案，agent 不可用时自动回退到静态问题；新增 `draft-agent.ts` 模块，包含 PM 角色 prompt、JSON 解析容错、`verification` 字段保留等。
- Web Dashboard 状态修复：`skipped`（已跳过）、`interrupted`（已中断）、`blocked`（已阻断）状态在 StatusBadge、GatesTab、RunDetailPage、RunTable 中正确显示中文标签和 CSS 样式。
- Review → rework → re-review 闭环：`independent-review` gate 返回 `changes-requested` 时触发目标节点重新执行（最多 5 次），不再直接阻塞 workflow；`passed` 状态允许向 `needs-revision` 转换；rework 节点 ID 包含 attempt 计数器避免碰撞。
- AGENTS.md 新增「测试要求」章节：测试先行、提交前全量通过、测试质量检查（正确性/完整性/无冗余）、测试与代码同步、e2e 测试要求。

### 变更

- 真实 provider 默认权限模式从 `on-request` 改为 `on-failure`（Claude Code adapter 映射为 `acceptEdits`），减少 agent 执行时的权限拒绝。
- Claude Code adapter 自动 `--add-dir` 追加节点 artifact 输出目录到沙箱。
- Manifest 文件解析增强：`resolveExistingManifestPath` 检查 5 个候选文件名；`parseStructuredPayload` 对 JSON/YAML 解析增加 try/catch 容错。
- Engine prompt 中 `$TEKON_ARTIFACT_MANIFEST` 环境变量引用替换为实际 manifest 文件路径，避免 agent Bash 调用被拒时无法读取。
- `draft new` 命令从 `demand shape` 分流，新增 CLI `draft` 命令组（别名 `demand`），子命令 `new`/`shape`/`approve`/`show`。

### 修复

- 修复 `changes-requested` 被错误归类为通用 `review-not-approved` 的问题，现在独立返回 `failureClassification: 'changes-requested'`。
- 修复 rework 节点未持久化导致 transition 失败的问题。
- 修复 rework 节点 ID 碰撞（多次重试使用同一 ID）的问题。
- 修复 `extractDraftShapePatch` 丢失 AI 验收标准 `verification` 字段的问题。
- 修复 `packages/cli/package.json` 版本号 0.1.0 → 0.5.0，与根 package.json 对齐。

## 未发布

### 新增

- 天工（Tekon）主用户使用手册：`docs/manual/tekon-user-manual.md`，覆盖 overview、quick start、核心用户场景、CLI/Web 使用、参数解释、结果判断和常见问题处理；后续每次迭代后都必须评估是否需要同步更新。
- Phase 1 `@tekon/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。
- Phase 2 角色文件系统、内置 `pm/rd/qa/reviewer/pmo` 角色、workflow 模板、constraint validator、dynamic workflow dry-run 和 durable workflow engine。
- `@tekon/cli` 本地 CLI 包，支持 `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean` 的 mock 验证路径；`run --allow-dirty-base` 可显式允许基于本地 dirty base 执行。
- Phase 2 CLI evidence 和 review HTML 审阅文档。
- Phase 3 SCM delivery dry-run、delivery evidence、metrics/report、Web dashboard、Web human approval、audit hash/filter、release-flow e2e 和 coverage provider。
- Phase 3 V2 用户手册、dogfooding report、final acceptance report 及对应 HTML 审阅版。
- README 更新 Phase 3 本地验收边界，并链接 V2 manual、dogfooding report 和 final acceptance report。
- 工作可用化增量：`.tekon/repo-profile.yaml` 仓库画像、Engine 角色 prompt 注入、CLI `--agent claude-code` adapter 接线、`delivery prepare` PR 准备包、`eval readiness` 工作就绪度评估。
- 工作可用化闭环：真实 git worktree lease 进入 Engine 主路径，节点改动会提交并推进到 `tekon-delivery/<runId>`；内置模板加入 `security-scan` gate。
- 真实 provider 产物协议：Engine 在 prompt/env 中注入 `TEKON_OUTPUT_DIR` 和 `$TEKON_ARTIFACT_MANIFEST` manifest 路径，Claude Code adapter 会读取 manifest、校验 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败。
- 仓库画像驱动 gate：内置 workflow 使用 `commandRef` 引用 `.tekon/repo-profile.yaml`，CLI 新增 `workflow preflight` 展示 build/lint/test/security 等 gate 将运行的命令。
- 恢复一致性：run 创建时落库 provider/config 摘要，CLI/Web resume 按 run provider 快照恢复；Engine 对 stale `running` 节点增加 completed role-run marker 检查，避免未完成节点直接跳到 gate。
- 受控远端交付：CLI `delivery create-pr` 支持人工批准后 push 分支并调用 `gh pr create --body-file`，PR 状态和 URL 落库，失败阶段落库，PR 已存在时尝试 `gh pr view` 恢复 URL；执行前会拒绝主工作区除 `.tekon` 外的未提交改动。
- 语义证据：artifact schema 支持验收标准、criteria evidence 和 security findings；delivery evidence/readiness 汇总逐条验收证据和安全扫描结果。
- Web human approval 自动 resume：Web approve/reject 会更新决策、gate/node/workflow 和 audit，approve 后自动调用 Engine 继续运行。
- 审阅面聚合：core 新增 review surface，CLI 新增 `review --run-id`，Web 新增 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令区块；同一聚合器会读取 artifact 正文、gate 输出、PR body/package、delivery diff 和 readiness 失败项。
- 审阅证据导航：review surface 新增 evidence groups，把 readiness 失败项关联到 artifact、gate log、audit event、PR body、PR package 和 diff；CLI 输出 Evidence Navigation，Web 新增 Evidence Links 面板。
- Gate 失败诊断：review surface 新增 Gate Failure Triage，把失败 gate 的分类、日志锚点、重试建议和建议命令结构化输出；CLI `review` 和 Web dashboard 会展示同一诊断结果。
- 需求塑形入口：core 新增 demand shape/approve/evaluate 能力，CLI 新增 `demand shape`、`demand approve`、`demand show`、`run --demand-file` 和 `eval demand-shape`；Web dashboard 可用 session token 塑形、批准需求后再发起 run。
- 受控 Workflow 选择：新增 `test-improvement`、`docs-update`、`plan-only` 内置模板，需求塑形可推荐对应模板；CLI 新增 `workflow select` 和 `eval workflow-selection`，Web 模板选择器同步展示受控模板。
- Web 受控执行入口：dashboard 可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并提供 artifact/gate/audit 到审阅正文和 PR 包的基础锚点互跳。
- Web 多运行审阅流：dashboard 会列出当前项目内的 runs，可选择任意 run 加载 readiness、artifact 正文、gate log、audit 和 PR 包；PR 准备/创建也作用在当前选中的 run 上，而不是固定 latest run。
- 工作可用样本评估：core 新增 work usability evaluator，CLI 新增 `eval work-usability --samples`，可按样本清单检查 readiness、真实 provider、真实 PR、security scan、worktree 隔离和远端副作用审批证据。
- 工作可用样本沉淀：CLI 新增 `eval work-usability record`，可把已完成 run 写入样本清单；`eval work-usability` 支持 `--report-md/--report-html` 生成可提交的样本评估报告。
- 敏感信息治理：新增共享 secret scanner，内置 `security-scan`、Artifact Store 和 CommandGateway 复用同一规则；artifact 写入前拒绝明显密钥，命令 stdout/stderr 落盘前脱敏。
- 远端 CI 状态证据：core 新增 `ci-status` artifact、delivery CI 查询和 PR 包 Remote CI 区块；CLI 新增 `delivery ci-status`，可只读调用 `gh pr checks` 并把 PR checks 状态写入 evidence 和 audit。
- 远端 CI watch：core 新增 PR checks 轮询能力和 `delivery.ci.watch-completed` 审计事件；CLI 新增 `delivery ci-watch`，可按次数、间隔和退避等待 PR checks 进入 `passed/failed/skipped` 终态，同时保留每次只读查询证据。
- 审批摘要：core 新增 human approval summary 和 `eval approval-summary` 评估；CLI 新增 `approval summary` 可复制审批摘要和 `approval reject` 拒绝入口；Web 待审批区展示同一摘要，包含风险、命令、影响文件、证据入口和批准/拒绝入口。
- 仓库画像缺失命令修复引导：core 新增 repo profile command guidance，CLI `workflow preflight` 在 commandRef 缺失时输出 `hint/profilePath`，并基于 `package.json` 的 `compile/test:e2e/playwright` 等候选脚本给出 `suggestedCommand`。
- 仓库画像显式不适用语义：repo profile 命令支持 `notApplicable: true` 和 `reason`；普通 command gate 会记录 `skipped/not-applicable` 并进入 readiness 和 PR 包，`security-scan` 仍保留内置扫描兜底。
- CLI 默认上下文推断：常规命令会自动发现当前 repo、最近需求卡、最近 run 和最近 pending human decision；`--repo`、`--run-id`、`--shape`、`--demand-file`、`--decision-id` 保留给跨仓库、历史对象和消除歧义场景。
- Codex provider P0 接线：core 新增 `createCodexAdapter` 和共享 manifest ingestion，CLI/Web 支持 `--agent codex`、provider snapshot resume 和 Web run 下拉选项；`eval work-usability record` 可记录 `expectedProvider: codex` 与真实 PR 要求。
- Codex provider 使用文档：README、主用户手册和 `docs/manual/codex-provider-smoke.md/html` 说明本机 Codex CLI、`codex --profile internal ... exec`、artifact manifest、权限边界和自举 smoke 流程。
- Standard Delivery 标准模板：新增完整 `standard-delivery` 内置 workflow，覆盖 PM 内审、PM/RD/QA 外部需求评审、RD 技术评审、QA 测试方案评审、独立变更评审、QA final signoff、QA signoff review 和 PMO checkpoint。
- Standard Delivery 交付可信度：非 `code-changes` 节点在 worktree finalize 前会被源码变更 guard 拦截；QA validation 会记录 tested ref，QA signoff、pre-PR readiness、PR package 和 readiness 会校验所测对象与交付对象一致。
- PMO 过程观测：Engine 在每个节点通过后写入 `pmo.node-checkpoint` 审计事件，记录节点状态、必需 artifact、gate 类型和最新 gate 状态；末端 PMO checkpoint 仍负责交付包完整性。
- Standard Delivery 强治理 gate：新增 `demand-review`、`implementation-plan`、`test-plan`、`ac-evidence`、`qa-release-signoff`、`process-checkpoint` 等 artifact schema，以及 `independent-review`、`role-scope`、`ac-evidence`、`qa-signoff`、`process-completeness` gate。
- Standard Delivery 角色边界：PM、RD、QA、reviewer、PMO 的 system 描述补充评审范围、不越权边界、独立评审要求和升级条件。
- Standard Delivery P1-0 seed run 归档：记录 `run_04b37267-2686-42c6-a0a4-9b37410f65f7` 在 RD Codex 节点 300 秒超时中断的证据和后续拆分策略。
- 长程任务产物进展观测：CommandGateway 的 no-progress 判定除 stdout/stderr 外，会扫描受控 `outputDir` 中的 artifact/manifest 等文件变化，排除自身 stdout/stderr/progress 文件，并在 progress JSON 中记录 `lastOutputDirActivityAt`、`outputDirFileCount`、`outputDirBytes` 和 `outputDirLatestMtimeMs`；1 小时默认预算和 2 小时级长程预算仍需 heartbeat、no-progress 与受控 outputDir 产物进展观测共同约束。

### 变更

- README 从阶段验收与增量清单改为项目级介绍，聚焦定位、工作流、核心能力、边界、快速开始、运行产物、仓库结构和文档入口。
- 项目品牌迁移为天工（Tekon）/tekon，CLI、包名、运行态目录、环境变量前缀、交付分支前缀、文档文件名和用户文档引用同步更新。
- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。
- `@tekon/core test:e2e` 覆盖 workflow engine、recovery、gate repair 和 dynamic constraint e2e。
- 发布说明从 Phase 2 本地 mock CLI 基线更新为 Phase 3 本地验收通过，不把真实 PR、自动 merge 或生产级真实 LLM workflow 写成已完成能力。
- Web 技术基线从计划中的 Next/tRPC 降级为本地 Node HTTP + Vite React dashboard，验收产物为 `packages/web/dist`；保留后续升级到远程多路由 Web 的空间。
- `init` 会根据目标仓库 `package.json` 自动生成仓库画像；正式远端 PR 仍需人工确认，当前新增的是本地 PR 准备包和工作就绪度判断。
- `eval readiness` 从“PR 准备可审阅”升级为“验收标准有证据、安全扫描通过、无 pending human gate、PR 已创建且远端 CI 通过”的工作就绪判断；PR 创建和远端 CI 通过已从推荐项升为必需项，merge/上线仍不自动化。
- `eval work-usability` 把 P0-2/P0-6/P0-7 的真实样本要求固化为阈值评估；默认阈值面向正式 dogfooding 样本集，可在受控 fixture 中通过 sample file 降低阈值做回归测试。
- 内置安全扫描从 gate 私有规则调整为共享规则集；当前覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。
- `delivery create-pr` 默认不执行远端副作用；只有显式 `--approve-human` 才 push 和创建 PR，并且不会提交主工作区未提交改动或 `.tekon` 运行态目录。
- `delivery prepare` 和 `delivery create-pr` 统一执行 pre-PR readiness：workflow passed、无 pending human gate、验证 gate 与安全扫描满足、AC evidence 完整、QA release signoff 通过且绑定 QA validation tested ref；不满足时不会生成 PR 包或创建远端 PR。
- Mock agent 从“每个节点写全量内置 artifact”调整为优先写 workflow 要求的 artifact 类型，更贴近真实 provider manifest 协议。
- Codex adapter 默认固定 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`，并拒绝 provider args 覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass 参数；`--add-dir` 只由 Tekon 受控追加到本节点 artifact 输出目录，安全边界参数会放在 `exec` 之前，匹配本机 Codex CLI 语法。
- 真实 provider 默认总超时从 300 秒调整为 1 小时，并写入 provider snapshot，降低长程 Codex/Claude Code 节点被短超时误杀的概率；CLI `run` 新增 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms`，Web dashboard 新增对应运行参数输入，允许对明确长程任务显式配置 2 小时以上外层预算；CommandGateway 同步写入 `*.progress.json`，记录命令状态、最近输出时间、stdout/stderr 字节数、受控输出目录文件数量和字节数、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数；默认无 stdout/stderr 或受控输出目录文件进展 15 分钟会触发 `no-progress` timeout，`delivery create-pr --approve-human` 的受控 `git/gh` 命令及前置只读 probe 也复用该超时和进展策略；diff 级续期和可恢复 job runner 仍待后续补强。
- Gate result 新增 `gateKey`，workflow 会为同一节点下的重复同类型 gate 生成稳定身份，例如多个 `schema` gate 会按 artifact/commandRef 区分；PMO `process-checkpoint` 也会带上 gateKey 证据，避免重复 gate 被误认为已经通过；human gate 审批会更新原始 gate result 并保留 gateKey，不再创建无 key 的 resume gate。
- CommandGateway 人工审批 note 复用命令参数脱敏逻辑，避免 `--token`、`--password` 或环境变量形式的敏感值进入 human decision 审阅面。
- SCM 远端交付对 delivery branch/base branch 做安全 ref 校验，并把实际生成的 `git branch`、`git push`、`gh pr create/view` 写命令加入 exact allow，避免 broad prefix allow 放大远端副作用边界。
- `workflow preflight` 对 schema、QA signoff、role-scope 等非命令 gate 显示 `status=not-command-gate`，与 repo profile 显式 `notApplicable` 的 `status=not-applicable` 区分开，避免把无需命令的语义 gate 误报成 command missing。
- Codex adapter 在 provider timeout 或非零退出后会尝试读取并校验 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件；只要 workflow 必需 artifact 已完整入库，就按 artifact 完成继续进入 gate。manifest 缺失、schema 非法、必需 artifact 不齐或非 timeout signal 仍按失败处理。若真实 Codex 误写出字面文件名 `TEKON_ARTIFACT_MANIFEST`，adapter 会在受控 `TEKON_OUTPUT_DIR` 内按同一 schema 兼容读取。
- 真实 provider artifact 协议增加节点职责边界和收尾约束：非 `code-changes` 节点只写 `TEKON_OUTPUT_DIR` 下的节点 artifact，不修改仓库工作区；所有需要 artifact 的节点先写 artifact 与 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件，再立即退出，且不在节点内启动嵌套 subagent 审阅或执行 `git add`、`git commit`、`git push`、PR 创建，避免 PM/QA 等节点继续执行下游实现、格式化、额外审阅或远端交付工作。
- 真实 provider artifact 协议明确结构化 JSON artifact 必须包含非空 `title` 和 `body`，并在 prompt 中要求 `demand-card`/`prd` 使用 `acceptanceCriteria[].id/description`；`code-changes` 的 provider-style JSON 在包含非空 `summary` 或有效 `changedFiles`/`verification` 条目时会被归一化为 Tekon 可审阅 artifact，`demand-card`/`prd` 的有效 `acceptance_criteria[].criterion` 也会被归一化为 `acceptanceCriteria[].description`，降低真实 Codex run 因字段命名漂移中断的概率。
- 真实 provider artifact 协议对评审类 artifact 增加严格 role-scoped review JSON 指引：prompt 会给出 `reviewScope`、`reviewProcess`、`decision`、`findings[].severity/message` 的合法字段和值，并写入目标节点和目标角色，避免真实 Codex 用 `reviewRole`、`reviewedArtifacts` 或数组/对象形式 `reviewScope` 产出无法过 schema/role-scope gate 的评审产物。
- 真实 provider 评审类 artifact 对 `findings[].ownerRole` 做窄归一化：若 provider 写出非角色枚举的 ownerRole，会把该值保留到 finding message 并移除无效 ownerRole；`reviewScope`、`reviewProcess.reviewerRole`、`targetRole` 和 `decision` 仍保持严格 schema 校验。
- 真实 provider `test-plan` artifact 协议明确要求 `testBasis` 和 `testCases` 字段；若 Codex 写出 provider-style `sourceArtifactsReviewed` 与 `testScenarios`，Tekon 会窄归一化为 schema 所需的测试依据和测试用例，避免 QA 测试方案因字段命名漂移中断。
- 真实 provider `test-report`/`ac-evidence`/`qa-release-signoff` artifact 协议明确要求 `criteriaEvidence[].criterionId/status/evidence`，其中 `evidence` 必须是字符串；需要 evidence anchor 的场景必须把 `outputPaths`、`gateResultIds` 或 `artifactIds` 放在对应 `criteriaEvidence` 条目内，不能只放在 artifact 顶层；`artifactIds` 只能使用 Artifacts 区展示的真实 `artifact_<uuid>`，不能使用 `nodeId:type` 标签；`gateResultIds` 只能使用 prompt 的 `Prior eligible gate results` 区展示的真实 `gateResultId`，不能使用 `gateKey`、`commandRef`、`outputPath` 或 gate 日志文件名；`qa-release-signoff` 还必须显式写入 `targetRef`、`validatedRef` 和 `overallStatus`，且 `overallStatus` 只能是 `passed`、`failed` 或 `blocked`，不能用 `decision` 或 `recommendation` 替代。若 Codex 在 `test-report`/`ac-evidence` 中写出对象形式 `summary`、带字符串 `summary` 的 evidence 对象、`criteriaEvidence[].id/evidenceSummary/coverage` 或 `passed_with_*`/`failed_with_*`/`blocked_with_*` 状态标签，Tekon 会窄归一化为 schema 所需字段；`qa-release-signoff` 不做这类 provider-style QA evidence 字段归一化，缺失状态、含糊状态、无 `summary` 的 evidence 对象、只有顶层 anchor 或只有 `criterion` 而无证据字段仍失败，避免 QA validation 已产出有效证据但因字段命名漂移中断，同时保持 QA final signoff 严格按 schema 表达。
- 真实 provider `ac-evidence`/`qa-release-signoff` prompt 明确：当前 QA validation 节点不应仅因 PR 创建、delivery package 或下游 PMO/QA signoff 节点尚未运行而阻塞；这些交付闭环由后续节点、pre-PR readiness 和受控 PR 创建继续校验。
- Web dashboard 从只展示 artifact/gate 路径和计数，升级为可直接审阅关键正文、日志、diff 和 PR 包的本地审阅面，并能在同一页面完成 run 发起、PR 准备和受控 PR 创建入口。
- `demand shape` 默认写入 `.tekon/demands/`，`demand approve`、`run`、`status`、`review`、`approval summary`、`resume --approve-human`、`delivery prepare` 和 `eval readiness` 等常规命令默认读取最近合适的上下文；历史需求卡和历史 run/decision 仍通过显式参数兼容。
- 审批摘要和 review surface 的建议命令在默认上下文中改为短命令，例如 `tekon resume --approve-human`、`tekon approval reject`、`tekon review`；显式查看历史 run/decision 时仍输出带 id 和 repo 的精确命令，避免复制后操作到最新上下文。
- 默认审批命令遇到同一 run 多个 pending human decision 时会拒绝歧义并要求 `--decision-id`；`resume --approve-human --decision-id <id>` 只批准指定 decision。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。
- 真实 provider `process-checkpoint` prompt 明确 `artifactEvidence[].nodeId/type`、`gateEvidence[].nodeId/gateType/gateKey/status` 和数字型 `humanDecisionEvidence.pending`，避免 PMO checkpoint 误写 `output`、`observedStatus` 或 pending 数组后无法通过 schema ingest。
- Web server 关闭时会主动关闭 idle/all connections，避免 dashboard e2e 或本地开发停止时被 keep-alive 连接挂住。
- Worktree finalize 提交节点变更时不再 broad `git add .`，改为只 stage `git status --porcelain` 中的非 `.tekon` 真实改动，避免真实 provider 运行态目录被 `.gitignore` 忽略时阻断节点 promote。

### 说明

- Tekon 已有本地 mock CLI 入口、本地 Web dashboard 和受人工批准的 PR 创建 fixture 覆盖，但仍未发布自动 merge、自动上线或生产级真实 LLM workflow。
- 交付 dry-run、prepare、create-pr、metrics、dogfooding 和 final acceptance 已记录本地验收结果；真实生产仓库使用仍需受控 fixture、明确人工批准和单独记录失败恢复证据。
- 当前 CLI/Web 主要用于本地验收和研发 dogfooding。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- Phase 2 本地 gate 已通过：`pnpm build`、`pnpm typecheck`、`pnpm test -- --run`、`@tekon/core test:e2e`、`@tekon/cli test:e2e`、`prettier --check .`。
- Phase 3 本地 gate 已通过：`install --frozen-lockfile`、`build`、`typecheck`、Vitest coverage、CLI release e2e、Web dashboard e2e。

### 后续发布范围外

- 自动 merge。
- 生产级真实 LLM workflow 稳定性。
- 远程多租户 Web 服务。
