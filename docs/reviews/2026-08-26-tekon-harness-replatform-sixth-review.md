# Tekon Harness Replatform 第六轮全面复审（权威版）

> 复审日期：2026-08-26  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 重点实现提交：`3d6836d`（run execution / automation 分离、Session / Workspace 身份幂等、enqueue 绑定校验）  
> 后续收敛提交：`0e156b5`（E2E 断言、Event Feed 覆盖、用户手册同步）  
> 复审维度：产品逻辑、UI 实现、UX 交互、整体架构、并发与恢复正确性、代码实现、测试可信度、过度实现与过度设计。

## 0. 报告留档更正

第六轮评审期间，代码修复和视觉走查通过临时 GitHub Actions 自修改工作流执行；最终清理脚手架时，报告文件没有进入提交清单，因此**原始第六轮报告当时确实没有落入仓库**。后续实施 Agent 在 `0e156b5` 中依据已应用 Diff 重建了一份报告，以补齐 `docs/reviews/` 断档。

本文是对该重建稿的覆盖版本：保留其经过代码与测试核验的事实，同时补回原评审应包含但重建稿缺失的产品、移动端视觉、UX 信息架构、长期规模能力和整体架构结论。本文应作为第六轮的权威验收记录。

---

## 1. 最终结论

# **整体不通过**

结论需要按验收对象区分：

| 验收对象 | 第六轮结论 |
| --- | --- |
| 作为普通用户可直接使用的人机协作产品 | **不通过** |
| 作为完整 Harness-inspired Runtime | **不通过** |
| 作为阶段性基础设施 PR | 并发与身份正确性明显改善，可以继续作为里程碑演进，但不能宣称“迁移完成”或“产品可发布” |
| Workflow / Gate / Artifact / Worktree / Audit / Delivery 治理底盘 | 方向正确，应继续保留 |

本轮不是“所有第五轮问题均未修”。实现方已经关闭了几个真实窗口，且核心改动值得保留；整体仍不通过的原因是：**产品纵向闭环、移动端基本可用性、真实 Provider 流式交互、Session 持续协作、长期会话规模能力，以及 Runtime 所有权模型仍未达到完整验收条件。**

---

## 2. 本轮复审方法与证据

本轮重新检查了第五轮后的增量提交，并沿以下链路复核：

1. `SessionService.resumeRun`、`gate.approve` 到 Job 入队与 Runner 认领；
2. `sessions` / `workspaces` 身份创建与两个独立 SQLite 连接下的收敛；
3. run-execution Job 与 readiness / delivery automation Job 的控制边界；
4. Workflow 状态、Job 状态、Session Event 与 UI 状态之间的映射；
5. 默认“受控交付”入口、Session List、Session Detail、审批、运行控制和最终结果；
6. 桌面端与移动端真实 Playwright 截图；
7. Core、CLI、Web unit/API、Playwright E2E、build 与 typecheck 结果；
8. PR 规模、自修改评审工作流和抽象增长是否领先于产品纵向闭环。

视觉走查覆盖：

- 1440px 受控交付列表；
- 1440px Session Detail；
- 390px 受控交付列表；
- 390px Session Detail；
- 1440px Advanced Cockpit。

---

## 3. 已确认闭环或明显改善的项目

### CLOSED-01：run execution 与 automation 控制边界已分离

第五轮引入的 active-job 查询最初没有按 Job kind 过滤，导致 `readiness-evaluate`、`delivery-auto-prepare` 等 automation / projection Job 可能：

- 被 Pause / Cancel 的 Job relay 误选中；
- 阻塞合法 Resume；
- 被 run stale-reclaim 错误取消。

`3d6836d` 引入 `RUN_EXECUTION_JOB_KINDS`，将以下路径收窄到 `workflow-run`、`workflow-resume`、`goal-run`：

- `findActiveByRunId`；
- `cancelStaleActiveJobs`；
- `enqueueIfNoActiveByRunId`。

这是正确的控制面分离。Pause / Cancel 的权威状态仍先写 Workflow instance，Job relay 只是尽力中断信号；Automation Job 继续由通用 lease recovery 处理，因此该修改没有让运行控制静默失效。

### CLOSED-02：同一 Run 的 canonical Session 创建已收敛

`createSession` 从无条件 Insert 改为 `BEGIN IMMEDIATE` 中的 lookup + insert；当 `runId` 已存在时返回既有 Session。该修复补齐了第五轮原子 Resume 修复之后的残留窗口：两个独立入口在“尚无 Session”的场景中不再各自建立一条 Session。

新增的两连接测试对 pre-fix 无条件 Insert 具备实际区分力，能够锁定“一 Run 一 canonical Session”的应用层不变量。

### CLOSED-03：默认 Workspace 创建已进入同一写临界区

