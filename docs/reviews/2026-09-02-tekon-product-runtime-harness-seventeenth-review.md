# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十七轮全面复审

- **日期**：2026-09-02
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`28e010f19d513f8f21cf9e26bb31d5c5c8ed8316`
- **用户本轮整改 Head**：`d36812479fbf974b69bd24deda49efb008f709df`
- **本轮审查的产品代码快照**：`ebd93d44fa0ab3562b653cda74695cfe60a83c36`（用户本轮只追加评审批注，未修改产品代码）
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前最新发布**：`0.1.2-alpha.4`
- **用户整改自动化**：`d368124...` 的 Core #405 与 CI #314 均为 `completed/success`
- **裁决**：当前增量通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

本轮用户增量只有对第十六轮报告的四路评估批注，以及 #28–#30 三个后续 issue。没有产品代码发生变化。因此本轮的核心工作不是再制造一批无关代码，而是：

1. 重新验证第十六轮代码结论是否仍成立；
2. 检查 #28–#30 的问题定义、严重度和是否存在流程性过度设计；
3. 从完整 Run 启动、Provider command contract、Session 数据事实和默认人类路径重新做一次反向审查；
4. 复核 DeepSeek Harness `0.1.2-alpha.4` 当前官方边界；
5. 将真正需要继续做的工作收敛为可独立验证的小 PR，而不是继续扩大 PR #11。

结论如下：

- #28 的 DSH wrapper 问题真实存在，而且同一种 basename 推断在 Codex Adapter 中造成更严重的 command framing / safe-arg contract 分裂；本轮已将 #28 扩大为统一 Provider command identity 问题。
- #29 的 health 耦合问题真实存在；进一步复核发现默认 Codex/Claude 也缺少持久化前的基础 capability admission。本轮已将 #29 收敛为 credential health、Provider health 和 run admission 三层合同。
- #30 不应继续作为 P2 实施项。单维护者仓库当前用一个 Markdown checklist 已足够，native sub-issue、milestone、assignee 不改善产品、Runtime 或数据正确性；本轮将其按 `not_planned` 关闭。
- 新发现 **P1-RUN-START**：Run admission 横跨 `prepareRun → onPrepared → Session → opening Events → Job`，没有事务或 saga。任何中间失败都可能留下部分持久化和用户可见幽灵状态。已登记为 #31。
- 第十六轮的两项代码修复仍成立：DSH Adapter 已统一使用 Core preflight；顶栏 DSH unavailable 状态已进入可访问描述。
- 产品主裁决不变：Deliver 轨道已经具备工程使用价值；Collaborate、single-owner Runtime、权威 Session、可证明的 shutdown/restart、RunPlan authority 与完整历史/模型上下文预算仍未闭环。

本轮没有继续修改产品代码。原因不是没有问题，而是新确认的问题都涉及 Provider 公共合同、持久化事务/补偿或前后端 RPC 分层；在 140+ commit、190+ file 的 PR #11 中做“顺手大修”会直接违背过度设计与可回滚性评审结论。本轮直接修改的是问题边界、优先级、tracking 结构和权威报告。

## 2. 最终判断

### 2.1 当前增量代码门

用户 Head `d36812479fbf974b69bd24deda49efb008f709df` 只修改报告，且：

- Core #405：`completed/success`；
- CI #314：`completed/success`；
- Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit、Chromium Playwright 均成功。

因此，**本轮用户整改通过当前代码合并门**。

### 2.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

仍不应表述为：

- 面向普通用户的稳定多轮研发协作工作台；
- Web/CLI 多进程共享仓库时拥有完整副作用 fencing 的 Runtime；
- 能从 `session_events` 完整恢复模型上下文的 durable Session 平台；
- Run 创建要么完整成功、要么完全不留痕的原子任务系统；
- 已验证 DeepSeek Harness alpha.4 或完成真实 Provider L3 smoke；
- `network: restricted/disabled` 等价于 Host/container 级断网；
- 已完成全站 screen reader、多浏览器、缩放和真实弱网验收。

## 3. 评审范围与证据方法

本轮覆盖：

