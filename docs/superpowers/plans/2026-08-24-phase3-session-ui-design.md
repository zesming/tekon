# 阶段 3 详细设计：Human-first Session UI（v2，客户端会话读路径 + 三栏交互）

> ⚠️ **状态口径以 [`docs/technical/tekon-replatform-current-scope.md`](../../technical/tekon-replatform-current-scope.md) 为准**（当前范围基线具状态覆盖优先级）。本文头「3a-3d 全部实现完成」指的是**阶段 3 观察 / 控制切片**（Session list/detail、SSE replay、运行控制、inline approval、移动端布局与基础可访问性），**不代表原始阶段 3 验收整体完成**——运行中 `follow-up`/`steer` 转向、真实模型散文流式、行级 diff 卡片已在 §0.2 显式递延；Narrative Feed / 当前状态 Inspector / 结构化 Final Result 仍为后续里程碑。

- 状态：v2 已纳入 opus 设计评审的 2 MUST-FIX + 6 SHOULD + 3 NIT（两轮评审裁定 buildable）；**观察/控制切片 3a-3d 已实现完成（v0.11.0）**。报告完整性终审后补齐 final-result 卡与 workspace 只读占位、并订正 diff 卡递延措辞（见 §0.2、§3c）。
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
- inline approval + tool/artifact/error/final-result 卡片，复用既有审批与展示组件（diff 卡递延，见 §0.2）。
- 运行中 pause/cancel/resume（复用 RunControls，接上此前被丢弃的 sessionId）。
- 旧 Dashboard 与 run-detail 全部**保留**、移到 `/advanced`（C2 双轨并存，不删）；新 Session UI 成为默认 `/`。

### 0.2 非目标（显式递延，勿当缺口）

- **真正的 follow-up/steer 运行中转向**：依赖阶段 2b 的 `AgentHandle.followUp/steer`（当前抛 `NotSupportedYet`）。本阶段 composer 只支持"新起 session/run"与"对 paused/blocked run 的 resume/approve"，**不注入运行中消息**。UI 对不可用动作显示禁用态 + 诚实提示，不假装能转向。
- **真实模型散文流式**：`assistant/message` 是产物元数据合成（阶段 2 M3），`assistant/chunk` 无生产者（2b）。feed 必须诚实标注"摘要"，不渲染成模型原文逐字流。
- **行级 diff 及 diff 卡片**：会话事件流本身不携带任何 diff 数据（`artifact/created` 只有 `{artifactId,type,summary,sha256}`，无 diff 正文）；现 `DiffViewer` 只存在于 delivery 页并读 delivery 投影。故 Session UI **本阶段不提供 diff 卡片**（含摘要 diff），递延阶段 4「Delivery 订阅 readiness/artifact events」时补 diff 事件数据源后再做。
- **多 workspace 管理 UI**：当前一 run 一 session、单默认 workspace。workspace picker 本阶段为**只读占位**（`SessionsPage` 顶栏渲染 `session.list` 回传的 workspaceId、禁用态），完整多 workspace 切换/管理递延阶段 4/5。
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
- **复用组件**：`DecisionCard`/`DecisionForm`/`ApprovalSummary`（完整审批 UI）、`RunControls`+`runControlAffordances`（已单测）、`CodeBlock`、`AuditTimeline`（时间线范式）、`ArtifactsTab` 范式、`ConfirmButton`、`Card`/`StatusBadge`/`EmptyState` 等原语。（`DiffViewer` 存在但只在 delivery 页、读 delivery 投影，本阶段 Session UI **未使用**——见 §0.2。）
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
- 新建 live event store `hooks/use-session-stream.ts`：订阅一个 sessionId，维护 `events`（按 seq 去重升序）、`connState`（connecting/live/reconnecting/closed）、`latestSeq`。**每次 `sessionId` 变化清空旧 events 并 abort 旧连接**（N2，防两个 Session 事件串流）。不走 QueryCache——事件流是追加数据，见 §3 D3。
- 页面路由：新增 `/sessions/:sessionId`（先最小占位，3b 填 feed）。
- 删除死 `use-run-poller.ts` + index re-export（M2）。

