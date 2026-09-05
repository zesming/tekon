# Tekon 人类可用性与 DeepSeek Harness 架构第八轮全面复审

- **日期**：2026-08-30
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **用户整改起点**：`4c4197d5c931bed820717befa0d2f5bd8368accd`
- **用户提交快照**：`692ca76b9452d6cb242e9f746c572ccad5bdd0b4`
- **本轮 reviewer 修复提交**：`f0c9ae0086722a745352095f932e67bac6d13d8c`、`816b097b668d3da98c19b0cbaec85a2234ef976a`
- **产品版本**：`0.18.0`
- **外部基线**：DeepSeek Harness `cd5ef8148158c3a752a658978873241fdf8e2bbc`
- **最终自动化状态**：`816b097b...`：Core #302 `completed/success`；CI #211 `completed/success`（Root、CLI unit/e2e、Web build/typecheck/unit、Playwright 均成功）
- **裁决**：本轮整改与 reviewer 低风险修复通过代码合并门；整体产品仍未通过稳定持续协作验收

## 1. 执行摘要

本轮不是对第七轮报告做措辞复查，而是从上轮权威快照之后重新核验当前 PR 的全部新增实现，并回看此前未关闭的核心主链路。用户本轮共增加 4 个提交、改动 59 个文件，重点落在：

1. Workflow 模板目录统一；
2. 执行计划失败关闭和 digest；
3. DSH capability preflight；
4. `project.health` 与顶栏连接状态；
5. 长 Session 分页、SSE 尾窗和客户端窗口；
6. Node 版本合同；
7. E2E locator helper；
8. shutdown hard deadline 与 `interrupted` 状态。

这些整改大多是实质改进，不是纯文档包装。尤其是模板目录、Node 版本、默认计划展示、连接握手、事件尾窗和中断状态，已经明显提高了产品诚实度和测试覆盖。

但本轮也确认：若把“新增机制存在”直接等同于“端到端合同已闭环”，仍会高估当前成熟度。最关键的三个例子是：

- Plan digest 存在，但仍可省略、覆盖字段不完整、没有作为 Run 的持久快照；
- shutdown hard deadline 存在，但 deadline 到期后未结算的进程内 executor 仍可能继续运行，调用方却可以关闭 SQLite；
- DSH help/config/version probe 存在，但发生在 Run、Session、Job、role-run 和 worktree 等持久副作用之后。

因此，本轮对整改项采用三种结论：**关闭、部分关闭、未关闭**，不以新增测试数量替代运行时语义核验。

## 2. 最终判断

### 2.1 当前 PR 增量

`816b097b668d3da98c19b0cbaec85a2234ef976a` 的 Core #302 与 CI #211 均为 `completed + success`。因此，本轮用户整改与 reviewer 低风险修复**通过当前代码合并门**。本结论不代表已执行 merge、release 或 deploy。

### 2.2 产品成熟度

Tekon v0.18.0 可以继续按以下定位使用：

> 测试覆盖较强、风险边界逐渐透明的实验性受控交付执行与观察基础设施。

它还不应被定位为：

- 面向普通用户的稳定持续协作研发工作台；
- 可安全同时由 CLI/Web 多进程执行的 Runtime；
- 拥有权威 Session 事实链和 crash-safe resume 的 Agent 平台；
- 已完成全链路有界化和生产级 shutdown 的服务；
- 可以把 DeepSeek Harness 本身当作生产安全边界的系统。

## 3. 评审范围与方法

本轮覆盖以下材料和实现路径：

- 根目录 README、CHANGELOG、安装脚本、版本与 Node 合同；
- `packages/core` 的 Workflow、Session、JobRunner、Provider、CommandGateway、数据库迁移；
- `packages/cli` 的 run、workflow、初始化与 Session 执行路径；
- `packages/web` 的默认 Session 入口、高级 Run 表单、连接管理、SSE、查询缓存、配置页；
- 当前 PR 的 Core/CI GitHub Actions；
- 第七轮报告、`current.md`、整改方案与 ADR；
- DeepSeek Harness 官方 Safety、headless、SDK client/app、ACP app/protocol 文档。

判断原则：

1. 文档声明必须能在代码调用顺序中找到对应保证；
2. 测试必须证明目标合同，而不只是证明函数返回；
3. “有上限”必须同时考虑数据库、网络、浏览器内存和 DOM；
4. “已验证连接”必须区分凭据、具体 Provider 和服务健康；
5. 迁移期投影不能被描述成权威事件源；
6. 架构级缺陷不使用局部补丁制造“已关闭”假象。

## 4. 对本轮八项整改的逐项复核

