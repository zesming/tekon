# Tekon Harness Replatform 第七轮全面复审

> 复审日期：2026-08-26  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 第六轮权威报告基线：`ba59c768955090228e4d9f20ec327fc18c4c6453`  
> 实施方第六轮整改：`85d34d23264459c76b96d427b189cf05ca7c915c`  
> 本轮代码修复锁定 Head：`aefa08e144ef0b8381355ed913e95064f22ae718`  
> 复审维度：产品逻辑、UI 实现、UX 交互、整体框架架构、并发与恢复正确性、代码实现、测试可信度、过度实现与过度设计。

---

## 1. 最终结论

# **整体不通过**

结论需要按验收对象区分：

| 验收对象 | 第七轮结论 |
| --- | --- |
| 普通用户可直接使用的人机协作产品 | **不通过** |
| 完整 Harness-inspired Runtime | **不通过** |
| 第六轮移动端横向溢出整改 | **通过** |
| 本轮移动抽屉可访问性整改 | **通过** |
| Workflow / Gate / Artifact / Worktree / Audit / Delivery 治理底盘 | 方向正确，应继续保留 |

实施方确实关闭了第六轮最直观的移动端布局阻断：`sessions.css` 已进入真实入口，固定 Sidebar 改成窄屏抽屉，Main 不再保留 232px 左偏移，Session List、Session Detail 与 `/advanced` 在 390px 下不再产生页面级横向溢出。

但产品与 Runtime 主闭环仍未达到通过条件。新的最重要发现是：**生产首屏认证启动流程实际上仍不可用，而 E2E 通过 monkeypatch 自动注入 Token 掩盖了这个问题。** 同时，Provider 仍是 node 级 one-shot，Session 内 follow-up / steer / durable inbox 尚未实现；Web 与 CLI 已经形成事实上的 multi-owner 部署，却仍缺持久化 execution generation、owner-conditioned SQL、Node CAS、Git ref CAS 与 shutdown quiescence。

因此本轮可以确认“移动端基本布局已修复”，但不能把 PR 解释为“人类可用产品已完成”或“完整 Harness Runtime 已完成”。

---

## 2. 复审方法与证据

本轮重新检查了第六轮之后的所有增量，并沿以下链路复核：

1. `tekon ui` 启动输出 → 浏览器首屏 → AuthProvider → RPC / SSE；
2. Web 与 CLI composition root → JobRunner → SQLite / Git Worktree；
3. Provider adapter → `agent-step-events` → Session Event → SSE → Feed；
4. Session List、Session Detail、Run Controls、Inline Approval 与最终结果；
5. 1440px 与 390px 真实 Playwright 截图、文档宽高、页面溢出；
6. 移动抽屉实际 Tab 序列、Escape、Overlay、路由跳转、断点切换；
7. Core、CLI、Web build / typecheck / unit / E2E；
8. PR 规模、自修改评审 Workflow、抽象增长与纵向产品闭环之间的比例。

真实视觉证据显示：

- 1440px Session Detail 整页高度约 9357px；
- 390px Session Detail 整页高度约 15892px；
- 移动端页面级横向溢出已经消失；
- 实施方原始抽屉打开后，连续 Tab 会直接进入背景的 Token 输入框、刷新按钮和 Session Link，导航本身反而不可达；
- 本轮已直接修复该抽屉键盘与焦点问题。

官方模式对照：

- WAI-ARIA Modal Dialog Pattern：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- DeepSeek Harness Architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- DeepSeek Harness Session subsystem：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
- OpenAI Codex App Server：<https://openai.com/index/unlocking-the-codex-harness/>
- Claude Managed Agents events and streaming：<https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
- Git `update-ref`：<https://git-scm.com/docs/git-update-ref.html>
- SQLite isolation：<https://www.sqlite.org/isolation.html>

---

## 3. 第六轮问题复核

### CLOSED-01：移动端页面级横向溢出已关闭

`85d34d2` 的有效修复包括：

- `main.tsx` 真实导入 `sessions.css`；
- `#root` 成为可伸缩 Flex Root；
- 窄屏 `.main` 取消固定左边距；
- Sidebar 改为 off-canvas drawer；
- TopBar、Page Header、Toolbar、表格和 Advanced 页面在窄屏重排；
- 新增 390px 文档宽度与页面级溢出断言。

稳定截图和计算指标确认：Session List、Session Detail 与 Advanced Dashboard 均不再把 document 横向撑爆。这一项正式关闭。