**测试（3a）**
- core unit：`listSessions` 排序、空 workspace、runId 从列直出；session.list 服务端解析 workspace 并回传 workspaceId（M2）；session.get 组合 runId（N3）。
- web vitest：SSE parser（多 data 行、CRLF、chunk 边界、心跳忽略、malformed data 跳过）；reconnect 携 `Last-Event-ID`；unmount abort；sessionId 切换清空+abort（N2）。
- **生产 token 测试（M1）**：不安装 e2e fetch 猴补，直接调用生产 RPC client 或 HTTP，断言带 token 头的 `session.list` 200、无头 401。
- **连接层 e2e**：复用 `session-sse.test.ts` 验证鉴权 + replay 已存在，无需重复造；浏览器级 SSE 消费移到 3b（有真实页面后），不写 skipped 空壳（S5）。

**验收**：session.list/get 正确；RPC 生产鉴权修复（不靠猴补）；SSE 客户端 reconnect/abort/parser 单测绿；旧页无回归。

### 3b — Session List + Composer + Event Feed（核心 UI）

**Session List 页面**
- 新建 `SessionsPage.tsx`，默认路由 `/`（替代 Dashboard，但不删，3d 移 `/advanced`）。
- 顶部 workspace picker（单 workspace 时禁用并显示当前 project root；为阶段 4 多 workspace 留接口）。
- Session 列表：title + human status + last activity time；点击进入 `/sessions/:id`。
- 刷新：`session.list` 走 `useQuery`，新 run 创建/审批/控制 mutation 后 invalidate `session.list`；另提供手动刷新按钮（S6：SSE 是 per-session，不足以驱动列表；本阶段不引入全局 workspace SSE）。
- Composer：多行输入 + 发送；调用 `project.run`（已有），捕获返回 `sessionId` 并 `navigate('/sessions/:id')`；禁止空输入；loading/错误态。

**Event Feed 组件**
- `EventFeed.tsx` 接 `SessionEvent[]`，按 turn/step 分组；事件类型渲染：
  - `user/message` → 用户气泡；
  - `assistant/message` → Agent 气泡，**显式标"摘要"**（§0.2，非模型原文）；
  - `tool/call` + `tool/result` → 折叠 tool card（payload 已标 `summaryLevel:'node'`）；
  - `step/start/end` → step 分隔；
  - `workflow/*`、`gate/*`、`job/status` → lifecycle pill；
  - `artifact/created` → artifact card；
  - `agent/error` → error row；
  - 未知事件 → generic key/value（向前兼容，禁止 crash）。
- **可读优先**：默认隐藏 raw seq / 完整 runId；可展开 Advanced 查看。现有 `presentEvent` 已在服务端做脱敏/限长。
- 连接状态：顶部 badge connecting/live/reconnecting/closed；断线不清空 feed。

**测试（3b）**
- vitest：每种事件 renderer + 未知事件；分组；默认隐藏 raw id；assistant 标摘要。
- Playwright：API 真正 `project.run` 建 session → `/sessions/:id` → `EventFeed` 收到 SSE 并显示 user/step/assistant/tool/lifecycle；连接 badge 到 live。这是阶段 3 浏览器级「新任务」journey + 3a 延后的浏览器 SSE 消费（S5）。

**验收**：`/` 是可启动新任务的 human-first UI；启动后导航 Session；SSE feed 实时显示且断线重连。

### 3c — Inline approval + Run controls + Tool/Artifact/Error/Final cards

**右栏卡片区**
- `SessionSidePanel.tsx`：从 event stream 派生当前 runId、status、pending decision、artifacts、errors、result；只做只读 projection，不改治理事实源。
- RunControls：复用现有组件（pause/cancel/resume），根据 event 派生 status；调用后 invalidate session + 继续等待 SSE（SSE 会发 job/status/run.*）。
- Inline approval：`approval/requested` 只含 decisionId/gateId/runId，**完整 DecisionContext 不在事件里**（S1）。卡片出现时按 runId 调既有 `gate.list`，从 `pendingDecisions` 找 decisionId，复用 `DecisionCard`/`DecisionForm`；提交 `gate.approve/reject`，服务端审批/CAS/audit 不变。审批成功后 SSE 推 `approval/resolved`，卡片移除。
- Cards：
  - tool/call+result → `ToolCallCard`（可折叠输出）；
  - artifact/created → `ArtifactCard`（type/summary/sha256，不读原文件）；
  - agent/error → `ErrorCard`（脱敏后 message，retry 指引）；
  - **final-result**：`run.passed/failed/cancelled` 到达后，聚合 event stream 的 artifacts/errors 显示摘要卡（状态、artifact count、error count）。
  - Diff card **不实现**（§0.2，无数据源；不造假）。

