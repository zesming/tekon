# 阶段 3 详细设计：Human-first Session UI（v2，客户端会话读路径 + 三栏交互）

- 状态：v2 已纳入 opus 设计评审的 2 MUST-FIX + 6 SHOULD + 3 NIT（两轮评审裁定 buildable）；**3a-3d 全部实现完成（v0.11.0）**
- v1→v2 修订：M1（rpc token 死代码/生产 401 顺带修复）、M2（session.list 服务端解析 workspace）、S1（inline 卡片走 gate.list 补全）、S2（3c e2e 经 project.run 真实建 session）、S3（D1 措辞订正）、S4（删除错误的眼睛按钮/P1-02 引用）、S5（3a e2e 分层）、S6（session.list 刷新机制）、N1-N3（计数/契约订正）
- 权威上游：报告 §10 阶段 3、§13.1/13.4/13.7/13.9/13.10；`docs/reviews/2026-08-20-...-review.md` §0.5 阶段 3 批注（工程视角，落地以此为准）
- 前序：阶段 0（v0.8.0）、阶段 1（v0.9.0 Event Spine + SSE 服务端）、阶段 2（v0.10.0 Agent Loop 事件 + 模型可见 replay）均已合入 PR#10、CI 绿
- 现状实测来源：explorer 全量摸底（2026-08-24），所有 file:line 均为实测

## 0. 目标与非目标

### 0.1 目标（本阶段交付）

把**已经在事件流里的会话事实**（阶段 1/2 已让 SSE 端点承载 session/turn/step/tool/assistant/governance 事件）第一次接到**客户端**，形成 human-first 的连续叙事交互：
- 客户端能消费 SSE、断线重连、Last-Event-ID replay（服务端已支持，客户端零实现 → 本阶段建）。
- 客户端能列出/打开 session（新增最小 `session.*` 读 RPC + store `listSessions`）。
- 三栏 Session UI：session list（左）+ event feed（中）+ 运行控制/审批/卡片（右）。
- inline approval + tool/diff/artifact/final-result 卡片，复用既有审批与展示组件。
- 运行中 pause/cancel/resume（复用 RunControls，接上此前被丢弃的 sessionId）。
- 旧 Dashboard 与 run-detail 全部**保留**、移到 `/advanced`（C2 双轨并存，不删）；新 Session UI 成为默认 `/`。

### 0.2 非目标（显式递延，勿当缺口）

- **真正的 follow-up/steer 运行中转向**：依赖阶段 2b 的 `AgentHandle.followUp/steer`（当前抛 `NotSupportedYet`）。本阶段 composer 只支持"新起 session/run"与"对 paused/blocked run 的 resume/approve"，**不注入运行中消息**。UI 对不可用动作显示禁用态 + 诚实提示，不假装能转向。
- **真实模型散文流式**：`assistant/message` 是产物元数据合成（阶段 2 M3），`assistant/chunk` 无生产者（2b）。feed 必须诚实标注"摘要"，不渲染成模型原文逐字流。
- **行级 diff**：现 `DiffViewer` 只有摘要（branch/stat/changedFiles）；行级 diff 卡片递延（本阶段复用摘要卡）。
- **多 workspace 管理 UI**：当前一 run 一 session、单默认 workspace。workspace picker 降级为占位（列出默认 workspace 即可），完整多 workspace 递延阶段 4/5。
- **CLI 会话化**：阶段 4。本阶段只动 web 客户端 + 最小读 RPC。

### 0.3 硬约束（治理零退化，贯穿全阶段）