| 整改项 | 结论 | 说明 |
| --- | --- | --- |
| Web/CLI 统一 Workflow catalog | **基本关闭** | Built-in 与项目模板统一列出，运行标识回到文件名，项目模板可覆盖 built-in。非法 YAML 仍可能先出现在目录再在 plan 阶段失败，属于后续 UX 改进。 |
| 高级入口 plan fail-closed + digest | **部分关闭** | 高级入口已发送 digest；本轮补上默认 Session 入口。但 digest 仍可被服务端省略，Goal 不校验，覆盖字段不完整，也未持久绑定 Run。 |
| DSH production preflight | **部分关闭** | 真实 adapter 已检查 version/help/config，但 probe 仍在 `runAgent()` 内懒执行，早于模型命令却晚于多项持久副作用。 |
| `project.health` + TopBar | **部分关闭** | 已能区分有效/无效凭据。本轮修复前端 raw-token query key、校验错误和刷新；服务端 cache 仍以原 token 为 key，且 Provider 字段实际上只探测 dsh。 |
| 长 Session 全链路有界 | **部分关闭** | 初始 DB page、SSE tail 和浏览器窗口显著改善；API limit 无最大值、SSE reconnect backlog/背压、过滤后分页终止等仍未完全有界。 |
| Node 版本一致性 | **关闭** | 根 `engines`、README、installer 和手册已统一为 `^20.19.0 || >=22.12.0`，并有一致性测试。 |
| E2E locator helper | **关闭当前漂移问题** | 稳定凭据和操作名称已集中；这不是全站 Page Object，也不应继续扩成测试框架。 |
| shutdown hard deadline + interrupted | **部分关闭，需降级表述** | 合作 executor 的 interrupted 三分流成立；不合作 executor 超过 hard deadline 后，`stop()` 返回但任务 Promise 未必终止，尚非 quiescent shutdown。 |

## 5. 产品逻辑评审

### 5.1 Deliver 轨道已形成真实产品价值

当前默认入口能够：

- 读取服务端计划；
- 展示角色链和控制点；
- 发起 `standard-delivery`；
- 创建 Session 与后台 Job；
- 展示阶段、事件、产物和审批；
- 执行取消、暂停、恢复；
- 准备交付材料并保留 PR 人工边界。

这已经不是单纯底层框架。它可用于低风险、有人监督的受控交付试验。

### 5.2 Collaborate 轨道仍不存在

默认输入框的真实语义仍是“创建一次新的完整交付 Run”，不是同一 Session 的持续协作。当前仍缺：

```text
持续输入
→ durable inbox
→ 真实 execution-time stream
→ follow-up / steer
→ 中途取消或转向
→ 进程重启后恢复
→ 从 Collaborate 升级为 Deliver
```

`LegacyAgentDriver` 的 `followUp`、`steer`、`resume` 仍属于 `NotSupportedYet`，且 one-shot 事件要等运行结束后才能完整迭代。UI 对此保持诚实是正确的，但不能把 Session 外形等同于协作能力。

### 5.3 Run plan 仍不是权威产品合同

当前 digest 基于以下投影：

- `roleChain`
- Gates
- `requiresUnrestrictedNetwork`
- Phases

它没有完整绑定：

- Agent/Provider 身份；
- Profile；
- `allowDirtyBase`；
- timeout / no-progress / heartbeat；
- 网络确认事实；
- Provider config snapshot；
- 需求或批准版本；
- Artifact 期望；
- 工作区与 base revision。

此外服务端仅在 `planDigest` 被提供时校验，测试还明确保留“省略 digest 时继续运行”的旧行为。Goal 模式完全忽略 digest。计划也没有作为 Run snapshot 或 audit fact 持久化。

本轮 reviewer 已修复默认 Session 入口不发送 digest 的直接缺陷，但完整方向应是：

```text
canonical RunPlan
→ digest/hash
→ 用户确认
→ 原子创建 Run/Session/Job
→ 持久保存 plan snapshot
→ execute/resume 只使用该 snapshot
```

### 5.4 Profile 与 Automation 仍领先于主产品闭环

`human-web`、`autonomous-delivery`、Goal、Automation、Readiness 等横向能力有价值，但当前最重要的缺口仍是一个真实 Provider 的持续 Session vertical slice。继续增加更多 Profile、事件类型或自动化策略，会提高认知和迁移成本，却不直接改善普通用户的核心旅程。

## 6. UI 与 UX 评审

### 6.1 已确认的改进

- 默认入口不再在计划失败时静默启动；
- 顶栏不再把“字符串存在”直接称为“已连接”，而是验证凭据；
- Session 列表按行动优先级排序；
- 失败会话可明确标记已处理；
- 技术事件默认不淹没人类叙事；
- 移动抽屉的焦点和 `inert` 处理已有专门测试；
- Workflow 列表能展示 built-in 与项目模板；
- 长历史首屏和 DOM 数量受控。

### 6.2 连接状态仍需进一步产品化

`project.health` 的 `provider` 字段实际只执行 `dsh --version`，却在原 UI 中显示成泛化的 “Provider 不可用”。这会让使用 Codex、Claude Code 或 mock 的用户误以为全部 Provider 不健康。

本轮 reviewer 将文案收敛为 `dsh-headless 不可用`，并增加：

- auth-scoped query key，避免把原 token 写入前端 cache key；
- 校验请求失败状态；
- 60 秒周期刷新。