- PR #11 当前 Head、上一轮之后的完整 diff、Actions 终态；
- README、用户手册、CHANGELOG、`docs/reviews/current.md`、第十六轮报告和整改计划；
- Core：WorkflowEngine、SessionService、RunPlan、JobRunner、dual-write、CommandGateway、Provider Registry、Codex/Claude/DSH Adapter；
- CLI：默认 run、Provider preflight、Session composition root、resume/cancel；
- Web：默认 Composer、Advanced run、project health/run、TopBar、Session right rail、SSE 与历史窗口；
- 测试：SessionService、RunPlan、Provider Adapter、Web health/TopBar、Core/CLI/Web/Playwright lanes；
- #13–#31 的问题边界、依赖和是否存在重复/过度拆分；
- DeepSeek Harness `0.1.2-alpha.4` 的 release、Headless、base composition、ACP 和 Safety 官方资料。

判断原则：

1. `completed/success` 必须绑定具体 Head，文档批注不能替代终态自动化；
2. “Provider 可用”必须区分 executable、metadata contract、真实模型调用和 Host 安全；
3. “Run 已创建”必须检查 Demand/Project/Run/Plan/Audit/Session/Event/Job 是否形成一致 admission；
4. UI projection 缺失时的 snapshot fallback 只能提高韧性，不能把 best-effort Event 变成权威事实源；
5. issue 数量不是进展，原生项目管理元数据也不是产品正确性的先决条件；
6. 超大 PR 中只落地真正低风险、可独立证明的修复，不以“顺手”之名引入事务、协议或迁移重构；
7. 外部 prerelease 的 latest、tested pin、installed version、compatibility 与 bypass 必须分开。

本轮没有可访问的独立部署实例、真实 dsh alpha.3/alpha.4 二进制与 API key，也没有 Firefox/WebKit 或屏幕阅读器环境。UI 结论来自源码、ARIA 结构、响应式实现和现有 Chromium Playwright；不声称完成新的像素级视觉或辅助技术实测。

## 4. 对用户最新整改的逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| 第十六轮四路评估批注 | 通过 | 对 Adapter preflight、TopBar a11y、alpha.4 与 CI 的事实判断基本准确；未改产品代码。 |
| #28 DSH basename wrapper 问题 | 真实，但原范围过窄 | DSH execution-time preflight 确会被改名 wrapper 跳过；Codex 也存在更严重的 basename 驱动 command framing 分裂，已统一到 #28。 |
| #29 Web health 耦合 | 真实，严重度应提升到 P1 UX/Admission | token 握手同步等待可选 DSH；默认 Codex/Claude 又没有可复用的持久化前 capability admission。已扩为三层 Provider capability service。 |
| #30 tracking 平台化 | 过度设计，关闭 | 当前没有多人并行或 release train 证据；原生 subissue/milestone/assignee 不改善产品或 Runtime。轻量 checklist 足够。 |
| #27 主线拆分 | 方向通过 | 已重写为一个可读 checklist，增加 #28/#29/#31；明确 issue 登记不等于问题关闭。 |
| PR #11 squash 建议 | 通过 | 当前规模已不适合继续承载后续主线；后续必须独立 PR。 |

## 5. 本轮新增或扩大的问题

### 5.1 P1-RUN-START：Run admission 不是原子操作

#### 事实

`WorkflowEngine.prepareRun()` 当前依次执行：

```text
mkdir runDir
→ createDemand
→ createProject
→ createWorkflowInstance(status=running)
→ recordRunProviderConfig
→ persistPlan
→ audit run.started
```

随后 `SessionService.startRun()` 再执行：

```text
onPrepared audit hook
→ get/create workspace
→ createSession
→ append session/created
→ append workflow/started
→ append user/message
→ enqueue Job
```

两段之间没有一个跨步骤事务、transactional outbox 或显式 admission saga。

#### 影响

任一中间失败都可能造成：

- Demand/Project 已写，但 Run 尚未完整；
- Run/Plan/Provider snapshot 已写，但没有 Session/Job；
- Session 已写，但 opening event prefix 不完整；
- Run/Session 看似 active，但没有 Job 执行者；
- API 返回错误，用户重试又产生第二个 Run；
- overview/list/readiness/audit 对半成品给出相互矛盾的状态；
- 清理、恢复和支持人员无法区分“尚未入队”与“执行失败”。

#### 测试盲区

现有 `SessionService` 的 `onPrepared` 失败测试使用一个不写数据库的 fake Engine，只断言 Session/Job 不存在。它没有证明真实 `prepareRun` 已经写入的 Run、Demand、Project、Plan 和 Audit 被补偿。

#### 建议

优先在 #31 中做 ADR，选择：

```text
A. SQLite admission transaction + Audit outbox
```

或：

```text
B. admitting → queued / admission-failed 的幂等 saga
```

