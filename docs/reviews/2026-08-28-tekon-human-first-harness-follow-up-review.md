# Tekon 调整后人类可用性与 Harness 架构全面复审

- **复审日期**：2026-08-28
- **被复审基线**：`review/human-first-harness-2026-08-28@cad6190670c846ba03d0756bf9837e80c01eafb9`
- **复审分支**：`review/human-first-harness-followup-2026-08-28`
- **复审维度**：产品逻辑、CLI/Web UI、UX 交互、Runtime、Session/Job、DeepSeek Harness 对齐、代码质量、测试可信度、过度实现与过度设计
- **最终结论**：**本轮调整有效，但 Tekon 整体仍不通过“普通人稳定、持续使用”的产品验收；作为受控交付实验性基础设施，可以继续有条件演进。**

> 本报告不把“没有实现 Collaborate”直接写成“现有产品合同不成立”。当前 README、首页标题和 Composer 已明确把默认产品描述为“受控交付”，这一公开合同是诚实的。仍未通过的原因，是人类使用闭环、Runtime 所有权和 Session 事实链尚不足以支撑稳定长期使用。

---

## 1. 执行摘要

用户在上一轮报告后新增了 Session 列表最近活动时间、待审批/待输入/失败行动徽标、相对时间展示和对应测试，并修复了一个相对导入错误。该增量方向正确：它让“我现在要处理哪一个交付”比单纯按创建时间排列更清楚，当前分支的 Core 与完整 CI 也均已通过。

但复核后，P1-04 不能直接标为完整关闭：

1. `listSessions()` 只用最新 `session_event` 或 `created_at` 计算活动时间，忽略了持久化的 `sessions.updated_at`。而 `session_events` 明确是 best-effort projection；当状态更新成功但事件投影缺失或延迟时，真正需要人处理的会话仍可能沉在列表后方。
2. `awaiting-input` 实际由 blocked workflow 派生，当前 Session 详情没有会话内 follow-up 输入框。直接展示“待输入”会向用户承诺一个不存在的动作。
3. Session 列表页本身没有 workspace/session 级订阅或后台轮询；“产生事件后自动置顶”只在下一次 RPC refetch 后成立，当前仍依赖手动刷新或其它页面触发缓存失效。
4. 上一份报告原建议还包括 `unread/changedSinceSeen`、运行中状态和未发送草稿；本轮只实现了其中一部分，不能把整个 P1-04 视为完全关闭。

本复审分支已经低风险修复前两项：

- 服务端最终活动时间取 `max(projected lastActivityAt, durable updatedAt)`，并按该值重新排序；
- UI 保留兼容的 `actionKind: input`，但将用户可见文案从“待输入”改成真实可执行的“待恢复”；
- 相对时间改用语义化 `<time dateTime>`；
- 新增纯函数测试锁定活动时间和稳定排序；
- 产品版本提升到 `0.16.1`。

列表实时更新、未读语义和架构级 P0 不适合在本 PR 里用轮询或更多兼容层草率解决，保留为独立纵向里程碑。

---

## 2. 本轮调整的验收结果

| 调整项 | 结论 | 理由与依据 |
| --- | --- | --- |
| `tekon` 无参数显示帮助 | **通过，保留** | 返回 0、首屏给出 Web/直接运行/完整帮助路径，降低首次使用门槛。 |
| CLI 与 updater 使用根产品版本 | **通过，保留** | 产品可见版本统一读取根 `package.json`；内部 workspace package 版本不再暴露给 CLI 用户。 |
| Session 列表显示行动徽标 | **部分通过，本 PR 补修** | 待审批和失败语义成立；blocked workflow 原显示“待输入”但没有输入入口，本 PR 改为“待恢复”。 |
| Session 按最近活动排序 | **部分通过，本 PR 补修** | 用户实现覆盖最新事件，但遗漏 durable `sessions.updated_at`；本 PR 取两者较新值并在 API 层稳定重排。 |
| P1-04 完整关闭 | **不接受** | 未实现实时列表更新、`unread/changedSinceSeen`、草稿状态；报告应改为“已关闭排序与行动徽标子项”。 |
| 桌面/移动截图核验 | **证据不足** | 上一报告称做过截图，但截图没有归档到仓库或 Actions artifact，无法独立复核；不能据此宣称完成全站视觉审计。 |
| 当前分支测试与 CI | **通过** | 被复审 HEAD `cad6190` 的 Core #271、CI #180 均为 success；本复审分支最终结果见 PR。 |