`getOrCreateDefaultWorkspace` 也进入 `BEGIN IMMEDIATE` 的 get-or-create。单进程 Vitest 很难真实制造两个进程的 SQLite 写交错，因此现有测试更接近回归护栏，而不是完整的跨进程 mutation-killer；但实现方向正确，至少不再依赖裸 lookup 后 Insert。

### CLOSED-04：原子入队边界增加 Session / Run 和 Job kind 校验

`enqueueIfNoActiveByRunId` 现在拒绝：

- Session 不存在；
- Session 绑定到另一个 Run；
- Automation Job 误用 run-execution-only 原子入队接口。

这些守卫避免调用方未来绕过领域边界，新增测试能够覆盖错误绑定和错误 kind。

### CLOSED-05：默认入口文案更加诚实

默认页面从容易暗示聊天产品的“会话 Sessions”改为“受控交付”，Composer CTA 改为“启动受控交付”，并明确当前会进入 PM / RD / QA / Reviewer 全链路，而不是轻量对话。

这是必要的产品逻辑修复：在 Collaborate 模式尚未存在时，界面不再用聊天式命名承诺产品并未提供的交互。

### CLOSED-06：部分可访问性和事件可读性已改善

已确认保留：

- Event Feed `role="log"` 与增量 live-region 语义；
- 连接状态 `role="status"`、`aria-live="polite"`、`aria-atomic="true"`；
- Composer 的 `aria-busy`、描述关联、错误状态和 `role="alert"`；
- Token 显示/隐藏按钮具有可访问名称和 pressed 状态；
- 非 compact 运行控制显示文字标签；
- Automation lifecycle 映射为“准备度检查”“交付材料准备”等人类可读标题。

`0e156b5` 还修复了 Sidebar 改名后 Playwright 断言仍查找“会话 Sessions”的漂移，并补齐两个 Automation Event Feed 分支的单测。

---

## 4. 仍然阻断整体通过的问题

## F6-P0-01：移动端布局目前不可用

第六轮真实 390px Playwright 视觉走查暴露出明确回归，而重建稿没有记录：

- Sidebar 仍固定为 232px，并使用 `position: fixed`；
- `.main` 仍固定 `margin-left: 232px`；
- 现有窄屏媒体查询只把 Session Detail 的两列改为一列，没有处理全局导航、Main、TopBar 和 Page Header；
- 390px viewport 的列表截图实际扩展到约 691px，详情截图扩展到约 732px；
- Sidebar 覆盖页面主体，标题、Composer、Feed 和右侧信息被遮挡或截断；
- 用户无法在正常移动端视口中完成浏览、发起或查看交付。

这不是视觉微调，而是基本任务不可完成。至少需要二选一：

1. 实现可访问的移动导航（抽屉 / 折叠按钮），并在窄屏取消固定 Main 左边距；或
2. 将 Sidebar 转为顶部静态导航，同时重排 TopBar、Token 输入、Page Header 和页面操作区。

在修复前，不能把响应式 Session UI 视为通过。

## F6-P0-02：真实 Provider 的纵向 Agent Loop 尚未完成

用户期望的完整路径应是：

```text
输入需求
→ 实时看到 assistant / tool 增量
→ 在同一 Session 中补充条件或纠正方向
→ Agent 消费 follow-up / steer
→ 页面刷新或 Runtime 重启后恢复
→ 获得结构化最终结果
```

当前边界仍然是：主流 Provider 以一次运行结果为主，Session Feed 的不少 message / tool 内容来自运行结束后的投影或合成；`assistant/chunk`、`agent/steered` 等契约存在，不等于真实 Provider 已在执行期间持续产生并消费这些事件。

因此目前的 Session 更接近“Workflow 运行观察器”，还不是持续协作的 Agent Session。

## F6-P0-03：Session 内 follow-up / steer 和 durable inbox 未开放

进入 Session Detail 后，用户仍不能：

- 继续追问；
- 提交补充上下文；
- 中途转向；
- 在等待审批或恢复后继续同一对话；
- 让未消费的用户输入在进程重启后继续存在。

Composer 仅用于启动新的受控交付。该边界已经在 README / 用户手册诚实披露，但它仍是产品通过所必需的能力，而不能因为“已披露”就视为完成。

## F6-P0-04：Collaborate / Deliver 双轨仍停留在概念层

当前默认入口已正确命名为 Deliver 式“受控交付”，但产品仍没有真正的轻量 Collaborate 模式。

两种模式应当在后端语义上不同：

| 模式 | 预期语义 |
| --- | --- |
| Collaborate | 快速问答、探索、解释、局部修改、持续对话，低启动成本 |
| Deliver | Workflow、Gate、Artifact、测试、独立 Review、审批、PR，强治理 |

不能只用不同按钮文案或模板参数模拟双轨。需要明确权限、成本、产物要求、事件模型、恢复方式和模式切换规则。