Provider preflight 与 RunPlan 校验必须在 admission 前完成；文件目录在事务后幂等创建，或由 saga 明确补偿。对每个写点做真实 SQLite 故障注入。

### 5.2 P1-PROVIDER-CMD：basename 不应决定安全合同

#### DSH

`dsh-headless-adapter.ts` 以：

```ts
basename(command) === 'dsh'
```

决定是否执行 execution-time preflight。非标准生产 wrapper 会跳过 Host Node、exact version、Help 和 Config 二次检查。

#### Codex

`codex-adapter.ts` 同样以 basename 决定“真实 Codex”路径。非 `codex` 名称时：

- `assertSafeCodexArgs()` 不执行；
- 正常 controlled global args 构造路径不执行；
- `--profile internal` 与受控 artifact `--add-dir` 不按默认合同注入；
- 用户 args 位于 `exec` 前，可能成为全局参数。

这意味着一个 wrapper 的**文件名**可以改变 Provider 权限、Profile、Artifact 和参数解释语义。测试替身便利不应成为生产 command contract。

#### 建议

#28 统一解决：

```text
providerKind
+ executable
+ commandFramingPolicy
+ preflightPolicy
+ explicit test transport seam
```

生产默认 fail-closed；fake 测试显式注入 probe/transport，不再依赖改名。

### 5.3 P1-UX-PROVIDER：credential、health 与 admission 混层

当前 `project.health` 的单次请求同时承担：

```text
Web Session token 验证
+ 可选 DSH metadata preflight
```

凭据已经有效时，UI 仍可能因为 dsh probe 卡顿而长时间显示“校验中”。服务端内部知道 Host/version/help/config 等错误，但 RPC 只返回 available/unavailable。

与此同时，默认 Codex/Claude 没有持久化前的基础 capability preflight。缺少二进制时，系统通常先创建 Run/Session/Job，再在后台失败。

#29 已扩为：

```text
fast credential health
→ independent provider health
→ reusable pre-persistence run admission
→ optional execution-time TOCTOU recheck
```

UI 默认只显示可行动摘要；详细诊断进入 Provider 设置或 CLI preflight。

### 5.4 P3-PROCESS：原生 issue 平台化当前不值得做

#30 已按 `not_planned` 关闭。原因：

- 当前没有多人并行、明确 release train 或自动容量规划；
- milestone/assignee 对单维护者几乎没有新增信息；
- Markdown 依赖与 GitHub 原生依赖需要双重维护；
- 它不降低 Runtime、数据、Provider 或 UX 风险；
- 当前真正需要的流程约束是“小 PR、明确验收、首次绿色 CI、可回滚”。

重新打开条件已经写入 #30：出现多人并行、release train 或实际路线图漂移时再平台化。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道基本成立

当前默认 Web/CLI 路径能够较诚实地表达：