---

## 3. 产品逻辑评审

### 3.1 当前“受控交付”合同已经诚实

当前首页标题、按钮和说明均明确写“受控交付”，Composer 也直接提示会启动 `standard-delivery` PM/RD/QA/Reviewer 全链路，轻量协作、追问与转向尚未开放。因此，不应继续把“没有 Collaborate”表述为现有对外合同欺骗。

**正确判断是**：

- 作为本地受控交付 runner，产品定位基本自洽；
- 作为人类日常研发工作台，它仍缺最重要的持续交互闭环；
- 产品应明确区分“当前可交付能力”与“长期 Session/Collaborate 愿景”。

### 3.2 普通人的持续使用闭环仍未成立（P0-PRODUCT-01）

**事实**：

- Session 详情没有当前会话的输入 Composer；
- `LegacyAgentDriver.followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`；
- `events()` 等待 one-shot `runAgent()` 完成后再回放缓冲事件；
- `agent-step-events.ts` 的 tool/assistant 事件主要是节点执行完成后的摘要投影；
- blocked workflow 被映射成 `awaiting-input`，但用户只能走恢复/诊断路径，不能真正补充上下文后继续同一 Turn。

**影响**：

- 人类无法在执行中纠偏，只能取消、等待或另开 run；
- 需求澄清仍主要发生在 Tekon 外部 Agent；
- “Session”在交互层仍更像运行记录，而不是持续协作单元；
- 低风险小任务也默认进入完整治理链，启动成本偏高。

**建议**：建立真实的两轨产品，而不是继续扩展更多 profile 名称：

- **Collaborate**：连续输入、真实 streaming、durable inbox、steer、取消、恢复，默认无 PR 副作用；
- **Deliver**：用户显式升级后才进入角色、gate、artifact、worktree 和 PR 准备。

### 3.3 启动完整交付前缺少可理解预览（P1-PRODUCT-02）

当前用户输入需求后会直接创建完整 workflow。虽然文案说明了全链路，但仍没有在提交前展示：

- 将使用的 provider、模板与角色；
- 关键 gate 与可能的人工审批点；
- 工作区、网络和凭证边界；
- 是否会修改源码、创建 worktree、准备 PR；
- 大致成本与耗时影响因素。

建议增加一个简洁的 Run Plan 确认面板；高级 timeout/profile 参数折叠，不把框架内部配置倾倒给新用户。

---

## 4. UI / UX 评审

### 4.1 Session 列表改进方向正确

本轮新增的行动徽标、状态徽标、交付标签和相对时间，使列表从“对象清单”向“行动队列”迈进。标题可截断、徽标不只靠颜色传达语义，方向应保留。

本 PR 额外修复：

- 状态行更新比 event projection 新时，也能让会话排到正确位置；
- blocked 状态显示“待恢复”，不再承诺不存在的输入动作；
- 活动时间使用 `<time>` 元素。

### 4.2 列表并非实时（P1-UX-01）

`SessionsPage` 只执行 `session.list` 查询并提供手动“刷新”。`useSessionStream()` 会在详情页收到事件时 invalidate list cache，但列表页本身没有任何 Session stream。用户停留在列表页时，新事件、审批请求或失败状态不会主动出现。

不建议简单加固定轮询：当前 `useQuery` refetch 会进入 loading 状态，容易造成列表闪烁，也不能提供可靠未读语义。更合理的纵向方案是 workspace-level lightweight stream，或者给列表读模型提供 revision/cursor，并做保持旧数据的后台 revalidate。

### 4.3 行动排序仍缺“已看过”语义（P1-UX-02）

`needsAction` 只能说明状态类型，不能说明用户是否已经看过变化。仍缺：

- `changedSinceSeen` / unread revision；
- 上次查看时间或已读游标；
- “刚刚失败”“新审批”与长期遗留问题的区分；
- 草稿未发送状态。

因此 P1-04 应标记为“排序与行动徽标子项已修”，而不是完整关闭。