## F6-P1-01：Session Feed 仍是底层事件墙，而不是面向人的工作叙事

桌面端 Session Detail 视觉截图高度约 9022px，移动端约 10508px。首屏即出现大量：

```text
治理节点开始
事件 worktree/leased
步骤开始
治理产物
工具调用 mock
工具结果 mock
job/checkpointed
gate passed
```

虽然部分标题已经中文化，但信息层次仍然接近审计日志。普通用户真正关心的是：

- Agent 当前在做什么；
- 修改了哪些文件；
- 测试是否通过，失败原因是什么；
- 当前是否需要用户操作；
- 最终完成了什么；
- 还有什么风险。

默认 Feed 应聚合为 Turn、任务、修改、验证、审批和结果；原始 Event type、seq、checkpoint、lease 等信息应折叠到高级调试视图。

## F6-P1-02：Final Result 仍不足以支撑交付验收

当前最终结果主要由终态、产物数和错误数合成，缺少集中呈现：

- 变更文件与 Diff；
- build / lint / test 结果；
- Gate 与独立 Review；
- 风险与未完成项；
- 分支、PR 和 CI 状态；
- 用户下一步动作。

用户仍需在长 Feed 和 Advanced Cockpit 之间自行拼接结论。建议建立一个由真实投影数据驱动的 Final Result schema，而不是继续在前端按事件数量临时合成。

## F6-P1-03：Event Log 与 Automation 的持久化边界仍是迁移态

现有文档明确说明 `session_events` 是 best-effort projection，Workflow / Job 等旧表仍是事实源；Automation 也依赖进程内事件触发。由此带来：

- 进程在事实写入与事件投影之间退出时可能缺事件；
- 重启后未必能确定性补发所有 Automation；
- Session Feed 不能作为完整恢复来源；
- UI、审计和模型上下文之间存在多套状态解释。

在完成迁移前，应明确每类事实的唯一权威源，并为投影提供持久化 outbox / checkpoint / replay，而不是继续增加更多 best-effort 双写事件。

## F6-P1-04：长 Session 缺少规模控制

真实长期开发会产生数千到数万条 Event。当前仍需完成：

- 服务端 cursor 分页；
- 有界 SSE replay；
- 前端虚拟化；
- Turn / Step 折叠；
- 搜索与筛选；
- 用户向上阅读时停止自动滚动；
- 大 Tool Result spill 与按需加载；
- 事件保留和归档策略。

现有视觉截图已经在一个 Mock 交付中形成极长页面，说明该问题不是远期理论风险。

## F6-ARCH-01：Runtime 所有权模型仍需正式决策和约束

第五轮提出的 owner generation、owner-conditioned SQL、Node CAS、Git expected-old OID CAS 和 shutdown quiescence，并非都应继续被当作当前单机产品的无条件 P0 Bug；它们是否必须完整实现，取决于 Tekon 是否正式支持多个 Runtime owner 同时控制同一个数据库与仓库。

但当前不能继续保持模糊状态。必须选择并固化：

### 方案 A：单 owner daemon（推荐当前阶段）

- 一个长驻 Runtime 独占 DB、JobRunner、Provider、Worktree 和 subprocess；
- Web、CLI、IDE 都只做客户端；
- 启动时有数据库级 owner lock；
- 第二 owner 明确拒绝启动；
- stop 必须 abort、kill 并等待 quiescence。

### 方案 B：正式 multi-owner

- 持久化 claim generation；
- heartbeat / checkpoint / settle 全部带 owner + generation 条件；
- Node transition 使用 expected-from / revision CAS；
- Git ref promote 使用 expected-old OID；
- 原子 Resume 与 per-run execution authority；
- 可证明的 shutdown / recovery 交错测试。

在 ADR 与实现约束落地前，不建议继续扩展更多 Profile、Automation kind 和 Projector，以免扩大未定所有权模型的状态面。

---

## 5. UI / UX 综合评价

### 做得正确的部分

- 默认入口不再冒充轻量聊天；
- 信息架构至少把普通入口和 Advanced Cockpit 分开；
- Token、运行控制、连接状态和 Composer 的可访问性明显改善；
- Workspace 在只有一个选项时改成信息展示，而不是伪装成 disabled selector；
- Automation Event 标题比裸内部类型更容易理解。

### 仍需收敛的部分

- 移动端全局布局不可用；
- Session Detail 缺少固定的“当前状态 / 待办 / 最终结果”信息锚点；
- Feed 缺少层级、分组、折叠和视觉节奏；
- 运行 ID、节点 ID、Event seq 和内部治理术语仍占用过多注意力；
- Token 输入长期占据全局 TopBar，缺少首次配置、已连接状态与安全解释；
- 长页面中右侧控制与审批容易脱离当前阅读位置；
- 默认页面大量空白，单条交付记录的状态、时间、摘要和下一动作信息密度不足。