**测试（3c）**
- vitest：SidePanel 投影（pending decision 状态机、artifact/error 聚合、final result）。
- Playwright：人为 gate → inline DecisionCard → 二次确认 → approved → workflow 继续 → final-result card；断言审批前 workflow 不前进（C1/P0-03）。这是阶段 3 浏览器级「inline approval」journey。

**验收**：运行中控制/审批在 Session 内完成；审批规则零退化；完成态有 final-result 摘要。

### 3d — 重连硬化 + 旧页迁移 + 全量回归

**重连硬化**
- `Last-Event-ID` 续播已在 3a 客户端；补浏览器级：模拟中断→重连→无重复/无丢失。
- 页面刷新：sinceSeq=0 全量 replay（本地不持久 seq，简单可靠）；服务端 replay 保证。
- Token 变化：abort 旧 SSE，以新 token 重连；无 token 时 closed + 提示，不疯狂重试。

**路由迁移**
- `/` → SessionsPage；`/sessions/:id` → SessionDetail。
- 旧 Dashboard 路由移到 `/advanced`，其子路由整体前缀 `/advanced/*`；Sidebar 主要入口只显示 Sessions，"高级 Advanced" 展开旧导航。
- 旧组件/路由**不删**（C2/C3）；headless/CLI 不受影响。

**全量测试**
- 核心 golden journeys Playwright：
  1. 新任务 → Session → 实时 feed → passed；
  2. inline approval → approve → 继续；
  3. pause → resume → 继续；
  4. SSE 中断 → 重连 → 无丢失；
  5. `/advanced` 旧页面仍可用。
- Core/CLI/Web unit+e2e 全绿；全包 typecheck。

**文档/版本**
- CHANGELOG `0.10.0 → 0.11.0`（MINOR：默认 UI 变更 + 新 Session 读 RPC）。
- 用户手册：新默认流程、`/advanced` 入口、inline approval、token 设置。
- **阶段 3 详细设计状态只表示观察/控制切片完成；原始阶段 3 整体验收仍按当前范围基线判定。**

## 3. 决策记录（评审裁定）

### D1 — SSE 鉴权：fetch stream + 自定义 header，不用 EventSource

原生 `EventSource` 不支持自定义请求头；token 放 query param 会泄漏。用 `fetch(url, {headers:{'x-session-token':token}})` + `ReadableStream` 手写 parser；已有 `collectSse` 测试范式可复用。

### D2 — 状态管理：独立 live store，不把 SSE 塞 QueryCache

QueryCache 是一次性快照 + invalidate/refetch；SSE 是追加流。把 events 数组塞 QueryCache 会导致每帧 notify 所有订阅者且语义混乱。新 `useSessionStream` 自管，query 只读 session 元信息。

### D3 — Inline approval：事件触发、RPC 补全上下文

不扩 `approval/requested` payload（contract 已冻结、避免把完整命令泄漏进事件）；用 decisionId/runId 调既有 `gate.list` 补全。这也是复用治理事实源、避免 duplicate state 的正确边界。

### D4 — Workspace picker：本阶段只读占位

只有单 workspace；实现真正 picker 会引入 workspace CRUD、session 过滤、route param，范围过大。渲染 disabled select 显示当前 root，接口为阶段 4 预留。

### D5 — Composer 只新起 Session，不注入运行中消息

`AgentHandle.followUp/steer` 未实现；若 UI 显示可输入会误导。运行中只有 pause/cancel/resume/approve。Composer 文案明确"新任务"。

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SSE 重连风暴 | 指数退避 1s→30s + 抖动；token 无效时停止重试 |
| 事件量大导致内存增长 | 当前 run 规模可控；阶段 4 加分页/虚拟化（不在本阶段范围） |
| approval 上下文二次查询闪烁 | skeleton；decisionId 稳定作为 key |
| token 泄漏 | 自定义 header；客户端日志不打印；URL 禁止 token |
| 旧 Dashboard 回归 | `/advanced` 保留 + Playwright 回归 |
| 服务端投影落后 | SSE Last-Event-ID + replay；Session UI 明确连接状态 |

## 5. 验收标准（逐条可测）

