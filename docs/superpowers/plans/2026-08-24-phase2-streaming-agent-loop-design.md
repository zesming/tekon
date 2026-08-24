# Tekon 阶段 2 详细设计 — 流式 Agent Loop 兼容层 + Provider Registry + 事件词汇补全

> 状态：**v3，已整合两轮 reviewer 评审（v1 的 M1–M4 + v2 复审的 R1 改写/rework 三处/driver seq/失败双发/NIT），待复审确认后进入实施**
> 前置：阶段 0（v0.8.0）、阶段 1（v0.9.0，Event Spine + 后台 Job + SSE）已合入 PR #10。
> 依据：报告 §8.3 事件词汇、§8.4 AgentDriver 契约、§10 阶段 2、§12-P0.5、§13.3/§13.6；`docs/reviews/...migration-review.md` §0.5 工程视角批注；explorer 实测代码摸底。

## 0. 目标与非目标

### 0.1 本阶段目标（报告点映射）

1. **补齐会话事件词汇的"agent 内容"部分**：当前 12 类核心事件只发 5 类，`assistant/message` 是合成的 "Run passed."。本阶段让**真实 agent 产出**（每个 node 的 role、prompt 摘要、工具/命令调用、产物、最终回答）进入事件流。对应报告 §8.3、§13.6。
2. **legacy `runAgent()` 桥接**：把"一次旧 adapter 调用 = 一个 step"映射为 `step/start → tool/call → tool/result → assistant/message → step/end` 事件序列，无需重写 Codex/Claude/Mock adapter。对应报告 §8.4、§10 阶段 2。
3. **Provider registry 化**：消除 `agent-runtime.ts` 两处重复的 `if/else` provider 分派，改为注册表（照搬 `gate/registry.ts` 已验证范式）。对应报告 §P1-02。
4. **Provider snapshot/version contract**：给 provider 快照加显式 version 字段与兼容校验，防 provider 升级静默破坏 replay/resume。对应报告 §10 阶段 2 交付项。
5. **模型可见历史可重建（§13.6）**：进入模型上下文的 `user/message`、`assistant/message`、`tool/result` 可从 event log 完整 replay；补 `buildModelVisibleView` 的真实消费与 e2e。

### 0.2 非目标（显式递延，防范围失控）

- **真正的增量 `assistant/chunk` 逐块流式**：依赖 provider 是否支持增量输出（Codex/Claude CLI 当前是一次性 JSON 输出）。**递延到阶段 2b**，先验证 provider 增量能力再做；本阶段（2a）以 step 粒度的 `assistant/message` 为准，不假装逐 token 流。
- **运行中 `followUp`/`steer`（mid-run 转向）**：需要 AgentHandle 长活 + inbox 语义 + engine 支持 mid-node 注入。**递延到阶段 2b**。本阶段 `AgentHandle` 的 `followUp`/`steer` 可先实现为"排队到下一 turn / 抛 NotSupportedYet"，不阻塞主链路。
- **`plan/updated`、`todo/updated`**：依赖 agent 产出结构化 plan（当前 workflow 模板即静态 plan）。递延到阶段 3/4 的 plan flow。
- **UI 消费**：阶段 3。本阶段只保证事件写入 + SSE 可回放；客户端不改。
- **CLI 会话化**：阶段 4。本阶段 CLI 路径不接事件流（保持现状），仅确保 registry 化不破坏 CLI。

### 0.3 不可动摇的约束（沿用阶段 1）

- **C1 治理零回归**：事件发射 best-effort，绝不 throw 进 governance/audit 路径；workflow/gate/audit 表仍是事实源。
- **C2/C3 双轨并存**：不删旧 adapter、不改 engine 主控制流的语义；新事件是 dual-write 的追加投影。
- **测试先行**：每子步先写/改测试；提交前全量 `pnpm test` 绿 + 三包 typecheck。
- **provider 能力护栏**：`assertAgentProviderCapabilities`（agent-adapter.ts）不得被 registry 化绕过。

## 1. 现状锚点（explorer 实测，file:line）