### 4.4 Token 控件仍暴露实现细节（P1-UX-03）

TopBar 长期显示 Session token 输入框并自动应用。URL fragment bootstrap 和 sessionStorage 对本地工具是合理机制，但普通用户不应持续管理 credential 字符串。

建议默认只显示“已连接 / 认证失败 / 重连中”，把手工 token 放入故障排查设置，并通过显式 Apply 切换 auth scope。

### 4.5 长 Session 与 Final Result 仍不足（P1-UX-04）

当前 Feed 已默认隐藏技术事件，这是正确收敛；但仍缺：

- 分页、虚拟化和有界 DOM；
- 回合导航与上下文压力提示；
- 结构化 Final Result：changed files、diff、build/lint/test、gate、review、风险、PR/CI 与下一步；
- projection health / degraded 提示。

### 4.6 视觉审查边界

本轮没有可访问的已部署实例，也没有可复核的仓库内截图。因而这里只完成代码和交互模型审查，不宣称完成像素级布局、动效、真实焦点顺序或全站跨尺寸视觉验收。后续正式 UI audit 应把桌面、移动、错误、空态、审批和长列表截图作为 Actions artifact 或 `docs/reviews/assets/` 归档。

---

## 5. Runtime 与整体框架架构

### P0-RUNTIME-01：仍然没有单一执行所有者

Web composition root 和 CLI session context 都会创建并启动 JobRunner，访问同一项目的 SQLite、Git worktree、运行目录和子进程世界。现有 owner/status 条件写和 Git expected-old OID CAS 是有效防护，但没有形成贯穿以下副作用的持久 execution authority：

- Node transition；
- Artifact、Audit、Gate、Delivery；
- Git commit / promotion；
- 文件系统写入；
- subprocess 生命周期；
- shutdown quiescence。

`run_locks` 表虽然已经存在，但生产代码没有把它用作 repo runtime lock。这种“有锁表、无所有权协议”的状态反而容易给维护者错误安全感。

**推荐**：优先实现 single-owner daemon。一个 repo 只有一个 Runtime；Web/CLI/IDE 都作为客户端。第二 owner 必须 fail-fast，并显示 PID、启动时间、socket 和恢复指引。只有明确需要并行 owner 后才建设 generation lease 与全副作用 fencing。

### P0-RUNTIME-02：Shutdown 仍非 quiescent

JobRunner `stop()` 最多等待约 5 秒，之后清理 controller/token/heartbeat 等进程内引用。清空引用不等于 executor、子进程、Git/文件写入已经停止。

正确关闭合同至少要：

1. 停止领取新 job；
2. 持久化 cancelling/paused；
3. abort provider 并 kill 注册子进程；
4. join executor、gate、Git 和 listener；
5. 确认无 late writes；
6. 才释放 owner 并关闭数据库。

### P0-ARCH-01：Session 事实源仍分裂

当前旧领域表是事实源，`session_events` 是写后 best-effort projection。这个选择对迁移期 observability 合理，但不能同时声称已获得 Harness 的权威 Session Log：

- 模型可见输入不保证都能从 log 重建；
- append 失败可静默丢失；
- durable inbox、claim、retry 和 restart recovery 不存在；
- fork/resume/transcript 不能只依赖这一条流；
- list activity 甚至需要同时参考 durable session row 与 projection event。

后续必须通过 ADR 二选一：

- 明确长期保持 projection-only，删除/降级误导性的 Agent Session 契约；
- 或迁移为 authoritative log，通过事务/outbox/commit barrier 和 flush checkpoint保证模型可见事实可靠落盘。

---

## 6. DeepSeek Harness 对齐判断

### 6.1 当前接入只是 headless provider bridge，不是“框架已经基于 DSH”

Tekon 的 Runtime、Session、Job、Tool/Gate、persistence 和 UI 都由自身实现；`dsh-headless` 只是一个 goal-only、one-shot 外部 provider 适配器。产品和文档应避免把这一边界描述成完整 Harness runtime 重构完成。

### 6.2 官方已经提供更适合持续 Session 的表面

DeepSeek Harness 官方当前提供：