```text
需求输入
→ 服务端 RunPlan/digest
→ standard-delivery 角色链
→ 隔离 worktree
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

已经成立的价值：

- 默认按钮明确写“启动受控交付”，不冒充聊天；
- 计划缺失、digest 缺失、无 token、dirty base 未确认时 fail-closed；
- DSH 不受限网络需要显式知情确认；
- Goal 与 Deliver 能力边界基本清楚；
- Artifact、Gate、Audit、Readiness 和 PR 准备形成可审阅证据；
- Session right rail 能从领域 snapshot 兜底控制和审批，不完全依赖 best-effort Event；
- README 明确披露 streaming、follow-up、Event projection 和 Workspace 限制。

因此 Tekon 已经不是“只能由 Agent 自举、人完全无法使用”的状态。它是一个面向工程用户的受控任务执行与证据工作台。

### 6.2 Collaborate 轨道仍未成立

`LegacyAgentDriver` 仍然：

- 等待 one-shot adapter 完整结束后才遍历缓冲事件；
- `followUp()` 抛 `NotSupportedYet`；
- `steer()` 抛 `NotSupportedYet`；
- `resume()` 抛 `NotSupportedYet`；
- cancel 是否真正终止外部 Provider 仍取决于 Adapter 的 signal 传播。

普通用户仍不能完成：

```text
同一 Session 继续输入
→ Provider 执行期真实语义更新
→ follow-up / steer
→ prompt-owned cancel
→ 页面刷新或 Runtime 重启后恢复
→ 在相同上下文中升级为 Deliver
```

当前 Session 的真实角色仍是运行观察、审批、治理证据和历史投影，而不是多轮研发协作空间。

### 6.3 产品概念仍偏实现导向

普通路径仍要求用户理解：

- Session 与 Run；
- Workflow 与 Goal；
- Gate、Artifact、Profile、Provider；
- Session token；
- 为什么一句需求会启动完整 PM/RD/QA/Reviewer 链路；
- 为什么进入 Session 后不能继续追问。

当前诚实披露降低了误导，但没有消除学习成本。下一阶段不应继续增加更多横向名词和配置；应优先完成 Collaborate vertical slice，再决定哪些工程概念需要对普通用户可见。

## 7. UI 实现与 UX 交互评审

### 7.1 已成立的改进

- 默认入口具有计划摘要、失败关闭和清晰的受控交付 CTA；
- TopBar 凭据编辑是 draft → explicit apply，不会边输入边切换活动 token；
- DSH unavailable 对视觉和辅助技术均可见，并提供 CLI preflight 行动入口；
- Session 列表按 needs-action/active/idle/history 排序；
- Session right rail 有领域 snapshot fallback，未知状态 fail-closed；
- Gate 查询决定真正 pending decisions；
- Event history 有 backward cursor、replay/pending budget、heartbeat backpressure 和 truncation banner；
- 两个配置详情 dialog 已具备基本焦点循环、Escape、焦点恢复与背景 inert；
- 当前 Chromium Playwright 主流程成功。

### 7.2 仍存在的主要 UX 缺口

#### 1. 凭据状态被可选 Provider 拖慢

用户只想知道连接 token 是否有效，却需要等待完整 dsh metadata probe。应先快速显示 credential 结果，再异步显示各 Provider 状态。

#### 2. Provider 故障缺少结构化详情面

TopBar 的“dsh-headless 不可用”与 CLI 命令是合理的最小动作，但长期应有 Provider 设置/诊断页，区分：

```text
not installed
host unsupported
version drift
help contract drift
config contract drift
metadata timeout
bypassed / unverified
```

#### 3. 完整历史没有用户出口

在线窗口截断后只有分页，没有：

- 导出完整 Session；
- 生成审批/复盘证据包；
- 包含 subsession、Artifact、Gate、Audit 的 manifest；
- preflight/flush/snapshot 进度和失败恢复。

这仍是 Collaborate 之外最有独立用户价值的 UX 项目。

#### 4. Admission 失败缺少一致语义

Run 启动中途失败后，用户可能只看到通用错误，却不知道是否已经创建了部分 Run。#31 完成前，重试语义和清理建议都不可靠。

#### 5. 浏览器窗口有界不等于模型上下文有界

EventFeed 限制 DOM 和内存是正确的，但不能替代模型 summary、compaction、token budget、fork/resume 和可审计 retention。

#### 6. 可访问性证据仍是局部的

当前不能从 Chromium 和几个组件测试外推：

- NVDA/JAWS/VoiceOver；
- Firefox/WebKit；
- 200%/400% zoom；
- forced-colors/high-contrast；
- reduced-motion；
- 真实弱网与后台标签页。

### 7.3 UI 审查限制

本轮没有产品实例或有效产品截图可用于重新走完整交互流。附件中的测试图片不是 Tekon 界面证据。因此本报告不声称完成像素级视觉、焦点顺序或屏幕阅读器审计；这些仍由 #21 独立执行。

## 8. Runtime 与整体框架架构

### 8.1 P0：repo 级 single-owner Runtime 仍缺失

CLI 与 Web 仍分别创建并持有：

- SQLite connection / WriteQueue / repositories；
- Session store / EventBus；
- JobRunner；
- SubprocessRegistry；
- Workflow / Automation executor；
- Git/worktree；
- Provider；
- shutdown 生命周期。

Job owner、lease、CAS 和 process-local generation token 能保护部分 Job 行，却不能完整 fence：

- 普通文件写入；
- Git branch/worktree promotion；
- Artifact、Gate、Audit；
- Automation、Delivery；
- 外部 SDK 和未登记子进程。

长期方向保持：

```text
repo-scoped daemon/service
→ physical repo lock
→ CLI/Web 客户端化
→ 统一执行、资源与 shutdown authority
```

### 8.2 P0：Shutdown 仍不能证明 quiescent

当前 JobRunner 已有：

```text
stop polling
→ wait active poll
→ settle window
→ abort controller
→ kill registered subprocesses
→ hard deadline
→ DB closed fence
```

它显著减少 late write，但 hard deadline 到达后，不合作 executor 仍可能继续 JavaScript、普通文件、Git 或外部 SDK 工作。

完整闭环需要：

```text
executor process/worker isolation
→ kill/join
→ generation fencing
→ checkpoint/flush
→ crash/restart/late-write fault injection
```

### 8.3 P0：Session Event 仍是 best-effort projection

当前 dual-write 明确采用：

```text
领域表 / Audit 先成功
→ best-effort append session_event
→ 找不到 Session 或追加失败时允许跳过
```

它适合作为 UI observation projection，不足以作为：

- durable inbox；
- 权威模型历史；
- prompt claim/processed；
- crash replay；
- fork/resume；
- restart recovery。

#13 必须明确选择 authoritative append-only Session log，或领域事实 + transactional outbox 为权威、Session 仅为可重建投影。

### 8.4 P1：Run admission 与事实源边界需要共同设计

#31 不能仅在 SessionService 外层加 try/catch 删除记录。原因：

- `prepareRun` 内部自己已经分多次写 Demand/Project/Run/Provider/Plan/Audit；
- runDir 是文件系统副作用；
- Audit hash chain 不能随意回删；
- Session Event 当前仍是 best-effort；
- Job enqueue 与 Session status 要有一致不变量。

因此 admission transaction/saga、#13 outbox 和 #20 RunPlan authority 必须共享一个事实模型，但仍应拆成可评审的小 PR。

### 8.5 P1：RunPlan 仍不是 execute/resume 的唯一事实

RunPlan 已覆盖角色、Gate、阶段、Agent、Profile、timeout、dirty-base 和 template identity，但仍未完整绑定：

- Demand id/version/hash；
- `mode`；
- base revision；
- workspace physical identity；
- resolved Provider config / executable contract；
- permission/network acknowledgement 与 enforcement evidence；
- expected Artifacts；
- executable node plan。

`RunPlanContext.mode` 仍未进入最终 plan/digest，说明调用上下文与摘要事实尚未完全同构。

## 9. 代码实现评审

### 9.1 正向判断

- DSH Host Node、version、Help、Config 已收敛到共享 preflight；
- Adapter 保留 execution-time second check，能够覆盖 planning→execution 的 binary/env 漂移；
- Web/CLI 在 DSH 持久化前 fail-closed；
- RunPlan canonical JSON/digest 与同一模板对象的使用避免了已知 TOCTOU；
- Session/Workspace SSE 的 cursor、pending cap、byte budget 和 heartbeat backpressure 有较强测试；
- JobRunner 对 ownership loss、conditional checkpoint、cancel/pause relay 和 stale recovery 有明确防线；
- CommandGateway 使用 argv/execFile 路径，秘密脱敏与进展证据有回归；
- UI 对尚未实现的 Collaborate 保持诚实禁用。

### 9.2 需要收敛的实现热点

#### Provider identity

DSH/Codex 以 basename 区分真实二进制和 fake，造成测试策略进入生产语义。应由显式 Provider contract 取代。

#### SessionService preflight seam

SessionService 的 `preflight?: () => Promise<void>` 不接收本次 engine input。CLI 为此用外部可变 `activeAgent` 在 `createEngine()` 和 `preflight()` 之间传值。单个 CLI 命令通常串行，因此当前不是高概率用户故障；但这个 API 形状不具备并发安全，也说明 Provider admission 没有真正 request-scoped。应在 #29 中把 preflight 放入输入感知的 engine/admission service，删除可变 slot。

#### Run creation

`prepareRun()` 同时创建目录和多类数据库记录，没有事务边界；SessionService 再继续追加另一组持久化。应避免局部补丁式 compensation，先定义 admission state machine。

#### CommandGateway

同一模块仍承担 policy、env、spawn、process group、redaction、filesystem sampling、total/no-progress timeout、termination 与 stream settlement。后续应按 #25 抽出纯 timeout state machine、可注入 clock、activity sampler 和 termination adapter，而不是继续追加 timer 特判。

### 9.3 测试盲区

仍缺：

- prepareRun 每个写点和 Session/Job admission 的故障注入；
- 非标准 DSH/Codex production wrapper 的真实 framing/preflight 测试；
- Codex/Claude 缺失二进制的持久化前 admission 测试；
- 双 Runtime 对同一仓库的 Git/文件副作用竞态；
- hard deadline 后普通文件/Git/SDK late work；
- authoritative Session replay / inbox duplicate consumption；
- 真实 DSH alpha.4 L2/L3；
- Firefox/WebKit、screen reader 和真实弱网。

## 10. DeepSeek Harness `0.1.2-alpha.4` 对齐

### 10.1 版本事实

```text
Tekon tested pin = 0.1.2-alpha.3
DeepSeek Harness latest = 0.1.2-alpha.4
```

继续精确 pin alpha.3 是正确的 fail-closed 决策。latest prerelease 不会自动获得兼容承诺。

### 10.2 Headless 仍然只适合 Goal/one-shot

官方 Headless 明确：

- 一次 invocation 处理一个 task；
- reasoning 增量进入 stderr；
- 最终 assistant message 进入 stdout；
- 完成后进程退出；
- 没有 interactive follow-up；
- 首 token 前没有 heartbeat。

Tekon 继续把 `dsh-headless` 限制为 experimental Goal 是正确的，不应将它包装为持续协作 Driver。

### 10.3 alpha.4 默认网络工具面扩大

alpha.3 的 base composition 中 `tool-web.config.fetch=false`；alpha.4 改为 `true`。发布说明明确 Headless、ACP、Python SDK 与 custom profiles 默认提供 `web_fetch`。

这不会绕过 Tekon 当前“DSH 网络不受限需知情确认”的外层 admission，但意味着：

- 默认网络能力比 alpha.3 更强；
- Provider snapshot/Audit 必须能记录实际版本与网络例外；
- L1 fixture 不能只检查 row id，还要检查影响治理的配置值；
- 升 pin 前必须验证 URL/SSRF、redirect、credential 和 stderr/audit 边界。

#17 已明确 L1 不阻塞、L2 只需真实 binary、L3 才需 API key；#22 负责旁路与网络例外审计。

### 10.4 ACP 仍是更合适的持续协作切片

官方 ACP 已提供：

- persistent `session/new/list/resume/close`；
- one prompt at a time；
- prompt-owned cancel；
- semantic assistant/thought/tool updates；
- permission requests；
- model/reasoning options；
- quiescent close、update drain、descendant disposal 和 persistence flush。

建议 #14 的首个 vertical slice 严格限定为：

```text
owned ACP subprocess
→ initialize
→ session/new
→ one prompt
→ semantic updates
→ prompt cancel
→ session/close
→ process restart + session/resume
```

先证明生命周期和事实映射，再决定如何连接 Tekon Session、RunPlan、Artifact 和 Collaborate→Deliver。不要把 ACP 强塞进现有 one-shot AgentAdapter。

### 10.5 Safety 边界不变

官方 Safety 继续声明 DeepSeek Harness 是未经安全审计的 developer preview；sandbox、approval 和 permission controls 只能降低风险，不能保证隔离，也不能作为不可信 workload 的唯一安全控制。

Tekon 仍需：

- least privilege；
- container/VM/专用环境选项；
- Host-side network policy；
- credential minimization/redaction；
- workspace scope；
- human approval；
- Artifact/Audit evidence；
- experimental 披露。

## 11. 是否存在过度实现或过度设计

### 11.1 产品框架：横向能力仍领先于纵向闭环

当前已有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
```