- **token 绝不进 URL**：SSE 鉴权沿用 `x-session-token` 请求头（见 §3 决策 D1）。禁止 query-param token（会泄漏进 access log/history/referrer → 安全回归，违反报告 §11"实时输出泄露敏感信息"风险项）。
- **present 脱敏不得绕过**：客户端只消费服务端 `presentEvent` 投影后的事件（已脱敏、限长、internal 不下发）。客户端不得新增任何绕过 present 的读路径。
- **inline 展示 ≠ 取消规则**：inline approval 卡片只是 `gate.approve/reject` 既有 RPC 的新入口，服务端审批/CAS/审计语义完全不变；P0-03"未批准 shaped demand 不得运行"不受影响。
- **旧引擎/旧页面不删**：`/advanced` 保留全部旧页面，autonomous/headless 链路不受影响。
- **顺带还既有测试债（M1，§0.4 原则）**：实测确认 `auth:'session'` 读 RPC（`review.get`/`gate.list`/`artifact.list`/`audit.list`/`progress.list`）在**生产中全部 401**——`setRpcSessionToken`（`rpc-client.ts:27`）零调用方，token 头从未发送，仅被 e2e fetch 猴补掩盖。阶段 3 3a 必须顺带修复 rpc-client↔AuthContext 的 token 接线（同一处修复既解生产 401、又给 SSE 客户端 token 源），并补不依赖猴补的测试防假绿。这是"数据飞轮 + 既有债先还"，非范围蔓延。

## 1. 现状锚点（explorer 实测，file:line）

- **SSE 服务端就绪**：`GET /api/sessions/:sessionId/events`（`packages/web/src/server/sse.ts:24-182`），`x-session-token` 头鉴权（`http.ts:435-457`）、Origin 同源校验（`http.ts:423-433`）、`?sinceSeq=` / `Last-Event-ID` replay（`sse.ts:50-57`）、先订阅后回放零丢失（M6，`sse.ts:93-156`）、15s 心跳（`sse.ts:172-181`）、present 脱敏/限长/internal 过滤（`present.ts:44-64`）。帧：`id:<seq>` + `event:<type>` + `data:<JSON>`。
- **客户端零会话读路径**：无 `EventSource`（grep 零命中）、无 `session.*` RPC（`rpc-contract.ts` 现有 11 路由器）、全部页面读 legacy 表（`review.get`/`project.*`/`gate.list` 等，见 explorer B 表）。
- **token 接线断裂（M1 实测）**：`setRpcSessionToken`（`rpc-client.ts:27`）零调用方 → `rpcSessionToken` 恒 null → `rpc.call`（`:67-68`）从不发头；`auth:'session'` 读 RPC 生产 401；SSE 端点（`http.ts:304`）同样要头。token 只在 `AuthContext`（`auth-context.tsx:38`），未同步给 rpc-client。
- **sessionId 已返回但被丢弃**：`project.run`→`{run,sessionId,jobId}`（`project.ts:278-283`），`resume`/`pause`/`cancel`/`gate.approve` 同样返回；客户端全部只取 `run.id`（`StartRunForm.tsx:121-127`、`ApprovalsPage.tsx:80-96`），`sessionId` 客户端零引用。
- **store 读面**（`session-store.ts:26-59`）：有 `getSession`/`findSessionByRunId`/`getRunIdBySessionId`/`listEventsSince`/`latestSeq`；**无 `listWorkspaces`/`listSessions`** → 3a 需补 `listSessions`（只读查询，零迁移）。
- **死代码**：`use-run-poller.ts`（仅 `hooks/index.ts:3` re-export，无消费者）→ 3a 删除。
- **状态层**：手写 `QueryCache`（`query-cache.ts`）+ `useQuery`/`useMutation`，**无轮询**、无 React Query。SSE 订阅需新建独立于 QueryCache 的 live store（见 §3 D3）。
- **复用组件**：`DecisionCard`/`DecisionForm`/`ApprovalSummary`（完整审批 UI）、`RunControls`+`runControlAffordances`（已单测）、`CodeBlock`、`AuditTimeline`（时间线范式）、`ArtifactsTab` 范式、`DiffViewer`（摘要）、`ConfirmButton`、`Card`/`StatusBadge`/`EmptyState` 等原语。
- **e2e harness**：Playwright fixture `createWebFixtureProject`（`__tests__/fixtures/project.ts`）播种 2 run + token=`fixture-session-token`，**不播种 session**；`beforeEach` 猴补 `window.fetch` 仅对 `/api/rpc` 注入 token 头（`shared-fixture.ts:38-61`）。vitest 侧**已有 SSE 测试资产**：`__tests__/api/session-sse.test.ts` 的 `collectSse`/`parseFrames`/`seedSession`。