但服务端仍需后续改造：

- cache key 不保存原 token；
- 过期条目真正清理，限制 Map 大小；
- 按具体 Provider 返回结构化 probe；
- 区分凭据有效、Web 服务可达、Provider 可执行、Provider 配置兼容。

### 6.3 配置详情面板存在“看起来能做，实际不能做”的问题

Workflow 详情原有“查看 YAML”按钮没有事件处理，是典型 dead affordance。本轮已删除，而不是增加假跳转。

Role/Workflow 详情面板本轮补了基本 `role="dialog"`、`aria-modal` 和关闭按钮标签。但还未完成：

- 打开后将焦点移入；
- Escape 关闭；
- Tab focus trap；
- 关闭后恢复触发按钮；
- 背景 inert；
- 标题通过 `aria-labelledby` 关联。

因此只能称为基础语义改进，不能关闭全站可访问性专项。

### 6.4 术语负担仍偏高

普通路径仍暴露 Session、Run、Profile、Gate、Artifact、Provider 等内部概念。建议默认旅程优先使用：

- 任务；
- 执行计划；
- 当前阶段；
- 需要你确认；
- 结果与证据；
- 准备交付。

工程术语保留在高级模式和技术详情中。

## 7. 整体框架与运行时架构评审

### 7.1 P0：仍缺 repo 级单一 Runtime authority

CLI 与 Web 仍可以各自创建 JobRunner，并共享：

- SQLite；
- Git 仓库和 delivery branch；
- worktree lease；
- `.tekon/runs` 文件；
- Artifact/Gate/Audit/Delivery；
- Provider 子进程。

Job owner、lease、CAS 和 Git expected-old OID 能减少一部分重复执行，但不能 fence 所有副作用。最合适的下一步仍是：

```text
repo lock
→ single-owner daemon
→ CLI/Web/IDE 作为客户端
→ daemon 统一拥有 Job、Git、worktree、subprocess 和 shutdown
```

除非明确选择 active-active，否则不建议继续为每类副作用各写一套 generation fencing。

### 7.2 P0：hard deadline 不是 quiescent shutdown

当前 `stop()` 的合作路径已经改善：

1. 停止 claim；
2. 等待 settle；
3. abort controller；
4. kill registry subprocess；
5. 标记 interrupted；
6. 再等待；
7. hard deadline 到点后返回。

问题在第 7 步：若 executor 是不合作的进程内 Promise，hard deadline 只能停止等待，不能让 JavaScript 任务消失。`api.close()` 随后会关闭 SQLite，而未结算 executor 仍可在未来继续调用 repository、文件系统或 Git。

现有测试只证明 `stop()` 在 deadline 内返回，没有证明 deadline 后不存在 late write。

可靠方案只有两类：

- 把执行单元放进可终止的子进程/worker/daemon 进程，并 join 到真实退出；
- 或规定所有 executor 必须合作，并在返回前证明所有 pending task 已 settled。

“返回有上限”与“资源已静止”是两个不同合同，不能用一个 timeout 同时宣称完成。

### 7.3 P0：Session Event 仍是 best-effort projection

当前写入顺序仍是旧领域表/Audit 成功后，再 best-effort 追加 Session Event。找不到 Session 或 append 失败可以跳过。

这意味着 Session Event 不能可靠承担：

- 模型上下文唯一事实源；
- durable inbox；
- prompt claim；
- replay/fork；
- crash resume；
- 完整历史审计。

需要单独 ADR 选择：

1. Session log 权威，领域表为 projection；
2. 领域表权威，Session 长期只做 UI projection；
3. transactional outbox 保证提交与投影。

在选型完成前，不应让 UI、Driver 和恢复逻辑同时假设它既是投影又是权威历史。

### 7.4 P1：数据引用完整性仍未完成

`session_events`、`jobs`、`projection_checkpoints` 等 Session 子表仍缺统一外键与删除策略。专项迁移需要：

- 扫描并分类孤儿行；
- 定义 cascade/restrict/quarantine；
- SQLite table rebuild；
- 老库 upgrade/rollback；
- 直接插入 fixture 的迁移；
- 新旧版本兼容测试。

只给新数据库补约束会制造行为分裂，不算闭环。

## 8. 长 Session 与实时链路评审

### 8.1 已取得的实质进展

当前已增加：

- `listEventsPage`；
- 初始 SSE tail window；
- catch-up 分块；
- 客户端事件窗口；
- “加载更早”；
- 展示层的技术事件过滤和卡片折叠。

这明显优于上一轮“仅限制初始 DOM”的状态。

### 8.2 仍未全链路有界

#### API limit 无最大值

RPC schema 只要求正整数，没有 `.max()`；调用者仍可请求极大 page。应在 contract 和 store 两层限制，例如 500 或 1000。

#### reconnect backlog 未设总预算

SSE 重连后会从 `Last-Event-ID` 连续追赶到最新序号。分块只限制单次查询，不限制总网络量和响应缓冲。

#### 未处理 response backpressure