- 一次性契约：`AgentAdapter.runAgent(): Promise<AgentRunResult>` @ `packages/core/src/runtime/agent-adapter.ts:63`。
- 流式契约已冻结、零实现：`AgentDriver`/`AgentHandle`/`AgentRuntimeEvent` @ `packages/core/src/types/session-contract.ts:190-237`。
- provider if/else（两处重复）：`agent-runtime.ts:60-102`（createAgentRuntime）、`:108-164`（createAgentAdapterFromSnapshot）。
- node 执行 agent 调用点（评审复审：**三处，非单点**）：`node-executor.ts:235`（主执行）、`rework.ts:360`（rework 重跑）、`rework.ts:510`（review 重跑）。三处都是真实 agent 执行（产产物、影响 workflow），共享单元 `runAgentWithStepEvents` 必须**同时包住三处**，否则经历 rework 的 run 的 §13.6 "完整 replay" 主张不成立。`ReworkHandlerDeps`（rework.ts:42-47）已注入 `adapter`，同法加可选 `agentEventSink`，由 engine 线程化（与 node-executor 一致）。外包 role_run + lease 记账（node-executor.ts:188-272）。
- 事件缺口：核心 12 缺 `step/*`、`assistant/chunk`、`tool/*`、`plan/updated`、`todo/updated`；`assistant/message` 合成 @ `job-executor.ts:179-182`。
- 脱敏/present：`present.ts:44 presentEvent`、`:88 buildModelVisibleView`（无消费者）；spill TODO @ `present.ts:27`。
- provider 快照：`recordRunProviderConfig` @ `engine.ts:321`，restore zod 校验 @ `agent-runtime.ts:122-149`，**无 version pin**。

## 2. 设计：子步拆分（S1–S6，每步独立 e2e + 提交）

### S1 — Provider Registry（低风险，先行，解耦后续）

- 新增 `packages/core/src/runtime/provider-registry.ts`：`ProviderDefinition { name; create(config): AgentRuntimeResult; restore(snapshot, gateway): AgentRuntimeResult }` + `createBuiltInProviderRegistry()` 注册 mock/claude-code/codex，照搬 `gate/registry.ts` 结构。
- `createAgentRuntime` / `createAgentAdapterFromSnapshot` 改为 registry 分派（保留同名导出与签名，内部委派 registry；旧 if/else 删除）。未知 provider 抛原有错误信息。
- `assertAgentProviderCapabilities` 仍在每个 definition 的 create/restore 内调用。
- **测试**：registry 单测（注册/查找/未知 provider）；既有 `agent-runtime` 相关测试全绿（回归锁定 CLI+Web 构造路径不变）。

### S2 — Provider snapshot version contract

- `RunProviderConfig` 快照加 `schemaVersion: number`（当前记为 1）。restore 时校验：version 缺失（旧 run）→ 视为 v1 兼容；version 高于当前支持 → 抛 `ProviderSnapshotVersionError`（映射 CLI exit 1 / web 400），不静默降级。
- registry definition 声明 `snapshotVersion`；restore 比对。
- **测试**：v1 往返；缺 version 的旧快照仍可 restore；未来 version 抛错用例（构造 version=999）。

### S3 — Agent step 事件桥接（核心，legacy bridge）

**事件汇（sink）= dual-write bridge，不新造 `onAgentEvent(AgentRuntimeEvent)` 签名**（评审 M2）。理由：`AgentRuntimeEvent` 要求 `seq`，而 seq 由 `session-store.appendEvent` 内部分配（session-store.ts:229-237），发射方不知道 seq，按该签名实现只能伪造。改用 `SessionDualWriteBridge.recordFromRun({runId, type, payload, modelVisible, correlationId})`（dual-write.ts:207-215）——"无 seq 的待持久化事件"形状，且内部已 best-effort（findSessionByRunId 查不到静默跳过 + try/catch 包住 appendEvent 与 `bus.publish`）。

**接线**：web `buildEngine` 构造 engine 时多传可选 `agentEventSink`（= bridge）→ `CreateWorkflowEngineOptions`（engine.ts:79）加可选字段 → engine.ts:210 构造 node-executor 时传入。**CLI 不传 → 无 sink → 无事件**，registry 化对 CLI 透明。