## 2. 子步拆分（3a–3d，每步独立 e2e + 提交；顺序依赖，不可并行）

> 依赖链：3a（读路径+SSE 客户端）是地基 → 3b（feed+composer）依赖 3a 的 live store → 3c（卡片+inline approval）依赖 3b 的 feed 渲染框架 → 3d（重连硬化+旧页迁移）收尾。任一子步 e2e 不过即停在该子步。

### 3a — 会话读路径 + SSE 客户端 + token 接线修复（地基）

**服务端（core + web）**
- core：`SessionEventStore` 新增 `listSessions(workspaceId, opts?)`（只读，按 `created_at desc`，返回 `Session[]`；零迁移，纯 SELECT——`sessions` 表已有 `workspace_id/title/status/run_id/created_at/updated_at`，`migrations.ts:182-192`）。补对应单测。
- web：新增 `session` 路由器（`routers/session.ts`）+ 契约（`rpc-contract.ts`）**两个过程**（明确不做 `session.events`，事件走 SSE）：
  - `session.list`：**输入 `z.undefined()`（或 `{limit?}`）**；服务端经 `getOrCreateDefaultWorkspace(projectContext.projectRoot)` 解析当前 workspace（复用 `project.run` 的既有范式 `project.ts:239-241`），返回 `{workspaceId, sessions:[{id,title,status,runId,createdAt}]}`——workspaceId 回传以喂占位 workspace picker（M2：客户端本无 workspaceId，必须服务端解析并下发）。runId 直接取自 `sessions.run_id` 列（`SessionRow.run_id`，`migrations.ts:188`；store 映射时带出，无需逐条 `getRunIdBySessionId`，NIT-1）。
  - `session.get`：输入 `{sessionId}`；返回 Session 元信息 + **组合的 runId**（Session schema 无 runId 列，`session-contract.ts:56-64`；服务端用 `getRunIdBySessionId` 组合，`session-store.ts:41`，无需改契约，N3）。
  - 鉴权：`auth: 'session'`，挂 `/api/rpc` 下复用既有 origin + 头校验——**但见下方 M1 修复**，否则和现有读 RPC 一样生产 401。

**客户端（web client）— 含 M1 token 接线修复（先于 SSE，否则一切读路径生产 401）**
- **M1 修复**：`AuthProvider` 在 token 变化时调 `setRpcSessionToken(token)`（`auth-context.tsx:41-43` 的 setToken / :46-57 的 effect 里同步），使 `rpc.call` 真正带 `x-session-token` 头。一处修复同时解决预存的 5 个 `auth:'session'` 读 RPC 生产 401 + 为 SSE 客户端提供 token 源。补一条**不经 fetch 猴补**的测试（直连 `/api/rpc` 带/不带头断言 200/401），防假绿。
- 新建 SSE 客户端 `lib/session-stream.ts`：**fetch + ReadableStream 手写 SSE 解析**（非 `EventSource`，理由见 §3 D1），token 从 `useSessionToken()`（AuthContext）取并自设 `x-session-token` 头（不依赖 rpc-client 内部态）；**用字符串 URL 调 fetch**（e2e 猴补只处理 string input，`shared-fixture.ts:48`）；解析 `id:/event:/data:` 帧；断线自动重连带 `Last-Event-ID`（= 已见最大 seq）续播；`AbortController` 卸载取消；心跳帧（`: ping`）忽略。
- 新建 live event store `hooks/use-session-stream.ts`：订阅一个 sessionId，维护 `events`（按 seq 去重升序）、`connState`（connecting/live/reconnecting/closed）、`latestSeq`。独立于 QueryCache（D3）。**并在见到状态翻转类事件时 invalidate `session.list` 查询**（S6+SHOULD-1：触发集须显式含 `session/created`（composer 起新 run 后左栏出现新 session）、`approval/requested`/`approval/decided`（status 在 active↔awaiting-approval 翻转，`human-gate.ts:62-67`）、`turn/end`/`workflow/node-ended`（终态）——否则最常见的两条路径左栏状态徽章不刷新）。
- 接上被丢弃的 sessionId：`StartRunForm`/审批动作**在 3a 捕获**返回的 `{sessionId}`（**跳转 Session Detail 在 3b 接**，3a 该页尚未建，NIT-2）。
- 删除 `use-run-poller.ts` + `hooks/index.ts:3` 的 re-export。