`response.write()` 的返回值没有驱动 `drain`，极慢客户端或超大 backlog 可在 Node 进程中积累输出缓冲。

#### UI 过滤可能提前结束“更早历史”

服务端先取 raw page，再经过 `presentEvent` 过滤。若某页全是内部事件，客户端可能收到空数组并判断没有更早的人类可见事件，虽然更老位置仍有可见内容。

#### 客户端窗口仍有边界细节

加载历史后保留区间可能短暂超过目标上限；应该把 retain floor、当前尾部和用户显式展开状态纳入统一窗口策略。

合理终态应同时约束：

```text
DB page
+ per-request limit
+ reconnect byte/event budget
+ backpressure
+ browser memory
+ DOM
+ model-context compaction
```

## 9. DeepSeek Harness 外部对照

本轮以官方仓库 `cd5ef8148158c3a752a658978873241fdf8e2bbc` 为基线。

### 9.1 headless 继续只适合 Goal

官方 headless 明确是：

- 一次调用一个 task；
- 输出最终 answer；
- 进程退出；
- 无 interactive follow-up。

Tekon 将 `dsh-headless` 限制为 Goal/one-shot 是正确方向，不应继续在该桥接层模拟 Collaborate。

### 9.2 当前 pin 落后于官方发布

Tekon 仍以 `0.1.1-rc.2` 为 tested version；官方已发布 `0.1.2-alpha.1`。Fail-closed 本身是正确的，但会导致按最新官方安装的用户默认无法运行。

不建议未经 contract fixture 和真实 smoke 就直接改 pin。应提供：

```text
tekon provider preflight dsh-headless
→ 实际版本
→ tested 版本
→ help/config contract
→ 精确兼容安装命令
→ 受控 escape hatch
```

### 9.3 preflight 调用位置仍过晚

当前 version/help/config probe 在 `runAgent()` 内懒执行。在此之前系统可能已经：

- prepare Run；
- 写 Demand/Project/Workflow/Node/provider snapshot；
- 创建 Session；
- 追加 opening events；
- enqueue Job；
- 创建 role run；
- 创建 worktree lease。

因此它只能保证“模型命令前 fail”，不能保证“持久副作用前 fail”。

### 9.4 SDK 与 ACP 的选择

官方 SDK client 已支持：

- stdio JSON-RPC；
- 打开 Session；
- durable inbox receipt；
- 事件和 notification；
- typed errors；
- bounded initialize；
- close 时 EOF → SIGTERM → SIGKILL 并等待真实进程退出。

但官方 SDK 当前没有 mid-turn cancel；放弃 turn 通常意味着关闭 Runtime。

官方 ACP 更接近 Tekon 的持续协作目标，支持：

- persistent session；
- list/resume/close；
- prompt/cancel；
- semantic updates；
- permission request；
- model/reasoning option；
- session 级 quiescent close。

建议先实现一个独立 vertical slice 对比，而不是把 SDK/ACP 强塞进现有 one-shot `AgentAdapter`：

```text
真实 Provider
→ persistent session
→ one prompt
→ execution-time message/tool updates
→ cancel
→ close
→ restart + resume
→ 再决定长期 Driver 接口
```

### 9.5 安全边界

DeepSeek Harness 官方明确说明其为未经安全审计的 developer preview，sandbox、approval 和 permission control 只能降低风险，不能保证隔离。

Tekon 必须继续使用独立的：

- 最小权限进程；
- 容器/VM 或专用环境；
- credential scrub；
- workspace scope；
- 人工副作用 gate；
- 宿主备份和审计。

## 10. 代码实现与工程质量

### 10.1 正面评价

- 多数运行模式检查在持久副作用前完成；
- Workflow 模板解析使用严格 schema；
- CommandGateway 保持 argv 执行，不调用 shell；
- secret redaction、artifact manifest、progress evidence 有回归测试；
- Session 列表失败代际和行动排序已有明确函数；
- Query cache 的 auth-scope 和 stale generation 防串数据逻辑较完整；
- E2E 已覆盖生产静态服务、fragment bootstrap 和 URL token 泄漏；
- 安装器版本、Node 合同、Web/CLI 路径一致性明显改善。

### 10.2 本轮 CI 发现的真实问题

用户 head 的 Core workflow 在以下用例失败：

`command-gateway.test.ts`  
`treats controlled artifact and manifest writes as no-progress activity`

问题不是产品实现必然错误，而是测试只给最后一次文件活动到 child close 留出约 50ms、相对 no-progress timeout 只有很小调度裕量。在 GitHub runner 负载下稳定触发过一次超时。

本轮 reviewer：

- 保留“如果没有文件活动必须超时”的证明关系；
- 将两个输出活动用例的调度间隔和 timeout 一起放大；
- 没有删除测试、增加 retry 或放松 `timedOut:false` 断言。

### 10.3 仍需注意的复杂度热点