---

## 6. 代码与测试评价

### 正向评价

- `BEGIN IMMEDIATE` 用于跨连接写临界区是当前 SQLite 架构下合理的低成本修复；
- run-execution-only 接口使用 kind 白名单和 Session / Run 绑定校验，领域边界更清晰；
- 自动化 Job 不再污染运行控制查询，避免了控制面耦合；
- 新增 Session 并发收敛测试、错误绑定测试和 Automation Feed 分支测试具有实际价值；
- 清理临时自修改脚手架是正确的安全收敛。

### 测试与流程问题

第六轮曾出现一个典型问题：实现改了 Sidebar accessible name，但自修改工作流只运行 Vitest，没有运行完整 Playwright；因此真实浏览器断言漂移未被当轮 gate 捕获。

建议把以下规则固化：

1. 任何 UI 文案、路由、ARIA name 或布局修改必须运行 Playwright；
2. 评审报告必须与代码修复在同一个 PR 提交，禁止仅存在于临时 Runner；
3. 自修改 GitHub Actions 不应持久化为常规评审机制；
4. 视觉审计应至少包含 1440、1024、768、390 四档；
5. 并发测试应区分“回归护栏”和“能够杀死旧实现的确定性交错测试”。

截至 `0e156b5`，实施方报告的本地验证为：全量测试 1299 passed / 3 skipped、Playwright E2E 全绿、Core / Web typecheck 干净；该提交对应的正式 Core Workflow 也已通过。绿色测试证明现有行为没有普通回归，但不等于产品纵向闭环或 multi-owner 语义已经完成。

---

## 7. 过度实现 / 过度设计判断

以下能力不是过度设计，而是 Tekon 的差异化资产：

```text
Workflow
Gate
Artifact
Worktree
Audit
Delivery
Human Approval
```

过度设计主要发生在 replatform 层：

- Event、Profile、Automation、Projection 和 recovery 抽象增长得很快；
- 多 owner 正确性要求接近分布式系统；
- 但一个真实 Provider 的“实时输出 → follow-up / steer → durable recovery → 同一 UI 回放”纵向切片尚未完成；
- UI 仍在用大量合成事件证明基础设施存在，而没有优先把用户任务闭环做短。

建议采用如下优先级：

1. 修复移动端基本布局；
2. 选择一个真实 Provider，完成真正增量输出；
3. 完成同一 Session 的 follow-up / steer 与 durable inbox；
4. 建立人类可读 Feed 和结构化 Final Result；
5. 选择并落实单 owner / multi-owner ADR；
6. 再扩展更多 Provider、Profile、Automation 和 Projector。

---

## 8. 合并与发布建议

### 作为基础设施里程碑继续推进的最低条件

- 第六轮报告正式落库并在 PR 描述中可发现；
- 临时自修改工作流已删除；
- Core、CLI、Web、Playwright、build、typecheck 全绿；
- README / 手册继续明确真流式、follow-up / steer、双轨和 event projection 边界；
- 不以“完整 Harness 迁移完成”或“普通用户产品可发布”名义合并。

### 达到整体“通过”之前仍需

- 移动端主要任务可完成；
- 一个真实 Provider 完成端到端流式 Agent Loop；
- Session 内 follow-up / steer 与重启恢复；
- Collaborate / Deliver 真正双轨；
- 人类可读 Feed 与完整 Final Result；
- 长 Session 分页、虚拟化、折叠和搜索；
- Runtime 所有权 ADR 及对应实现约束。

---

## 9. 第六轮直接修改记录

已确认并保留的实现修改：

- `3d6836d`：run execution / automation 控制分离；Session / Workspace 身份幂等；原子入队绑定校验；相关测试；UI 文案和 Event Feed 可读性修改；清理临时脚手架。
- `0e156b5`：修复 Sidebar 改名后的 Playwright 断言；补 Automation Event Feed 分支测试；同步用户手册 CTA；版本与 Changelog 收敛。

本报告覆盖了 `0e156b5` 中由实施 Agent 重建的报告文件；其代码与测试核验事实已纳入正文，但其“只聚焦并发/身份修复”的范围不足以代表原第六轮产品、UX、架构和视觉审查，因此不再作为最终报告文本。

---

## 10. 最终裁决

> **不通过。**
>
> 第六轮并发、身份和控制边界修复正确且应保留，阶段性基础设施质量继续提高；但移动端基本交互、真实 Provider 流式闭环、Session 持续协作、Collaborate / Deliver 双轨、长期会话规模能力和 Runtime 所有权模型仍未达到整体验收标准。
>
> 本 PR 可以作为诚实标注边界的基础设施里程碑继续推进，不能被视为普通用户产品或完整 Harness Runtime 已完成。