**e2e（3a 验收——S5：3a 无承载流的页面，Playwright 分层）**
- core 单测：`listSessions`（空/多 session 排序/未知 workspace）。
- web api（vitest）：`session.list`/`session.get` 契约（空/多 session/未知）；**M1 防假绿测**：直连 `/api/rpc` 调 `session.list`，带正确头→200、缺头→401（不经猴补，参照 `session-sse.test.ts` 的原生 HTTP 范式）。
- web client 纯逻辑（vitest）：SSE 帧解析器（多帧/半包/心跳跳过/CRLF）、去重与 seq 单调、Last-Event-ID 计算。
- **Playwright 推迟到 3b**：3a 不含承载流的页面（Session Detail 在 3b 建），故"建流→live"的浏览器级 e2e 随 3b 落地；3a 验收停在 vitest 层 + RPC 契约测。

### 3b — Event Feed + Composer

- Session Detail 页（`/sessions/:sessionId`）：中栏 event feed 消费 3a 的 live store，把 typed 事件渲染为连续叙事（turn 分组 → step → tool/assistant/governance）。改造 `AuditTimeline` 视觉范式吃 `{seq,type,timestamp,payload}`。
- 事件类型 → 渲染映射表（feed 行渲染器）：`user/message`/`assistant/message`（合成，标"摘要"）/`tool/call`+`tool/result`（成对折叠）/`step/*`/`turn/*`/`agent/error`/治理事件（node/gate/artifact/approval 摘要行）。未知/未来类型 → 通用降级行（不崩）。
- Composer（改造 `StartRunForm` textarea 范式）：起新 session/run；对 paused/blocked run 显示 resume/approve 入口（不注入运行中消息，§0.2）。
- 诚实标注：合成 assistant、`_truncated` 事件（阶段 2 spill 递延）均显式标注。

**e2e（3b）**：Playwright 真实跑一个 mock-agent run（参照 `create-pr-approval.test.ts:55-101` 经 `project.run` 建 session + 事件），断言：① （S5 从 3a 移入）Session Detail 建流→初始 replay→`connState` 达 live；② feed 出现 user/message → step/tool/assistant → turn/end 且顺序正确、合成标注可见。需扩展 fixture 的 fetch 猴补 URL 匹配 `/api/rpc` → `/api/rpc|/api/sessions`（`shared-fixture.ts:49`）。

### 3c — inline approval + tool/diff/artifact/final-result 卡片

- 右栏：`approval/requested` 事件 → 渲染 `DecisionCard`/`DecisionForm`（复用）。事件载荷只有 `{runId,nodeId,decisionId,request}`（`dual-write.ts:352-359`），**审批完整上下文（riskLabel/approvalSummary/证据）经 `gate.list` 按 runId 拉 pendingDecisions、按 decisionId 匹配补全**（S1：`session.get` 只有元信息，补不了 decision 上下文；`gate.list` 是唯一带 `approvalSummary` 的现有 RPC，`routers/gate.ts:18-44`），approve/reject 调既有 `gate.approve/reject`（语义/CAS/审计不变，§0.3）。
- 卡片：tool（CodeBlock）、artifact（ArtifactsTab 范式 + `artifact/created` 事件）、diff（DiffViewer 摘要）、final-result（turn/end + 交付摘要）。
- 运行控制：pause/cancel/resume 复用 `RunControls` + `runControlAffordances`，接上 sessionId；cancel 走既有 `agent/cancel-requested`+`agent/cancelled` 事件链，UI 显示确认态（报告 §11"取消语义不完整"缓解：明确 interruptibility）。