- `project.ts` 同时承担 scope、draft、plan、provider、health、cleanup、run orchestration；
- Session Event dual-write 在多个层级存在显式补发和例外；
- Job/Workflow/Session 三组状态需要多处映射；
- Profile/Automation/Goal 扩大了组合矩阵；
- 大量历史 review/plan 文档增加维护噪音。

后续应优先做垂直切片和边界收敛，而不是继续增加 wrapper、event type 或 display profile。

## 11. 过度实现与过度设计判断

### 11.1 已存在的风险

当前横向抽象包括：

- AgentAdapter / AgentDriver；
- Provider Registry；
- Legacy Driver；
- JobRunner；
- Session projection；
- dual-write；
- Automation；
- Profile；
- Goal；
- Readiness；
- Delivery；
- 多套 CLI/Web 表面。

其中不少抽象本身合理，但它们已经领先于以下最小用户闭环：

```text
同一 Session 继续说话
→ Agent 运行中产生真实事件
→ 用户中途取消或转向
→ Runtime 重启后恢复
→ 交付升级
```

### 11.2 后续冻结原则

除非直接服务下面任一项，否则暂缓新增横向抽象：

- single-owner Runtime；
- authoritative Session log / durable inbox；
- ACP/SDK real-provider vertical slice；
- follow-up / cancel / resume；
- Collaborate → Deliver；
- 数据与网络全链路预算。

### 11.3 评审文档也要控制复杂度

`current.md` 应保持稳定入口；本报告是当前详细裁决；旧报告只作为判断演进历史。CHANGELOG 只记录用户可见行为，不复制 reviewer 过程。

## 12. 本轮 reviewer 直接修复

提交：`f0c9ae0086722a745352095f932e67bac6d13d8c`、`816b097b668d3da98c19b0cbaec85a2234ef976a`

1. 默认 `SessionComposer` 必须拿到 plan digest 才能启动，并把 digest 发送到 `project.run`；
2. `project.health` 前端 query key 改用 auth scope，不再包含原始 session token；
3. 健康检查错误显示“校验失败”，并每 60 秒刷新；
4. 将泛化“Provider 不可用”纠正为 `dsh-headless 不可用`；
5. 删除无实现的“查看 YAML”按钮；
6. Role/Workflow 详情补基础 dialog 和关闭按钮可访问名称；
7. 扩大 output-activity 测试定时裕量，但保留无活动时必须超时的判定。

这些修改刻意没有触碰：

- single-owner daemon；
- Session 事实源选型；
- hard-deadline executor 隔离；
- SDK/ACP 集成；
- SQLite 外键 migration。

原因是这些事项需要独立设计、迁移和故障注入，不能以同一评审 PR 的顺手补丁替代。

## 13. 主要问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级单一 Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | hard deadline 有界返回，但不保证不合作 executor 已 quiescent。 |
| P0-ARCH-03 | P0 | 未关闭 | Session Event 仍是 best-effort projection，不是 durable inbox/权威历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | Collaborate、follow-up、steer、真实 streaming、restart resume 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | digest 可省略、覆盖字段不完整、Goal 不校验、未持久化 snapshot。 |
| P1-DSH-01 | P1 | 部分完成 | preflight 晚于持久副作用；tested pin 落后官方发布。 |
| P1-SESSION-01 | P1 | 部分完成 | API limit、reconnect budget、SSE backpressure 和过滤分页仍未有界。 |
| P1-HEALTH-01 | P1 | 部分完成 | 服务端 raw-token cache、无清理上限、Provider 语义仅代表 dsh。 |
| P1-DATA-01 | P1 | 未关闭 | Session 子表外键、孤儿治理和老库 migration 缺失。 |
| P1-A11Y-01 | P1 | 未关闭 | 全站 dialog focus、屏幕阅读器、多浏览器与对比度专项未完成。 |
| P2-TEST-01 | P2 | 本轮修复 | output activity 测试调度裕量过小，导致 Core workflow 红。 |
| P2-UX-01 | P2 | 部分修复 | 配置详情 dead affordance 已移除，完整 modal focus 语义仍待专项。 |

## 14. 建议实施顺序

1. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB 和 shutdown 所有权。

2. **quiescent shutdown / restart contract**  
   executor 隔离、真实 join、interrupted checkpoint、故障注入。

3. **authoritative Session log + durable inbox**  
   明确事实源、事务提交、claim、processed、retry 与 migration。

4. **DeepSeek ACP 或 SDK vertical slice**  
   首选验证 ACP 的 cancel/resume；同时记录 SDK no-mid-turn-cancel 边界。

5. **Collaborate → Deliver**  
   同一 Session follow-up、转向、计划升级和审批点。

6. **canonical RunPlan snapshot**  
   绑定需求、Provider、Profile、权限、超时、workspace/base、Artifacts 和 digest。

7. **全链路历史预算**  
   DB/API/SSE/backpressure/client/DOM/model context 一起有界。

8. **数据与可访问性专项**  
   外键迁移、孤儿治理、dialog focus、screen reader 和多浏览器。

## 15. 合并与发布边界

当前 PR 即使通过代码检查，也只能证明：