- `sdk` profile：stdio JSON-RPC，stdout 保留给协议帧，具备明确 shutdown/persistence 生命周期；
- `acp` profile：persistent agents、session new/list/resume、语义更新、取消和标准协议控制；
- durable Session log、inbox claim、`assistant/chunk`、tool lifecycle 和 interrupted-turn recovery。

参考：

- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1>

### 6.3 下一步应先做“边界选择 ADR”

不要同时建设 Tekon 自己的完整 AgentDriver/Session persistence，又继续加深 headless bridge。先回答：

- DSH 只是可替换模型 provider；还是
- DSH 负责持续 Agent Session，Tekon 专注于 Deliver governance；还是
- Tekon 完全自持 Runtime，只借鉴 Harness 事件模型。

若目标是尽快获得人类持续协作，优先做一个 SDK 或 ACP vertical spike，比较：

- streaming / follow-up / cancel / resume；
- workspace、sandbox、network、credential 边界；
- Session persistence 与 Tekon artifact/gate 的衔接；
- shutdown、故障恢复和版本漂移成本。

### 6.4 安全边界不能外包给 Harness

官方 Safety 明确说明 Harness 尚未经过安全审计，sandbox、approval 和 permission 不能保证隔离。Tekon 应继续保持最小权限、隔离工作区、凭证不落盘和危险副作用人工确认；长期建议为 DSH/Codex/Claude provider 提供容器或 disposable VM 运行模式。

---

## 7. 代码实现与测试质量

### P1-CODE-01：Session list SQL 会随完整事件历史增长

Core `listSessions` 使用 `LEFT JOIN session_events + max(timestamp) + group by`，每次列表读取都聚合 workspace 下所有事件。当前规模可接受，但长 Session 正是已知未完成项；数据增大后，这条查询会成为热路径。

建议后续：

- 将 durable `sessions.updated_at` 作为最小可靠活动时间；
- 使用 `(session_id, seq)` 索引读取最新事件，或维护事务性 activity projection；
- 用 query plan 和 1k sessions / 100k events 基准验证，而不是提前增加缓存层。

### P1-CODE-02：`session.list` 与 `session.get` 同名字段语义不同

List 的 `lastActivityAt` 包含事件投影，Get 目前只返回 `updatedAt`。虽然详情页尚未消费该字段，同一 RPC 类型中同名字段语义不同会形成后续隐患。应在真正消费前统一为 store projection，或从 detail schema 移除该字段。

### P2-TEST-01：时间排序测试依赖 20ms sleep

现有测试用 `setTimeout(20)` 强制时间戳先后，容易在高负载或未来 fake timer 环境中脆弱。建议注入 clock，或直接构造确定性的 DB 时间值。此次新增纯函数测试避免继续扩大 sleep 覆盖，但没有重写已有测试。

### P2-PROCESS-01：CHANGELOG 已成为第二套评审数据库

`CHANGELOG.md` 已超过 100 KB，混入多轮内部复审、批注、自动化修复和架构决策细节。它难以承担用户发布说明，也重复 `docs/reviews/`。

建议：

- CHANGELOG 只保留用户可见 Added/Changed/Fixed/Removed/Deprecated/Security；
- 每轮复审过程放在 `docs/reviews/`；
- ADR 放在稳定的 `docs/technical/adr/`；
- 发布时从短条目链接报告，不复制报告正文。

---

## 8. 过度实现与过度设计

以下并非全部需要立即删除，但必须冻结扩展，直到有生产消费者：

| 表面 | 当前事实 | 判断 |
| --- | --- | --- |
| `run_locks` 表 | 迁移中存在，Runtime 未使用 | 未形成安全边界，容易产生错误安全感。 |
| `LegacyAgentDriver` | 生产搜索仅见实现与测试；followUp/steer/resume 不可用 | 契约先于纵向消费者，继续扩展前应先接一个真实路径。 |
| DSH capability probe | help/config contract 函数主要存在于测试，生产 adapter 运行时只做版本 gate | “已验证能力”与实际运行期检查边界需写清。 |
| `review-only` profile | policy primitive 存在，公开 run schema/入口未开放 | 暂属装饰性平台能力，不应继续增加 profile。 |
| Profile/Automation/Goal | 已有多套路由与 executor | 在 durable inbox/streaming/ownership 之前横向扩展，收益顺序倒置。 |
| Session event vocabulary | 定义了 chunk/steer 等类型，真实 producer 不完整 | 词汇表不能代替用户闭环；未实现类型应明确 experimental。 |
| Web/CLI 双 composition root | 大量镜像装配代码 | 在 single-owner 选型后应收敛为 daemon composition root + clients。 |