| ID | 标准 | 测试 |
|---|---|---|
| A1 | `/` 默认 Session List + Composer | Playwright |
| A2 | `project.run` 返回 sessionId 后导航 | Playwright |
| A3 | SSE feed 实时显示 8+ 类事件，断线重连无丢失 | vitest parser + Playwright |
| A4 | RPC 读路径生产鉴权正确（不靠猴补） | HTTP integration |
| A5 | inline approval 完整上下文、二次确认、规则零退化 | Playwright + core e2e |
| A6 | pause/cancel/resume 在 Session 内可用 | Playwright |
| A7 | final-result 聚合状态/产物/错误 | vitest + Playwright |
| A8 | `/advanced` 旧页仍可用 | Playwright |
| A9 | assistant/message 诚实标"摘要"、tool 标 node-level | renderer unit |
| A10 | 多 workspace picker 只读占位、不误导可切换 | unit |

## 6. 文件级改动清单（实现期）

### 新增
- `packages/web/src/client/lib/session-stream.ts`
- `packages/web/src/client/hooks/use-session-stream.ts`
- `packages/web/src/client/pages/SessionsPage.tsx`
- `packages/web/src/client/pages/SessionDetailPage.tsx`
- `packages/web/src/client/components/sessions/SessionComposer.tsx`
- `packages/web/src/client/components/sessions/SessionList.tsx`
- `packages/web/src/client/components/sessions/EventFeed.tsx`
- `packages/web/src/client/components/sessions/SessionSidePanel.tsx`
- `packages/web/src/client/lib/session-side-panel.ts`
- `packages/web/src/server/api/routers/session.ts`
- 对应单测 + Playwright journey

### 修改
- `packages/core/src/session/session-store.ts`（listSessions）
- `packages/web/src/client/App.tsx`（路由）
- `packages/web/src/client/layouts/Sidebar.tsx`
- `packages/web/src/client/hooks/index.ts`
- `packages/web/src/client/lib/query-keys.ts`
- `packages/web/src/client/context/auth-context.tsx`（M1 token→rpc-client）
- `packages/web/src/shared/rpc-contract.ts`
- `packages/web/src/server/api/root.ts`
- `packages/web/src/server/api/mappers.ts`
- `packages/web/src/server/api/rows.ts`
- 旧页面路由前缀 `/advanced`

### 删除
- `packages/web/src/client/hooks/use-run-poller.ts`（死代码）
- 对应 index re-export

## 7. 实现完成记录（2026-08-24）

### 7.1 提交序列

| 步骤 | 提交 | 内容 |
|---|---|---|
| 3a | `c3bc33e` | Session 读路径 + SSE 客户端 + token 接线修复 + 删除死 poller |
| 3b | `4a5cbd8` | Session List/Composer/Event Feed + SSE Playwright journey |
| 3c | `c50d177` | SidePanel + inline approval + cards + DecisionForm 纯组件 |
| 3d | `8cf9988` | SSE 重连单测 + `/advanced` 路由 + 全量回归 + 文档版本 |
| 修复 | `e12a52a` | gate.list invalidation key 订正；审批卡片状态稳定 |
| 报告终审 | `f479844` | final-result 卡；workspace disabled select→只读 info；diff 卡递延措辞 |

### 7.2 测试结果（最终）

- Core: 85 files / 890 tests — passed
- CLI: 3 unit + 2 e2e — passed
- Web: 26 files / 206 tests — passed
- Playwright: 12 tests — passed
- 全包 typecheck — passed

### 7.3 与设计的偏差（诚实记录）

1. **Sidebar 行为**：原设计"高级 Advanced 展开旧导航"，实际实现为顶级 `/advanced` 链接 + 进入后显示全部分组，功能等价且更简单。
2. **Workspace picker**：终审发现 disabled select 会让用户误以为可操作但失效，改为只读信息区 `role=group aria-label=当前工作区`，优于原设计。
3. **Diff card**：明确递延（见 §0.2），未造假。
4. **Final-result**：终审补齐，聚合状态 + artifact/error count。

### 7.4 当前验收边界

3a–3d 的观察/控制切片已经完成；以下原始阶段 3 能力仍未完成，并由 `docs/technical/tekon-replatform-current-scope.md` 作为当前权威范围继续追踪：

- Session 内 follow-up / steer；
- 真实 Provider 执行期增量与 Assistant Chunk；
- Narrative Feed；
- 当前状态 Inspector；
- 结构化 Final Result；
- 长 Session 有界化与性能预算。