这些能力多数局部合理，但最小持续协作链路仍未完成：

```text
同一 Session 继续输入
→ Provider 执行期真实更新
→ 用户取消或转向
→ Runtime 重启后恢复
→ 升级为 Deliver
```

冻结原则继续有效：除非直接服务 single-owner、atomic admission、authoritative Session、真实 Provider stream、follow-up/cancel/resume、Collaborate→Deliver、RunPlan authority 或 export/compaction/retention，否则暂停增加 Profile、Automation job、Driver wrapper、展示 Event 和 Workflow DSL。

### 11.2 评审与 issue 流程也已过度增长

PR #11 已超过 140 个提交、190 个文件和 2.7 万行新增。继续把每个观察转成新报告、新 issue 层级、milestone、assignee 和 dependency graph，会产生一种“治理很完整”的错觉，却降低：

- 人工逐行审阅质量；
- git bisect 价值；
- schema/行为回滚能力；
- 产品优先级清晰度；
- 实际实现时间。

本轮采取的收敛动作：

- #30 关闭为 `not_planned`；
- #27 改为一个 checklist，不追求平台化项目管理；
- #28 扩范围而不是为 Codex 再制造重复 issue；
- 只新增一个真正缺失且跨事实层的问题 #31；
- PR #11 不再接受后续架构实现；
- 第十七轮作为 PR #11 的最终整合评审，后续只在独立 PR 中评审对应问题。