- 当前变更在现有测试合同下可构建、类型检查和运行；
- Deliver 路径具备较好的实验性基础；
- 本轮未引入新的已知阻断回归。

它不能证明：

- 两个 Runtime 并发安全；
- 服务关闭后绝无 late write；
- Session history 可完整恢复模型上下文；
- 长 Session 任意规模均有稳定内存和网络预算；
- DSH 0.1.2-alpha.1 已被 Tekon 正式兼容；
- 普通用户持续协作产品已经完成；
- 全站可访问性已验收。

## 16. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [当前迁移范围](../technical/tekon-replatform-current-scope.md)
- [第七轮整改方案](../superpowers/plans/2026-08-30-seventh-review-remediation-plan.md)

### DeepSeek Harness 官方

- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/SAFETY.md)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/bundle/headless/README.md)
- [SDK app](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/bundle/sdk-app/README.md)
- [SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/sdk/client/README.md)
- [ACP app](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/bundle/acp-app/README.md)
- [ACP protocol](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/acp/acp/README.md)
- [dsh 0.1.2-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh%400.1.2-alpha.1)

## 17. 结论

**代码合并门：通过。** `816b097b...` 的 Core #302 与 CI #211 已完整成功，当前没有必须继续扩大本 PR 才能修复的新增阻断回归。

**整体产品验收：不通过。** Tekon 的 Deliver 轨道已经具有真实实验价值，但 single-owner Runtime、可证明的 quiescent shutdown、权威 Session log/durable inbox、真实 Provider 持续 streaming、follow-up/steer/resume、Collaborate → Deliver、canonical RunPlan 和全链路历史预算仍未闭环。

因此最准确的结论是：

> Tekon v0.18.0 的当前增量可以继续合并审阅；项目可作为有人监督的实验性受控交付执行与观察基础设施使用，但尚不能按稳定持续协作研发工作台发布。

---

## 18. 维护者复核批注（2026-08-30 第二轮）

本节是维护者在报告推送后，对全部认定做的独立代码级复核，作为后续整改的依据。

### 18.1 复核方法

- 同步 DeepSeek Harness 官方仓库至 `~/Projects/deepseek-harness`，确认官方 `master` HEAD 即报告基线 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，基线之后无新提交；最新发布仍是 `dsh-v0.1.2-alpha.1`。
- 并行委派三个 explorer subagent，对第 13 节问题清单逐项做只读代码核查，要求文件+行号证据。
- 复核对象为分支 `review/human-first-harness-2026-08-28`，HEAD `c732d5d`。

### 18.2 逐项认定结论