**C1 硬约束**（评审 M2）：`bus.publish`（event-bus.ts:23-31）**不捕获 subscriber 异常**。发射**必须**经 bridge（或同等 try/catch 包装），**禁止**在 node-executor 里裸调 `appendEvent + bus.publish`——否则 subscriber 一抛错就穿进 node 执行路径、node 被误标 interrupted（治理回归）。

**共享序列所有者**（评审 D1 → 方案 C）：抽 `runAgentWithStepEvents(adapter, input, sink, meta): Promise<AgentRunResult>`，拥有**完整序列**（不只"返回后映射"）：
1. 发 `step/start`（payload: `stepId=randomUUID()`、nodeId、role、promptSummary（脱敏+限长）；设 `correlationId=stepId` 便于 2b UI 分组）。
2. `await adapter.runAgent(input)`，按**三条路径**分流（评审 M1，区分 cancel/failure/throw；**检查顺序：先判 `result.cancelled || signal.aborted`，再调 `assertSuccessfulAgentRun`**——assert 对 `exitCode !== 0` 抛错而 cancel 时 exitCode=null，顺序颠倒会把 cancel 误判为 failure，helpers.ts:286）：
   - **成功**（`assertSuccessfulAgentRun` 通过）：发 `tool/call`+`tool/result`（node 级摘要，`modelVisible:true`，payload 标 `summaryLevel:'node'`）→ `assistant/message`（`modelVisible:true`，内容 = **产物元数据合成摘要**：role/结论/产物引用，**非模型原文**——原文依赖 2b 增量输出）→ `step/end{status:'passed'}`。
   - **取消**（`agentResult.cancelled` 或 `signal.aborted`；mock adapter exitCode=null）：**仅**发 `step/end{status:'cancelled'}`，**不发 `agent/error`**（对齐阶段 1 MF1 单发射纪律：cancel 事件只由 web cancel 路由发一次，job-executor.ts:129-138）。
   - **失败**（timedOut / exitCode≠0，assertSuccessfulAgentRun 抛）：发 `agent/error` + `step/end{status:'failed'}`。
   - **adapter 抛异常**（子进程崩溃）：发 `agent/error`+`step/end{status:'failed'}` 后**原样 rethrow**，不吞。
3. 成功返回 result；失败/崩溃 rethrow（保持既有 interrupted 记账不变）。

node-executor 用它包住 :235 的调用;**rework.ts:360 与 :510 两处也用它包住**（评审复审：共有三个发射点，一套语义）;S5 的 driver `start()` 内部同样调它 → 所有发射点、一套序列语义,漂移在结构上消除。
- `assistant/message` 词表 status 与 workflow 对齐用 `passed|failed|cancelled`（评审 NIT）。
- job-executor 合成 `assistant/message`（:179-182）**移除**（评审 D4，见 §5）。
- **测试**：见 §4（事件序列 + 失败/取消分支 + C1 故障注入 + 闭集断言扩展）。

### S4 — 模型可见历史 replay（§13.6）

- **modelVisible 决策**（评审 M3）：`assistant/message` 与 `tool/result` 标 `modelVisible:true`（工具结果属模型上下文语义）；`tool/call`、`step/start`、`step/end` 保持 ui-only（`modelVisible:false`）。否则 `buildModelVisibleView`（present.ts:88）过滤后看不到 tool/result，§13.6 三要素断言会失败或被掏空。
- `buildModelVisibleView` 补真实消费点：读层加"重建模型上下文"投影/断言路径。
- **诚实边界**（评审 S5/S4b）：2a 证明的是"日志**可重建**出模型可见视图"（reconstructable），**不等于**"agent 当时上下文就是从日志派生"——`promptBuilder.buildNodePrompt` 仍从 repositories 构建，不消费事件；接通是后续阶段。测试命名/断言用 reconstructable，不暗示等价。`resumeFromGate` 分支（node-executor.ts:138-161）不跑 agent、无 step 事件,故"升级前开始的 run"其已完成 node 无 assistant/message,视图不完整——§13.6 主张只对"node 在升级后执行"的 run 成立,测试用全新 run。
- **测试（§13.6 核心）**：多 node run → `listEventsSince(0)` 过滤 modelVisible → 断言可重建 user/message + 每 node 的 assistant/message + tool/result，**顺序与执行顺序一致**，且 assistant/message payload 含 nodeId/role/产物引用（非仅存在性，防 vacuous）；断线续传用"0..k 与 k..end 拼接 == 0..end"断言。