**总体建议**：停止新增抽象名词和横向能力。每个后续 PR 必须交付一个可运行纵向 journey，并删除被替代的兼容层。

---

## 9. 本复审 PR 已修改内容

### FIX-FU-01：活动排序纳入 durable session update

- 新增 `effectiveLastActivityAt()`：取 event projection 与 `sessions.updated_at` 较新者；
- 新增 `sortSessionsByActivity()`：按有效活动时间、创建时间和 ID 稳定排序；
- `session.list` 输出使用有效活动时间；
- 新增纯函数测试覆盖状态更新晚于事件、事件晚于状态及稳定排序。

**理由**：best-effort event 不应决定人类行动队列的唯一顺序。

### FIX-FU-02：阻断态改为真实可执行文案

- 保留 RPC `actionKind: input` 兼容值；
- 用户可见徽标从“待输入”改为“待恢复”；
- 活动时间使用 `<time dateTime>`。

**理由**：当前产品没有同 Session 输入动作，blocked workflow 的现有恢复入口才是用户能执行的操作。

### FIX-FU-03：版本

- 根版本 `0.16.0 → 0.16.1`，作为 Session 投影与 UX 语义 bug fix。

README、主用户手册和既有报告未修改：它们不描述活动排序算法或“待输入”徽标的具体行为；本次事实与依据集中归档在本报告和新 PR 中，避免继续扩大旧报告与 CHANGELOG。

---

## 10. 推荐实施顺序

1. **Runtime owner PR**：repo lock、daemon/client、第二 owner fail-fast、quiescent shutdown。
2. **Harness boundary ADR + spike**：对比 DSH SDK/ACP 与自持 Runtime，做真实 streaming/cancel/resume 最小实验。
3. **Durable interaction PR**：authoritative message/inbox、claim/idempotency/retry/restart recovery。
4. **Collaborate vertical slice**：同 Session follow-up/steer、真实 chunk、轻量默认权限。
5. **Deliver upgrade PR**：从 Collaborate 显式升级到 workflow/gate/artifact/PR。
6. **Human UI PR**：workspace stream、needs-action/unread、Run Plan、Current-state Inspector、结构化 Final Result。
7. **Scale PR**：分页、虚拟化、bounded replay、性能预算与 projection health。
8. **清理 PR**：删除 dead `run_locks`/unused driver/probe/profile 或把它们接入真实生产路径；瘦身 CHANGELOG。

---

## 11. 验证与验收边界

### 已验证

- 被复审 HEAD `cad6190`：GitHub Actions Core #271 success、CI #180 success。
- 本复审新增测试先于实现提交，覆盖 effective activity 与排序逻辑。
- 本复审分支最终 GitHub Actions 结果将记录在新 PR 描述中。

### 未声称验证

- 未在本环境启动真实浏览器或本地 Tekon provider；
- 未执行真实 Codex/Claude/DSH 网络调用；
- 未完成多进程交错、daemon restart 或 crash recovery 实验；
- 未完成全站 screenshot-backed UI audit；
- 未执行 merge、release 或 deploy。

---

## 12. 最终裁决

### 对用户本轮调整

**代码增量基本正确，方向通过；P1-04 只能判“部分关闭”，本 PR 已补修两个具体缺口。**

### 对当前仓库整体

**不通过普通人稳定、持续使用的产品验收。**

阻断原因不是文案或一两个 UI 细节，而是：

- 无持续 Session 输入/纠偏；
- 无 single-owner execution authority；
- shutdown 不保证 quiescence；
- Session log 不是权威模型/恢复事实源；
- DSH 只接入 one-shot headless provider，SDK/ACP 与 Tekon 自持 Runtime 的边界尚未决策；
- 横向抽象明显领先纵向产品闭环。

**可以继续有条件演进的部分**：Workflow、Gate、Artifact、Worktree、Audit、Delivery、Human Approval、Independent Review，以及本轮改善后的人类行动列表。这些是 Tekon 应保留的差异化资产。