### CLOSED-02：Session 样式入口遗漏已关闭

第六轮之前 `sessions.css` 实际未被 `main.tsx` 导入。DOM / class 断言能够通过，但设计样式并未生效。这是前几轮 UI 验收方法的真实盲点。

实施方已修复入口；本轮也保留了真实 computed style、document width 与截图级验证。后续 UI 改动不能只依赖 class/DOM 测试。

### CLOSED-03：移动抽屉键盘与焦点语义已关闭

实施方的初版抽屉解决了鼠标点击和横向布局，但不满足 modal navigation 的键盘要求：

- 焦点停留在 Hamburger；
- Tab 进入背景 Token / Refresh / Session Link；
- 背景 Main 不 inert；
- Body 仍可滚动；
- Drawer 品牌区被 TopBar 层级遮挡；
- 缺少抽屉内部可见关闭按钮。

本轮已直接提交并通过正式 Playwright：

- 打开后焦点进入 Drawer 内部关闭按钮；
- Tab / Shift+Tab 被限制在 Drawer 内；
- Main 设置 `inert`；
- Body 滚动锁定；
- Escape、Overlay、内部关闭按钮恢复 Hamburger 焦点；
- 点击导航跳转后，在解除 `inert` 后聚焦新页面 Main landmark；
- 断点变宽时清理 mobile-only open state；
- Drawer z-index 高于 TopBar；
- `role="dialog"` 与 `aria-modal="true"` 明确；
- 增加专门 Playwright 回归测试；
- 删除两份无引用的旧 CSS 入口，新增独立 `mobile-drawer.css`。

评审修复提交：

- `df368c61` — modal drawer、样式拆分、死文件清理与浏览器测试；
- `99d6cdf5` — 收紧 TypeScript DOM 边界；
- `242c9156` — 修正动态 accessible name 下的测试定位；
- `aefa08e1` — 路由跳转后在解除 `inert` 后恢复 Main 焦点。

---

## 4. 产品与 UX 阻断

### F7-P0-01：生产浏览器启动仍没有可用的 Token Bootstrap

这是本轮最重要的新发现。

当前 `tekon ui`：

- 读取并校验 `.tekon/web-session.json`；
- 但只输出普通 `http://localhost:<port>`；
- 没有把 Token、一次性 nonce 或短时 bootstrap code 交给浏览器。

浏览器端 `AuthProvider`：

- 初始 Token 为 `null`；
- Token 只保存在 React memory；
- 刷新页面后丢失；
- `session.list`、Session Detail 和 SSE 都需要 Session Token。

所以真实用户启动 `tekon ui` 后，默认首屏会发生 401，必须手工定位 JSON、复制 Token、粘贴到顶栏；刷新后还要重新输入。

现有 Playwright 没有暴露这一点，因为 `shared-fixture.ts` 在每个页面加载前 monkeypatch `window.fetch`，自动给 `/api/rpc` 和 `/api/sessions` 注入 fixture Token。测试验证的是“隐藏注入 Token 后页面可用”，不是生产启动闭环。

用户手册还声称 CLI 会输出“带 session token 的完整 URL”，与实现不符。

推荐方案：

```text
tekon ui
→ 生成短时、单次消费 bootstrap nonce
→ 打开 /#bootstrap=<nonce>
→ same-origin 交换 Session Token
→ history.replaceState 清理 fragment
→ Token 进入 sessionStorage
→ 首屏 RPC / SSE 开始
```

验收必须增加一条**不 monkeypatch fetch** 的生产启动 E2E，并验证：一次消费、过期、重放失败、刷新保持、日志和 Referer 不泄漏。

在此闭环完成前，默认 Web 入口不能称为普通用户可用。

### F7-P0-02：主流 Provider 仍不是实时 Agent Loop

当前核心路径仍然是：

```text
step/start
→ await adapter.runAgent(input)
→ 根据最终 AgentRunResult 合成 tool/call
→ 合成 tool/result
→ 合成 assistant/message
→ step/end
```

`LegacyAgentDriver.events()` 同样先等待整个 run 完成，再 yield 已缓冲事件。

因此当前 Feed 的“流式”主要是 Workflow / Job / Node 治理事件实时，而不是模型执行期的 Assistant delta、真实 Tool lifecycle、request boundary 与可中断控制。