### S5 — AgentDriver/AgentHandle 兼容实现（桥接既有 adapter）

- 新增 `packages/core/src/runtime/legacy-agent-driver.ts`：实现 `AgentDriver`，`start`/`resume` 返回 `AgentHandle`：
  - `events()`：AsyncIterable，产出 S3 的 `runAgentWithStepEvents` 同一套 step 事件序列（**复用共享单元，不另写一套**，评审 D1）。
  - `whenIdle()`：resolve `AgentOutcome`（done/failed/cancelled）。
  - `pause()`：返回 `{paused:true, interruptible:false}`（当前工具不可中断，node 边界生效——诚实语义 §0.5）。
  - `cancel()`：透传 AbortSignal（复用阶段 1 subprocess registry 取消链）。
  - `followUp`/`steer`：抛类型化 `NotSupportedYet`（评审 D2；排队会引入 inbox 语义与静默丢弃风险，2a 无生产调用方，抛错即契约锚点）。
- **engine 不立即切 driver**：node-executor 走 adapter + `runAgentWithStepEvents`;driver 是"契约首个实现 + 单测锚点",与 node-executor 共享同一序列单元。engine 全面切 driver 是 2b/阶段 4 的事（不推荐"node-executor 为每 node 造 driver 泵 AsyncIterable"——零流式收益下徒增间接层 + cancel 两套，评审 D1）。
- **测试**：driver 单测（start→events→whenIdle；cancel 中断；pause interruptible=false；followUp/steer 抛 NotSupportedYet）。

### S6 — 回归 + 文档 + 版本

- 全套件回归（core/cli/web/playwright）；三包 typecheck。
- 文档：CHANGELOG v0.10.0；用户手册（若有用户可见变化——本阶段主要是事件流，UI 未变，可能仅补"事件流现在含真实 agent 步骤"说明）；设计文档标记 S1–S6 完成。
- **bump 0.9.0 → 0.10.0**（MINOR：新增事件词汇 + registry + version contract，行为增强，无 breaking）。

## 3. 关键权衡与风险