| ID | 报告认定 | 复核结论 | 关键证据 |
| --- | --- | --- | --- |
| P0-ARCH-01 | 未关闭 | **认定准确** | CLI 与 Web 各自 `createJobRunner`（[session-context.ts:148](../../packages/cli/src/lib/session-context.ts:148)、[root.ts:107](../../packages/web/src/server/api/root.ts:107)）；`run_locks` 表存在但全仓无加锁逻辑；`daemon` 在 `packages/` 下零实现。 |
| P0-ARCH-02 | 部分完成 | **认定准确** | [job-runner.ts:609](../../packages/core/src/session/job-runner.ts:609) 的 `Promise.race([drainTasks, hardDeadline])` 超时即返回，随后 `db.close()`（[root.ts:311](../../packages/web/src/server/api/root.ts:311)）；[job-runner-stop-race.test.ts:260](../../packages/core/__tests__/session/job-runner-stop-race.test.ts:260) 只断言 1000ms 内返回，未证明 deadline 后无 late write。 |
| P0-ARCH-03 | 未关闭 | **认定准确** | [dual-write.ts:223](../../packages/core/src/session/dual-write.ts:223) 明确 best-effort、查不到 session 静默跳过、异常只 `reportError`；`inbox`/`outbox` 在 `packages/` 下零实现。 |
| P0-PRODUCT-01 | 未关闭 | **认定准确** | `LegacyAgentDriver` 的 `followUp`/`steer`/`resume` 仍为 `NotSupportedYet`；Collaborate 主链路无实现。 |
| P1-PLAN-01 | 部分完成 | **认定准确** | [rpc-contract.ts:76](../../packages/web/src/shared/rpc-contract.ts:76) `planDigest` 仍 optional；[project.ts:267](../../packages/web/src/server/api/routers/project.ts:267) 仅 `!isGoal && runInput.planDigest` 时校验，省略与 Goal 模式均跳过（测试 [project-run-digest.test.ts:63](../../packages/web/__tests__/api/project-run-digest.test.ts:63) 固化旧行为）；[run-plan.ts:21](../../packages/core/src/workflow/run-plan.ts:21) digest 仅覆盖 4 个投影字段；Run 无 plan snapshot 持久化。 |
| P1-DSH-01 | 部分完成 | **认定准确** | [dsh-bridge-probe.ts:16](../../packages/core/src/runtime/dsh-bridge-probe.ts:16) `TESTED_DSH_VERSION = '0.1.1-rc.2'`；probe 在 [dsh-headless-adapter.ts:281](../../packages/core/src/runtime/dsh-headless-adapter.ts:281) `runAgent()` 内懒执行，晚于 `prepareRun`、`createSession`、`enqueueJob`、role_run 与 worktree 创建。 |
| P1-SESSION-01 | 部分完成 | **认定准确** | [rpc-contract.ts:166](../../packages/web/src/shared/rpc-contract.ts:166) limit 无 `.max()`；[sse.ts:132](../../packages/web/src/server/sse.ts:132) reconnect `for(;;)` 追赶无总预算；[sse.ts:80](../../packages/web/src/server/sse.ts:80) 忽略 `response.write()` 返回值；[session.ts:217](../../packages/web/src/server/api/routers/session.ts:217) 先取 raw page 再过滤，整页被过滤时客户端 [use-session-stream.ts:65](../../packages/web/src/client/hooks/use-session-stream.ts:65) 误判 `hasEarlier=false`；`loadEarlier` 不裁剪窗口。 |
| P1-HEALTH-01 | 部分完成 | **认定准确** | [project.ts:84](../../packages/web/src/server/api/routers/project.ts:84) cache key 拼原始 token；`Map` 无 TTL 清理与容量上限；`probeProvider()` 硬编码 `dsh --version`。 |
| P1-DATA-01 | 未关闭 | **认定准确** | [migrations.ts:182](../../packages/core/src/db/migrations.ts:182) `session_events`/`jobs`/`projection_checkpoints` 的 `session_id` 均无 `references sessions(id)`；对比 workflow 子表均有 `on delete cascade`；无 table rebuild 或孤儿治理迁移。 |
| P1-A11Y-01 | 未关闭 | **认定准确** | [RoleDetailPanel.tsx:30](../../packages/web/src/client/components/config/RoleDetailPanel.tsx:30) 与 [WorkflowDetailPanel.tsx:28](../../packages/web/src/client/components/config/WorkflowDetailPanel.tsx:28) 仅有 `role="dialog"`/`aria-modal`/遮罩点击关闭；无 focus trap、Escape、焦点恢复、背景 inert、`aria-labelledby`。 |
| P2-TEST-01 | 本轮修复 | **认定准确** | 调度裕量修复已在 `816b097b` 落地，断言未放松。 |
| P2-UX-01 | 部分修复 | **认定准确** | dead affordance 已删除；完整 modal focus 语义仍缺。 |

### 18.3 DeepSeek Harness 基线核实

- `dsh-headless` 官方 README 仍明确 "one task per invocation, with no interactive follow-up"，报告 9.1 的边界判断成立。
- ACP app README 仍声明 persistent session、`session/resume`、`session/cancel`、quiescent `session/close`；SDK client 仍是 EOF → SIGTERM → SIGKILL 梯子且无 mid-turn cancel。报告 9.4 的方向判断成立。
- `0.1.1-rc.2 → 0.1.2-alpha.1` 之间 headless 有 streaming 修复（reasoning 连续块、chunk 穷尽处理），但不改变 one-shot 合同；报告"未经 contract fixture 与真实 smoke 不直接升 pin"的谨慎立场成立。

### 18.4 维护者判断

报告的 12 项认定与代码事实全部一致，无过时项、无高估项，作为本轮整改的权威依据。据此确定本轮整改边界：

1. **本轮闭环（P1）**：canonical RunPlan snapshot 与 digest 强制化；DSH preflight 前移到持久副作用之前；长 Session 全链路有界（limit 上限、reconnect 预算、backpressure、过滤分页、客户端窗口）；health cache 哈希化+容量上限+TTL 清理+provider 语义诚实化；Session 子表外键迁移与孤儿治理；dialog 可访问性专项。
2. **本轮增量、不宣称关闭（P0-ARCH-02）**：shutdown 后增加 closed 栅栏，使 deadline 后迟到的 repository/文件写入快速失败而非静默 late write，并用故障注入测试证明；完整 quiescence 仍依赖 executor 进程隔离，保留为架构后续。
3. **本轮不触碰（架构级）**：P0-ARCH-01 single-owner daemon、P0-ARCH-03 Session 事实源选型、P0-PRODUCT-01 Collaborate 主链路、DSH pin 升级。这些需要独立 ADR、迁移设计与真实 provider smoke，不以本 PR 顺手补丁替代，按第 14 节顺序推进。

整改方案与 reviewer 循环评审记录见 `docs/superpowers/plans/2026-08-30-eighth-review-remediation-plan.md`。

---

## 19. 第 18 节批注整改结果（v0.19.0）

本节记录第 18 节维护者批注后的整改落地情况。整改方案见 `docs/superpowers/plans/2026-08-30-eighth-review-remediation-plan.md`（经三轮 reviewer 循环评审，第三轮"未检出必须修复项"）；实施后经两轮 code review，第二轮结论"可放行"。

### 19.1 已闭环