## 12. 问题清单

| ID / Issue | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| #16 P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级 single-owner Runtime。 |
| #15 P0-ARCH-02 | P0 | 部分完成 | abort/kill/hard deadline/DB fence 不证明 executor、Git、普通文件与 SDK quiescent。 |
| #13 P0-DATA-01 | P0 | 未关闭 | Session Event 是 best-effort projection，不是 durable inbox/权威模型历史。 |
| #14/#19 P0-PRODUCT-01 | P0 | 未关闭 | 真实 stream、follow-up/steer/cancel/resume 与 Collaborate→Deliver 缺失。 |
| #31 P1-RUN-START | P1 | 本轮新增 | prepareRun、Session、opening Events、Job 缺事务/saga，可能部分持久化。 |
| #20 P1-PLAN-01 | P1 | 部分完成 | RunPlan 尚未成为 execute/resume 唯一事实。 |
| #29 P1-UX-PROVIDER | P1 | 扩大范围 | Credential health、Provider health、run admission 混层；默认 Provider 缺早期 probe。 |
| #28 P1-PROVIDER-CMD | P1 | 扩大范围 | DSH/Codex 的 basename 推断改变 preflight/argv/权限合同。 |
| #18 P1-SESSION-01 | P1 | 部分完成 | 在线历史有界；完整 export、compaction、retention 和规模矩阵仍缺。 |
| #17 P1-DSH-01 | P1 | 部分完成 | alpha.4 L1/L2/L3 与默认 web_fetch 尚未完成。 |
| #22 P1-DSH-02 | P1 | 未关闭 | Host/version/network bypass 未进入 Provider snapshot/Audit。 |
| #21 P1-A11Y-01 | P1 | 未关闭 | 缺全站 screen reader、多浏览器、缩放、对比度和弱网验收。 |
| #24 P1-GOV-01 | P1 | 暂缓 | main 未保护，required checks 未强制。 |
| #25 P2-CODE-02 | P2 | 未关闭 | CommandGateway 职责和 timeout state machine 过密。 |
| #26 P2-CODE-01 | P2 | 未关闭 | 无真实 JS/TS semantic lint，format debt 仍存在。 |
| #30 P3-PROCESS | P3 | not_planned | 原生 issue 平台化当前收益不足，轻量 checklist 足够。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR #11 体量已显著降低审阅、二分和回滚可靠性。 |