DeepSeek Harness 的 Turn/Step 会在执行期记录 Assistant chunk/message 与 Tool call/result；Codex App Server 发布 `item/started → delta → item/completed`；Claude 的事件流也支持执行期内容和控制事件。Tekon 目前已有相似事件名，但事件产生时机和消费边界仍不同。

验收标准：在 Provider 尚未结束时，UI 必须已经收到真实 Assistant / Tool 增量；取消和 steer 必须作用于当前 request，而不是只作用于 Node 之间。

### F7-P0-03：Session 内 follow-up / steer / durable inbox 尚未实现

`AgentHandle.followUp()`、`steer()` 与 `AgentDriver.resume()` 仍抛出 `NotSupportedYet`；Session Detail 没有底部持续输入 Composer，也没有 pending / claimed / processed inbox 状态。

完整闭环至少需要：

```text
Session Composer
→ durable user/message 或 inbox row
→ active Agent 立即消费，或排入下一 Step
→ queued / claimed / processed 状态
→ 幂等提交
→ 刷新与 daemon 重启后恢复
→ 同一 Session 开启下一 Turn
```

当前只能“启动一次 Workflow 并观看”，还不能“在同一 Session 中持续协作”。

### F7-P0-04：Collaborate / Deliver 双轨仍未建立

当前默认入口已经诚实改名为“受控交付”，这是正确修复；但轻量 Collaborate 模式仍不存在。

建议形成真实后端语义差异：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 默认心智 | 持续对话与快速修改 | 受控软件交付 |
| 启动成本 | 低 | 高 |
| 角色 | 单 Agent / 小计划 | PM / RD / QA / Reviewer |
| 产物 | 可选 | 强制结构化 |
| Gate | 按风险升级 | 默认完整 |
| Git | 只读或小 Diff | Worktree + Delivery Branch |
| 结束 | 回答 / Patch / Summary | Evidence + Review + PR |

不能只通过模板下拉框或 Profile 文案模拟双轨。

### F7-P1-01：Session Detail 仍是超长底层事件墙

真实 mock `standard-delivery` 任务中：桌面整页约 9357px，移动端约 15892px。首屏和中段大量出现 `worktree/leased`、`job/checkpointed`、raw Node ID、Mock tool 结果、Artifact UUID、重复 Gate passed 和合成摘要。

默认 Feed 应以人类任务叙事为主：

```text
理解需求
→ 形成计划
→ 实现变更
→ 运行验证
→ 请求审批
→ 生成结果
```

而 raw Event type、seq、checkpoint、lease、correlation ID 应进入 Debug / Audit 抽屉。

### F7-P1-02：右侧 Inspector 与主 Feed 重复历史

右侧逐条复制 Artifact / Tool 卡片，主 Feed 又展示同一事件，造成视觉重复、页面增高和当前状态不清。

Inspector 应是当前状态投影：当前 Plan、Changed Files、最新 Checks、Pending Approval、Final Result、Delivery / PR；历史 Tool / Artifact 按需展开或搜索，不应再次全量平铺。

### F7-P1-03：Final Result 仍不足以完成验收

当前最终结果主要是：

```text
运行结束 · passed
产物 19 · 错误 0
```

它不能回答修改了什么、哪些检查通过、独立 Review 结论、风险、未完成项、PR / CI 与下一动作。

建议建立服务端 `DeliveryResult` 投影，至少包含：summary、changedFiles、checks、gates、review、risks、incomplete、delivery、nextActions。

### F7-P1-04：长 Session 缺少规模化能力

当前路径存在：无 limit replay、客户端永久保存全部 Event、每次 merge/sort 全量重算、Feed 和 SidePanel 重复扫描、无虚拟化、无折叠搜索、Tool Result 无 spill。

长程研发任务会形成累计 O(n²) 客户端工作和无界 DOM / memory 增长。需要 cursor pagination、bounded initial replay、SSE gap recovery、append-fast path、Turn/Step collapse、virtualization、search/filter、large payload spill，以及用户上翻时停止自动滚动。

---

## 5. Runtime 与并发正确性阻断

### F7-P0-05：当前部署已经是事实上的 multi-owner，但 Job fencing 仍是进程内为主

当前事实：

- Web composition root 启动一个 JobRunner；
- CLI `run / approval / resume` 也会创建并启动自己的 JobRunner；
- 两者访问同一个项目 SQLite 和 Git 工作区；
- 用户可以同时打开 `tekon ui` 并在另一个终端执行 CLI。