**e2e（3c）**：Playwright **经 `project.run` 起一个带 human gate 的模板**真实建 session + 经 dual-write 发 `approval/requested`（S2：fixture run_1 用裸 repositories 播种、无 session、无 approval 事件，不能复用）。**注意（实测）**：fixture 现有 `project-feature.yaml` 只有 build/lint/schema gate、**无 human gate**（`fixtures/project.ts:54-85`），built-in 模板是 `<repo>/workflows/*.yaml` 运行时加载（`template.ts:487`）。故 3c 须**向 fixture 写入一个含 `type: human`/`requiresHumanApproval` 节点的模板**（如 `project-feature-approval.yaml`），非复用现成文件——这是 3c 的实打实 fixture 负担。断言 inline 卡片出现、approve 后 run 推进、事件流反映决策。

### 3d — 重连硬化 + 旧 Dashboard 移 `/advanced`

- 重连硬化：指数退避 + 上限、`Last-Event-ID` replay 拼接（0..k ∪ k..end 去重一致，复用阶段 1 已验证的 replay 语义）、可见的 `connState` 提示（reconnecting badge）、reduced-motion 友好。
- 路由迁移：新 Session UI 挂 `/`（默认）；旧 Dashboard/Runs/Run-detail 全部移到 `/advanced/*`（`App.tsx` 路由 + Sidebar 导航；C2 保留全部旧页面，零删除）。
- （可选增强，S4）Run detail 的 `RunControls` 眼睛按钮当前有 `canView && onView` 守卫、`RunDetailPage.tsx:157` 不传 onView 故**不渲染**（非冗余、无 bug、与报告 P1-02"Engine 特权核心"无关——原 v1 表述有误已删）；如需可给 RunDetailPage 传 onView 跳转对应 Session Detail，作为锦上添花，非本阶段必做。

**e2e（3d）**：Playwright 断线重连（关流→重连→replay 无重复/无丢失）；`/advanced` 旧页面仍可达且渲染；默认 `/` 为 Session UI。

## 3. 关键决策（待评审裁定）

| ID | 决策 | 依据 |
| --- | --- | --- |
| **D1** | SSE 客户端用 **fetch + ReadableStream 手写解析**，**非原生 `EventSource`**；token 从 `useSessionToken()` 自设头 | `EventSource` 无法设置 `x-session-token` 请求头（W3C 规范不支持自定义头）；唯一替代是 query-param token，但会把 secret 泄漏进 access log/history/referrer = 安全回归（报告 §11）。fetch 流式复用既有头鉴权、零新增攻击面。**（S3 订正 v1 错误）**：e2e fetch 猴补当前**只匹配 `/api/rpc`**（`shared-fixture.ts:49`），**不天然覆盖** SSE 路径——3b 需放开 URL 匹配为 `/api/rpc|/api/sessions`，且 SSE 客户端必须用**字符串 URL** 调 fetch（猴补只处理 string input，`:48`）。代价：需手写 SSE 帧解析（vitest 侧已有 `parseFrames` 范式可移植）+ 手写重连（EventSource 自带重连，fetch 需自实现——但换来鉴权正确性，值得）。 |
| **D2** | 事件读**只走 SSE 端点**，不新增 `session.events` RPC；初始快照 = SSE `sinceSeq=0` 全量 replay | 单一读路径避免 RPC 快照与 SSE 流双源漂移；服务端 replay+live 零丢失已验证（M6）。`session.list/get` 仅供导航元信息，不承载事件。 |
| **D3** | live event store 独立于既有 `QueryCache`，新建 `use-session-stream` | QueryCache 是请求-响应快照模型（`query-cache.ts`），append-only 事件流语义不同（去重/seq 单调/重连拼接）。强塞进 QueryCache 会污染其失效模型。session list/get 仍走 QueryCache（它们是快照）。 |
| **D4** | Session List **派生自 store 的 `listSessions`**，不派生自 legacy run 表；`session.list` 输入 `z.undefined()`，**服务端**经 `getOrCreateDefaultWorkspace(projectRoot)` 解析 workspace 并回传 workspaceId | human-first 主轴是 session（报告 §1 心智模型 workspace/session/message）。workspaceId 客户端不可见（无 RPC 下发），故必须服务端解析（M2）；从 session 表读是正确抽象，避免"又从 legacy 表聚合"回到旧范式。 |
| **D5** | Composer 本阶段**不支持运行中转向**（follow-up/steer），只支持新起 + resume/approve | `AgentHandle.followUp/steer` 阶段 2b 才实现（现抛 `NotSupportedYet`）。UI 诚实禁用而非假装（March of Nines / 锯齿状智能）。 |
| **D6** | 默认路由 `/` = Session UI；旧页全移 `/advanced/*` **保留不删** | 报告 C2 双轨并存；human-first 为默认交互，autonomous/旧 Cockpit 作为 advanced 保留。 |