- **R1 事件序列单一所有者（D1 已裁定方案 C，风险关闭）**：不存在"两套事件序列"——`runAgentWithStepEvents` 是唯一的序列所有者（含 step/start + 三分支 + step/end），node-executor（:235）、rework（:360/:510）、S5 driver 全部调它、共享同一逻辑，sink 可插拔。序列漂移在结构上消除，非靠评审纪律约束。
- **R-driver：driver `events()` 的 seq 来源**（评审 SHOULD1）：`AgentHandle.events()` 契约返回的 `AgentRuntimeEvent` 强制 `seq`（session-contract.ts:192），而 bridge `recordFromRun` 返回 `void`、丢弃持久化事件（含 seq）。**裁定**：driver 侧用 "collecting sink"——一个实现 sink 接口的适配器，内部调 `sessions.appendEvent`（拿到带 seq 的持久化事件）+ try/catch `bus.publish`（同 bridge 的 best-effort 包装），再把持久化事件 `yield` 给 `events()`。这是**受背书的第二持久化路径**（driver 独有），不是 M2 否决的伪造 seq。node-executor/rework 路径仍用 bridge sink（不需要 seq）。共享单元对 sink 只要求"接收无 seq 的待持久化事件"接口,两种 sink 实现都满足。
- **R-fail：失败路径 agent/error 双发**（评审 SHOULD2）：node 失败时,agent-loop 发 node 级 `agent/error{nodeId}`,job-executor settleByWorkflowStatus 的 interrupted 分支**另发**run 级 `agent/error{runId,status:'interrupted'}`（job-executor.ts:203，既有）。这**不是回归**（MF1 单发射纪律只约束 cancel,不约束 error);§4 失败路径测试须断言"node 级 agent/error 含 nodeId 存在 + run 级既有发射不变",不写会误判的精确总数断言、也不"顺手改成单发"。
- **R2 modelVisible 内容膨胀**：真实产出可能大。沿用 present 限长（1MB modelVisible），超限走 spill（present.ts:27 TODO——本阶段递延，先截断 + `{_truncated,bytes}` 标记，spill 到 2b/阶段 3）。截断事件的 modelVisible 内容不完整（诚实标注）。
- **R3 tool/call 摘要粒度**：一次 runAgent 是黑盒，拿不到细粒度工具调用；本阶段 tool/call 是"node 级摘要"（payload 标 `summaryLevel:'node'`），非真实每次工具调用。细粒度 tool 事件需 provider 支持结构化输出（2b）。
- **R4 provider 能力回归**：能力护栏 `assertAgentProviderCapabilities` 实际在 adapter 工厂内（codex-adapter.ts:76、claude-code-adapter.ts:52），registry definition 通过这两个工厂构造 adapter 即天然保留。S1 测试用危险 permissionProfile 构造每个 definition 断言抛错,锁定未绕过。
- **R5 CLI 不接事件流**：registry 化后 CLI 仍走 adapter、不传 sink；确保 CLI 测试全绿，registry 对 CLI 是透明重构。

## 4. e2e / 测试计划（对齐 §13.6 + 阶段 2 验收）

| 测试文件 | 覆盖 |
| --- | --- |
| `core/__tests__/runtime/provider-registry.test.ts`（新） | S1 注册/查找/未知；**每个内建 definition 的 create/restore 用危险 permissionProfile 构造 → 断言 `assertAgentProviderCapabilities` 抛错**（评审 S1，护栏在 adapter 工厂内，锁定 registry 未绕过）；S2 version 往返 + 缺失=v1 兼容 + version=999 抛 `ProviderSnapshotVersionError` |
| `core/__tests__/runtime/legacy-agent-driver.test.ts`（新） | S5 driver start→events→whenIdle；cancel 中断；pause interruptible=false；followUp/steer 抛 NotSupportedYet |
| `core/__tests__/phase2/agent-loop-events.e2e.test.ts`（新） | S3+S4：一次 run → step/start→tool/call→tool/result→assistant/message→step/end 序列；modelVisible replay（§13.6，断言 payload 含 nodeId/role/产物引用 + 顺序一致 + 断线 0..k∪k..end==0..end） |
| **`core/__tests__/phase2/agent-event-c1.test.ts`（新，治理红线）** | **C1 故障注入**（评审 M4-1）：注入 sink（appendEvent reject / bus subscriber 抛错）→ 断言 node 仍 passed、workflow 仍 passed、无异常逃出 node-executor |
| **失败/取消路径**（并入 agent-loop-events 或 node-executor 单测，评审 M4-2） | adapter exitCode=1/timedOut → 发 `agent/error`+`step/end{failed}` 且 node 仍走既有 interrupted 记账；signal abort → **未发** `agent/error`、发 `step/end{cancelled}` |
| **`session-job-e2e.test.ts` 改**（评审 M4-3/M4-4） | ① 闭集泄漏断言（:549-577）**有意识扩展**第四类"agent-loop 事件"，**字面枚举** `step/start, step/end, tool/call, tool/result`（**禁用 `startsWith('step/')` 前缀匹配**，否则未来子类型泄漏不报错）；D4 后 `assistant/message` 从 lifecycleTypes **移入**第四类（它现在来自 agent-loop 而非生命周期）；注释说明理由。② D4：移除合成 assistant/message 后,harness 镜像 settleByStatus（:252-257）与精确文本断言（:255 `Run ${runId} passed.`）改为"N node → N assistant/message,无 run 级合成";**harness buildEngine（:198-214，已有 bridge 实例 :194）必须传 `agentEventSink`**,否则事件不发、断言必挂 |
| 既有 `agent-runtime` / CLI run | 回归：registry 化透明，CLI 仍绿（无 sink→无事件） |
| Playwright | 回归：UI 未变，8 项仍绿 |