因此“single-owner daemon 或正式 multi-owner”不是纯未来架构讨论。当前产品已经允许多个 owner 竞争。

但：

- Job 没有持久化 `claim_generation`；
- heartbeat / checkpoint / settle 等写入仍未统一绑定 `{jobId, owner, generation, expectedStatus}`；
- process-local `Map<jobId, symbol>` 只能隔离同进程旧 executor；
- SQLite 串行化写事务不等于业务 execution authority fencing。

必须二选一：

1. 当前阶段强制 single-owner daemon，CLI / Web / IDE 都只做客户端；或
2. 正式支持 multi-owner，并完成持久化 generation 和 owner-conditioned SQL。

### F7-P0-06：Node 与 Git 副作用链缺少统一 execution authority

Node transition 仍缺数据库原子 expected-from / revision / owner-generation CAS；Git branch promotion 仍缺 expected-old OID compare-and-swap。

旧 owner 可能在新 owner 已推进后：回写 Node 状态、commit 旧 Worktree、force-promote 旧 branch，或覆盖新结果。

正确模型应让 Job、Node、Gate、Rework、Worktree 和 Git promotion 共享同一个持久化 execution authority；Git 使用 `update-ref <ref> <new> <expected-old>` 或等价 CAS，而不是无条件 force。

### F7-P0-07：`JobRunner.stop()` 尚未真正 quiesce

关闭流程目前主要停止 poll、等待有限时间并清理 Map；但清 Map 不会停止 Promise、Agent 子进程、Gate 命令和 Git 副作用。

正确顺序：

```text
停止领取新 Job
→ shutdown abort 所有执行器
→ kill 已登记子进程
→ 等待 executor / child quiesce
→ 持久化可恢复状态
→ 最后关闭 SQLite
```

本轮完整 Playwright 在移动 Session fixture teardown 后打印：

```text
[readiness] enqueue failed: TypeError: The database connection is not open
```

这是 Server teardown 已关闭 SQLite，但迟到 readiness automation 仍尝试入队的直接证据，不应作为无害日志忽略。

### F7-P1-05：StartRun 尚未形成事务或 Saga

`prepareRun → create Workspace → create Session → append opening events → enqueue Job` 之间任一步失败都可能留下 orphan Run / Session / partial Event。需要同库事务，或显式 Saga / outbox 与 orphan recovery。

### F7-P1-06：Automation 仍依赖 process-local EventBus

Readiness 和 auto-prepare listener 注册在 Web 进程本地 EventBus。CLI 或另一个进程写入 durable Session Event，并不会自动进入该进程的本地 bus。

应改成 durable projector：Session Event DB cursor、projector lease、checkpoint、幂等 side effect、crash replay。

### F7-P1-07：Session Event 仍是 best-effort dual-write，而非 Harness 事实源

当前旧表仍是 source of truth；Session Event append 失败不会阻断治理路径。作为迁移策略合理，但与完整 Harness 模式仍有本质距离。

下一阶段不应继续新增 Event type，而应先完成一条纵向链：user input → Provider stream → durable Event log → model history reconstruction → UI replay → restart recovery。

---

## 6. 代码质量、测试可信度与过度设计

### 6.1 不属于过度设计的资产

Workflow、Gate、Artifact、Worktree、Audit、Delivery、Human Approval 与 Independent Review 是 Tekon 的差异化治理资产，不应删除或退化成普通聊天产品。

### 6.2 当前真正的过度设计

横向抽象领先纵向闭环：已经存在较多 Session/Event vocabulary、Profile、Automation Job、Projection checkpoint、AgentDriver/Handle、DSH bridge 和 multi-owner recovery 尝试，但没有一个主流 Provider 完成“真实增量 → follow-up / steer → durable recovery → 同一 UI replay”。

多 owner 复杂度也缺少明确产品收益。如果本地单用户产品并不需要两个 Runner 同时执行，应通过 single-owner daemon 消除整类竞态，而不是无限叠加局部 guard。

### 6.3 PR 已过大

当前 PR 已达到约 100+ commits、189+ changed files 和约 3 万行新增。它最初是评审 PR，后来承载 Event Spine、Job Runner、Session UI、并发修复和多轮审计。

建议此后停止向本 PR 继续加入大功能；冻结当前里程碑，后续按 ADR / Runtime / Provider vertical slice / Product UX 分拆独立 PR。

### 6.4 自修改评审 Workflow 不应继续