## 13. 推荐实施顺序

### 第一组：执行权威与 admission

```text
#16 single-owner Runtime
→ #15 executor isolation/restart
→ #29 Provider health/admission
→ #28 Provider command identity
→ #31 atomic Run admission
```

#29/#28 可以在 #16 前做独立小 PR，但最终运行必须由 single-owner authority 承载。

### 第二组：事实源与持续协作

```text
#13 authoritative Session/outbox/inbox
→ #14 ACP vertical slice
→ #19 Collaborate→Deliver
```

### 第三组：执行合同与历史

```text
#20 RunPlan authority
→ #18 complete export + compaction + retention
```

#20 应与 #31 协同，确保 admission 持久化的是实际 execute/resume authority，而不是另一个展示快照。

### 第四组：Provider、质量与发布

```text
#17 alpha.4 validation
#22 exception audit
#21 a11y
#25 CommandGateway split
#26 static lint
#24 required checks（Owner 决策）
```

## 14. 合并与发布边界

当前代码门通过只能证明：

- `d368124...` 相对上一轮没有产品代码回归；
- 现有 Core、Root、Audit、CLI、Web unit 和 Chromium Playwright 合同成功；
- 第十六轮 DSH Adapter/a11y 修复仍在；
- 当前文档/issue 收敛没有破坏构建。

它不能证明：

- 两个 Runtime 并发没有 Git/文件副作用冲突；
- stop 返回后所有 executor/SDK/Git/文件都已停止；
- Run admission 失败不会留下半成品；
- Session log 能恢复完整模型上下文；
- 任意规模会话具备一致资源预算；
- alpha.4 已通过真实 binary/API smoke；
- Firefox/WebKit/辅助技术已通过；
- main 的 GitHub 规则会阻止红色 CI 合并。

PR #11 最终建议使用 squash merge。合并前必须再次确认 Head 与 Core/CI 终态一致；后续 #13–#31 只通过独立 PR 推进，不再回填本 PR。