## 4. 测试计划（对齐每子步 e2e + 报告验收）

| 测试 | 覆盖 | 子步 |
| --- | --- | --- |
| core `session-store` listSessions 单测 | 空/多 session 排序/未知 workspace | 3a |
| web api `session-router` 契约测 | list/get 形状；list 服务端解析 workspace + 回传 workspaceId | 3a |
| web api **M1 防假绿测（不经猴补）** | 直连 `/api/rpc` 调 `session.list`：带正确头→200、缺头→401（原生 HTTP，参照 session-sse.test.ts） | 3a |
| web client `session-stream` 解析器单测 | 多帧/半包/心跳跳过/CRLF/去重/seq 单调/Last-Event-ID | 3a |
| Playwright `session-feed.e2e` | （含 S5 从 3a 移入）建流→初始 replay→connState live；mock-agent run → feed 出现 user/step/tool/assistant/turn 且有序 + 合成标注；放开 fetch 猴补 URL | 3b |
| Playwright `session-approval.e2e` | 经 project.run 起 human-gate 模板真实建 session → inline 卡片（gate.list 补全）→ approve → run 推进 | 3c |
| Playwright `session-reconnect.e2e` | 断流→重连→replay 无重复无丢失；`/advanced` 旧页可达 | 3d |
| 回归 | 既有 12 Playwright + 全量 vitest 不破（旧页迁移到 /advanced 后断言路径更新） | 3d |

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| fetch-SSE 重连边界（半包/乱序/replay 重叠） | 事件丢失或重复 → 叙事错乱 | seq 去重 + Last-Event-ID 续播（服务端已验证）；解析器单测覆盖半包；重连 e2e |
| e2e fixture 不播种 session；fetch 猴补只覆盖 `/api/rpc` | 浏览器级 SSE e2e 写不出来 | 经 `project.run` 真实建 session（范式 create-pr-approval.test.ts:55-101）；3b 放开猴补 URL 匹配为 `/api/rpc\|/api/sessions`；SSE 客户端用字符串 URL 调 fetch（D1/S3） |
| M1 token 死代码致生产 401 被猴补掩盖 | Session UI 上线即全读 401 | 3a 修 rpc-client↔AuthContext 接线 + 补不经猴补的 200/401 测试 |
| 旧页迁移 `/advanced` 破坏既有 12 Playwright | 回归 | 迁移与断言路径同 PR 更新；旧页零逻辑改动，仅路由前缀 |
| 合成 assistant 被误读为模型原文 | 用户误判 Agent 输出 | feed 显式"摘要"标注（§0.2）；`_truncated` 标注 |
| 范围失控（4 子步一次做完→半成品） | 违背报告 §11 | 每子步独立 e2e + 提交；任一不过即停（§2） |
| 单流字段无 sessionId（present 不下发） | 多 session 混流 | 当前一 run 一 session、客户端一次订阅一个 sessionId，无混流；多路复用递延 |

## 6. 交付顺序与验收闭环

每子步走：实现（e2e 绿）→ 提交。全部子步完成后：全功能 e2e（core+web+cli+Playwright 全绿）→ opus code review（必修先修再复查）→ opus 报告完整性复审 → push PR#10 + 清理临时产物。版本：3a-3d 累计为一个 MINOR bump（新增 session UI + session.* RPC = 新功能）v0.11.0。