多轮中临时 Workflow 持 `contents:write`，通过 commit message marker 自动改码、提交和清理；曾导致报告漏提交、Playwright 未纳入 gate、编码和临时载荷问题。

评审自动化应只读分析和验证；业务修改与报告使用普通、显式、可审查提交。

### 6.5 测试仍有可靠性问题

锁定代码 Head `aefa08e` 的正式 Core 和完整 CI 均通过，包括新增 drawer 测试；但完整 Playwright 仍报告 6 条首轮超时、retry 后通过的 flaky case，并暴露 DB-close late write。

绿色重试结果不能替代确定性测试。应拆分冷启动与业务断言、缓存浏览器依赖、等待服务 ready、fixture teardown 真正 quiesce，并把 flaky count 设为质量门槛。

### 6.6 代码清理建议

- `reset.css` 已超过 42KB，本质上是全局产品样式表，不是 reset；
- `visibility` 与 `modelVisible` 存在重复、矛盾状态空间；
- Session contract 中仍有 “no runtime implementation yet” 等过期注释；
- 应按 shell / components / pages / responsive 拆分 CSS，并用单一入口控制加载顺序。

---

## 7. 本轮直接修改

本轮只修改边界清晰、可独立验证的移动抽屉问题，没有用局部补丁冒充 Provider 或 Runtime 架构完成：

1. 移动 Sidebar 改为真正 modal drawer；
2. 打开后焦点进入内部关闭按钮；
3. Tab / Shift+Tab 焦点约束；
4. Main `inert` 与 Body scroll lock；
5. Escape / Overlay / Close button 恢复焦点；
6. Route change 后聚焦新 Main；
7. Breakpoint 状态清理；
8. Drawer 层级修正；
9. 新增 `mobile-drawer-accessibility.test.ts`；
10. 删除未引用 CSS 入口，新增 `mobile-drawer.css`。

锁定代码 Head：`aefa08e144ef0b8381355ed913e95064f22ae718`。

正式 GitHub Actions：

- Actionlint：通过；
- Core build + full unit + e2e：通过；
- Root build + typecheck：通过；
- CLI build + unit + e2e：通过；
- Web build + typecheck + unit：通过；
- Web Playwright：通过，包括新增 modal drawer 回归。

验证边界：尚未完成完整 Screen Reader 人工走查、所有浏览器兼容性和真实主流 Provider 长任务压测。

---

## 8. 推荐实施顺序

### Phase A：发布与正确性红线

1. single-owner daemon ADR 并落地，或完整 persistent generation；
2. owner-conditioned Job SQL；
3. Node CAS；
4. Git expected-old OID CAS；
5. shutdown quiescence；
6. StartRun transaction / Saga；
7. 生产浏览器 one-time bootstrap E2E。

### Phase B：一个真实 Provider 纵向切片

1. Provider real streaming；
2. Assistant delta；
3. Tool call/result；
4. durable inbox；
5. follow-up / steer；
6. reconnect / resume；
7. model history 从 Session Log 重建。

### Phase C：产品双轨与人类叙事

1. Collaborate 默认入口；
2. Deliver 显式入口；
3. Narrative Feed；
4. Current-state Inspector；
5. Final Result；
6. Advanced Debug / Audit。

### Phase D：长任务规模能力

cursor pagination、bounded replay、virtualization、collapse/search、spill references、performance budgets。

---

## 9. 最终裁决

> **第七轮整体仍不通过，不建议把本 PR 作为“完整迁移”或“普通用户可发布产品”直接合并。**
>
> 第六轮移动端横向溢出已经正确关闭；本轮又直接关闭了移动抽屉的 modal、键盘与焦点语义，并通过正式 CI。需要保留这些改动。
>
> 但生产浏览器 Token Bootstrap 仍未形成闭环，主流 Provider 仍不是实时可转向 Agent Session，follow-up / steer / durable inbox 与 Collaborate / Deliver 双轨仍缺失；同时 Web 与 CLI 已经构成事实上的 multi-owner Runtime，却没有持久化 generation、Node / Git CAS 与 shutdown quiescence。这些问题分别阻断普通用户产品和 Runtime 正确性。
>
> 下一阶段不应继续扩展 Event type、Profile 或 Automation kind。应先完成：**single-owner daemon + 安全浏览器 bootstrap + 一个真实 Provider 的 streaming / follow-up / resume 纵向切片。**