本轮未执行 merge、release、deploy 或仓库 ruleset 修改。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第十六轮报告](2026-09-02-tekon-product-runtime-harness-sixteenth-review.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [`WorkflowEngine.prepareRun`](../../packages/core/src/workflow/engine.ts)
- [`SessionService.startRun`](../../packages/core/src/session/session-service.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`DSH Adapter`](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [`Codex Adapter`](../../packages/core/src/runtime/codex-adapter.ts)
- [`Web project health/run`](../../packages/web/src/server/api/routers/project.ts)
- [Tracking #27](https://github.com/zesming/tekon/issues/27)
- [Provider command contract #28](https://github.com/zesming/tekon/issues/28)
- [Provider health/admission #29](https://github.com/zesming/tekon/issues/29)
- [Atomic Run admission #31](https://github.com/zesming/tekon/issues/31)

### DeepSeek Harness 官方

- [v0.1.2-alpha.4 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/bundle/headless/README.md)
- [Headless composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/bundle/headless/cordis.patch.yml)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/bundle/base/cordis.patch.yml)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/acp/acp/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/SAFETY.md)

## 16. 批注（2026-09-02 主代理两路评估）

### 16.1 两路评估结论（一致）

| 评估路 | 结论 | 关键证据 |
| --- | --- | --- |
| 3 个 P1 深入核查 | **全部真实存在** | P1-PROVIDER-CMD：`codex-adapter.ts:212` basename 推断，非 `codex` 命名时跳过 `assertSafeCodexArgs`/受控 global args/profile 白名单/artifact 校验，且 fallback 分支把 `--sandbox`/`--ask-for-approval` 放在 `exec` 后不生效，治理姿态为零；DSH 侧 `assertSafeDshArgs` 无条件调用（arg 白名单不跳过），但 `ensureCapabilityGate` 中 `if (!realDsh) return` 跳过全套 preflight。P1-RUN-START：`engine.ts:318-403` prepareRun 七个写操作无事务/saga，`session-service.ts:202-247` 两段之间无原子性，失败留孤儿 run；现有测试用 fakeEngine 从不失败，盲区属实。P1-UX-PROVIDER：`project.ts:147` probeProvider 只在 token 有效时调用，DSH 有三层 preflight 而 Codex/Claude 为零层 |
| Issue 操作与 CI 健康 | **全部合理，CI 全绿** | #28/#29 已升级 P1 并扩范围，#31 新建内容完整（8 条逐失败点注入验收），#30 not_planned 关闭理由充分，#27 已同步为四组 checklist；本地 `pnpm test` 140 文件/1518 passed/3 skipped，PR #11 CI 7 项全绿，MERGEABLE/CLEAN |

两路对本报告的裁决无异议：3 个 P1 发现方向正确、证据充分；issue 操作（升级/新建/关闭）合理；alpha.3 tested pin 维持 fail-closed 正确；PR #11 应按 §14 建议 squash merge。

### 16.2 补充发现

Wegener 评估中发现报告未提及的两处细节：

1. **DSH 注释与代码矛盾**：`dsh-headless-adapter.ts:112-121` 注释声称 "renaming the binary can never drop the headless contract or the whitelist"，但 `ensureCapabilityGate` 中 `if (!realDsh) return` 实际跳过了 capability gate。whitelist 部分成立（`assertSafeDshArgs` 无条件调用），capability gate 部分与代码矛盾。本轮修复注释，避免误导。
2. **Codex fallback 分支治理姿态为零**：非 `codex` 命名时，`--sandbox workspace-write --ask-for-approval on-request` 被放在 `exec` 子命令之后，对真实 codex CLI 不生效。已在 #28 中覆盖。

### 16.3 本轮决策

1. **修复 DSH 注释矛盾**：将 `dsh-headless-adapter.ts:112-121` 的注释改为准确描述——arg 白名单无条件执行，但 capability gate（preflight）依赖 basename 推断，命名不同的 wrapper 会跳过。
2. **3 个 P1 留独立 PR**：P1-PROVIDER-CMD（#28）、P1-UX-PROVIDER（#29）、P1-RUN-START（#31）均为跨模块架构变更，不适合在已冻结的 PR #11 内进行。
3. **PR #11 合并建议**：同意报告 §14 建议，本轮批注+注释修复后即可 squash merge；合并后按 §13 第一组顺序（#16 → #15 → #29/#28 → #31）推进独立 PR。

### 16.4 验证承诺

本轮改动为注释修正+文档批注，不改变代码行为。改动后将重新执行 `pnpm test` 确认无回归，并推送到 PR #11。