## 5. 待决问题 — 评审已裁定

- **D1**：方案 C——抽 `runAgentWithStepEvents(adapter, input, sink, meta)` 拥有**完整序列**（step/start + 三分支 + step/end），node-executor 与 driver 都调它。不采用"node-executor 直接用 driver"（零流式收益下增间接层 + cancel 两套）。
- **D2**：`followUp`/`steer` 抛类型化 `NotSupportedYet`，不排队（排队引入 inbox 语义 + 静默丢弃风险；2a 无生产调用方，抛错=契约锚点）。
- **D3**：spill **递延** 2b/阶段 3；本阶段 present 截断 + `{_truncated,bytes}` 标记，R2 注明截断事件 modelVisible 内容不完整。
- **D4**：**移除**合成 assistant/message（非兜底）；同步改 job-executor.ts:177-182 + e2e harness 镜像 :252-257 + 断言 :255。接受退化场景（空 plan/全 resume-at-gate）零 assistant/message（与现状一致，不回归）。
- **D5**：**0.10.0（MINOR）**——新事件类型/registry/version 字段（缺省=v1）全为加法，无 breaking。

## 6. 决策记录（评审 v1 已裁定，落规格）

| ID | 决策 | 依据 |
| --- | --- | --- |
| M1 | step 事件三分支：cancel→仅 step/end{cancelled}（不发 agent/error）；failure→agent/error+step/end{failed}；throw→发事件后 rethrow | MF1 单发射纪律、mock adapter exitCode=null |
| M2 | 事件汇 = dual-write bridge（`recordFromRun`，无 seq、best-effort）；禁裸调 appendEvent+bus.publish（bus.publish 不捕 subscriber 异常，C1 回归） | dual-write.ts:218-251、event-bus.ts:23-31 |
| M3 | `tool/result`+`assistant/message` modelVisible=true；assistant/message 为产物元数据合成摘要（非模型原文，2b 才有原文） | present.ts:88、AgentRunResult 无模型文本字段 |
| M4 | 补 C1 故障注入 + 失败/取消路径 + 闭集断言扩展第四类 + D4 三处清扫 | 评审 M4 |
| S1(评审) | 护栏在 adapter 工厂（codex/claude-code-adapter），不搬进 registry；测试锁定 definition 走工厂 | codex-adapter.ts:76、claude-code-adapter.ts:52 |
| S2(评审) | schema_version 存储：`addColumnIfMissing(run_provider_configs, schema_version, integer not null default 1)`；domain.ts:286-292 zod default(1);高版本仅在 web 同步 resume 映射 400,job 路径表现为 job failed | migrations.ts:235-244、engine.ts:321、repositories.ts:371-391 |
| S4(评审) | 每 node 生成 stepId=randomUUID() 入 payload + correlationId；不强求 sourceEventSeqs | session-contract.ts |
| 复审-B | `runAgentWithStepEvents` 包住**三处** runAgent（node-executor:235 + rework:360/:510），rework 加可选 agentEventSink，否则 rework run 的 §13.6 主张不成立 | rework.ts:42-47,360,510 |
| 复审-driver | driver `events()` 用受背书的 collecting sink（内部 appendEvent 拿 seq + try/catch publish + yield），非伪造 seq；node/rework 路径仍用 bridge sink | session-contract.ts:192、dual-write.ts:215 |
| 复审-fail | 失败路径 node 级 agent/error 与 job-executor run 级 agent/error 双发是既有非回归；测试断言 nodeId 存在 + run 级不变，不写总数断言 | job-executor.ts:203 |
| 复审-NIT | M1 检查顺序（先 cancel 后 assert）；闭集第四类字面枚举非前缀；assistant/message 移入第四类；harness buildEngine 传 sink | helpers.ts:286、session-job-e2e.test.ts |