| 报告 ID | 整改内容 | 关键证据 |
| --- | --- | --- |
| P1-PLAN-01 | digest 输入域扩展为完整执行参数（agent/profile/allowDirtyBase/timeout 系列/templateId/templateVersion），agent 在 `projectRunPlan` 内归一化为 `'codex'`；Web workflow 模式强制校验（缺失 `PLAN_DIGEST_REQUIRED`、不匹配 `PLAN_DIGEST_MISMATCH`），Goal 模式免校验；Run 持久化 `plan_snapshot`/`plan_digest`；CLI 自算 digest 并持久化 | `run-plan.ts`、`engine.ts`、`project.ts`、`StartRunForm.tsx`、`project-run-digest.test.ts`、`start-run-form.test.ts`（真实表单提交 e2e） |
| P1-DSH-01 | `runDshPreflight` 导出；preflight 前移到 `createEngine` 之后、`prepareRun` 之前（Web 与 CLI 组合根均注入 hook）；新增 `tekon provider preflight dsh-headless` 命令（tested/actual/合同/安装指引，exit 0/1） | `dsh-bridge-probe.ts`、`session-service.ts`、`root.ts`、`session-context.ts`、`commands/provider.ts`、`provider-preflight.test.ts`（含真实进程 e2e） |
| P1-SESSION-01 | RPC limit `.max(1000)`；SSE reconnect 预算（2000 事件 / 4MB）超限截断为尾窗并发 `replay-truncated`；`response.write()` drain 背压；`session.events` 按可见事件分页（最多扫描 5 个 raw page）；客户端 `loadEarlier` 后立即裁剪窗口 | `rpc-contract.ts`、`sse.ts`、`session.ts`、`use-session-stream.ts`、对应测试 |
| P1-HEALTH-01 | cache key 改 SHA-256(token)；容量上限 128 + 惰性 TTL 清理；`provider` 重命名为 `dshHeadless`（rpc-contract/context/router/TopBar 全同步） | `project.ts`、`project-health.test.ts` |
| P1-DATA-01 | schema v5：`session_events`/`jobs`/`projection_checkpoints` table rebuild 加 `references sessions(id) on delete cascade`；事务内 `defer_foreign_keys=ON`；孤儿行 quarantine 到 `*_orphan_quarantine`；迁移前后 `integrity_check` 校验返回值 | `migrations.ts`、`migrations.test.ts`（新库 FK、v4 老库迁移、quarantine 计数） |
| P1-A11Y-01 / P2-UX-01 | `useDialogA11y` hook：focus 移入、Tab 循环、Escape 关闭、焦点恢复、背景 inert、`aria-labelledby`；Role/Workflow 详情接入 | `use-dialog-a11y.ts`、`RoleDetailPanel.tsx`、`WorkflowDetailPanel.tsx`、`config-detail-dialog-a11y.test.ts` |

### 19.2 P0 增量（不宣称关闭）

| 报告 ID | 整改内容 | 边界 |
| --- | --- | --- |
| P0-ARCH-02 | `TekonDatabase` 写路径 closed 栅栏（`markClosed()`/`isClosed()`），Web/CLI 关停序列在 `db.close()` 前置位；故障注入测试证明 deadline 后 executor 直接经 repository 写库被拒绝 | 只拦 repository/db 写，不拦 command-gateway/worktree 的裸文件写；进程内不合作 Promise 仍无法真正终止，完整 quiescence 依赖 executor 进程隔离（架构后续） |

### 19.3 维持冻结（架构级，按第 14 节顺序推进）

- P0-ARCH-01 single-owner daemon + repo lock；
- P0-ARCH-03 Session 事实源选型（需 ADR）；
- P0-PRODUCT-01 Collaborate 主链路、follow-up/steer/resume、真实 streaming；
- DSH pin 升级到 `0.1.2-alpha.1`（需 contract fixture + 真实 smoke；preflight 命令已把兼容矩阵做透明）。

### 19.4 验证证据

- `pnpm test`：134 文件、1454 通过、3 跳过；
- `pnpm typecheck`：core/cli/web 全绿；
- `pnpm build`：成功；
- Playwright e2e：35 通过（含新增 digest 对称性、dialog a11y 用例）；
- CLI e2e：provider preflight 真实进程用例通过；
- UI 截图核查：默认入口、高级表单、顶栏连接面板、移动端（390px）无错位/重叠/展示错误；
- code review：两轮，第二轮"未检出必须修复项，可放行"（两条非阻塞建议：preflight agent 经共享变量传递的理论并发窗口、migrations 改动范围描述，均记录在案）。

### 19.5 残留与已知边界

- preflight 的 agent 判定经组合根闭包变量传递，理论并发 startRun 可交错（单用户 MVP 下概率极低；adapter 层 `ensureCapabilityGate` 仍 fail-closed，不构成安全绕过）；
- SSE `replay-truncated` 尾窗帧本身不参与背压核算（风险低，预算仍有界）；
- db 层栅栏不覆盖文件写（见 19.2 边界）。
