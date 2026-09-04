# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第二十二轮全面复审

- **日期**：2026-09-04
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`34a542f963b495673b4f7adc48c2c5a574fc7052`
- **用户本轮整改 Head**：`5fa791e7384cce931c254847879c665d3fff6f97`
- **Reviewer 代码修复 Head**：`2073a0f4a6ee9956f69398dee33d3c70d0c9e607`
- **本轮收口代码快照**：`a843fc100037adce6fd1a86f6d9097ce95dd32fd`
- **产品版本**：`0.21.0`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前最新发布**：`0.1.3-alpha.1`
- **0.1.3-alpha.1 tag commit**：`d347e703908d0406b7a7ef80e3a0e594d86b2215`
- **Reviewer 代码自动化**（对应 `2073a0f...`）：Core #431、CI #340 均为 `completed/success`；Root build/typecheck、production dependency audit、Node 20.19/22.12/22.19/24 compatibility、CLI build/unit/e2e、Web build/typecheck/unit、Chromium Playwright 全部成功
- **本轮收口本地验证**：151 个测试文件、1614 passed/1 skipped；CLI e2e 8/8；Chromium 51/51；全包 typecheck/build 与真实 production audit 通过
- **最终裁决**：第 22 轮六项收口切片通过本地代码门和独立复审；新 PR Head 的远端 Actions 终态以 PR 外部状态为准。Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

> 阅读说明：§1–§12 主要保留 `2073a0f...` 时点的原始复审判断，§13–§15 已回填局部状态；§17 是实施前批注，§18 是 `a843fc1...` 收口后的当前裁决。旧时点与 §18 冲突时，以 §18 为准。

## 1. 执行摘要

本节保留 `2073a0f...` 时点的原始复审判断。六项收口切片的最终完成结果见 §18；旧时点结论与 §18 冲突时，以 §18 为准。

用户本轮在第二十一轮基础上完成了两项真实工程改进：

1. 新增独立 Node Compatibility Job，在 20.19、22.12、22.19、24 四个选定边界执行 Frozen Install、全包 Build/Typecheck、Core/CLI Unit 与 CLI Binary Smoke；
2. 修复 CommandGateway 已结算命令的 AbortSignal Listener 生命周期，并覆盖 Spawn 与 Listener 注册之间的窄竞态。

两项改动方向均正确，且功能、四档矩阵、CLI/Web 和 Chromium 均通过。用户整改 Head 的唯一红灯来自生产依赖 Audit：npm Security Audit Endpoint 连续 `ERR_SOCKET_TIMEOUT`，不是发现 Advisory，也不是应用测试失败。

本轮 Reviewer 直接修复该 CI 可用性缺口：生产 Audit 保持独立、保持 Fail-closed，只增加一次有界重试并将 Job 上限调到 12 分钟；第二次失败仍使 CI 红灯，不使用 `continue-on-error`。代码 Head `2073a0f...` 的 Core #431 与 CI #340 全部成功。

重新从全仓和最新外部合同反向检查后，仍有五项需要进入当前权威判断：

- **Node 矩阵只证明选定边界，不证明整个 `engines` 范围**。根范围 `^20.19.0 || >=22.12.0` 还会接纳 Node 23、25、26 和未来 Major；Node 20、23、25 截至本轮已 EOL，官方建议生产应用使用 Active/Maintenance LTS。
- **DeepSeek Harness 最新发布已从 rc.1 变为 `0.1.3-alpha.1`**。它引入 lifecycle-owned `SessionHandle`、每 Session 单写者锁、v2 Session Format、代理环境支持和已知历史加载性能回退；不能只更新版本号或直接追新升 pin。
- **上游代理支持暴露了 Tekon 的显式配置缺口**。Tekon 正式 DSH Run 的 Exact Env 不继承 Proxy，隐私默认合理，但企业代理环境当前无法使用；需要 Trusted Proxy 配置和脱敏证据，而不是恢复整份 `process.env`。
- **CommandGateway 的局部 Listener 修复成立，但模块职责仍过密**。Timeout/Cancel、进程树、活动采样和日志错误优先级仍应拆成可测试的小状态机，而不是继续累加特判。
- **评审和测试工具继续出现过度增长**。当前 PR、报告 HTML/方案镜像和 400 余行自定义响应式 Geometry Scanner 已超出最小产品收敛所需；后续不应再回填新的“大一统整改”。

因此本轮不是“整体无问题通过”。Deliver 轨道继续具备有人监督下的实际价值；Collaborate、Runtime Authority、Session Truth、原子 Run Admission、跨平台 Provider Launcher、完整历史与恢复语义仍未闭环。

## 2. 最终判断

### 2.1 当前代码增量

#### 用户整改 Head `5fa791e...`

- Core #430：成功；
- Root、CLI、Web、Chromium 与 Node 20.19/22.12/22.19/24 四腿：成功；
- CI #339：失败；
- 失败仅发生在 `pnpm audit --prod`，日志为 npm Security Audit Endpoint `ERR_SOCKET_TIMEOUT`，没有返回 Advisory 结果。

因此不能把该 Head 直接写成“全绿通过”，但失败性质应与应用回归、已知漏洞严格区分。

#### Reviewer 代码 Head `2073a0f...`

- Core #431：`completed/success`；
- CI #340：`completed/success`；
- Root build/typecheck：成功；
- Production dependency audit：`No known vulnerabilities found`；
- Node compatibility 四腿：全部成功；
- CLI build/unit/e2e：成功；
- Web build/typecheck/unit：成功；
- Chromium Playwright：成功。

因此，**本轮整改加 Reviewer 修复通过当前代码合并门**。

### 2.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.21.0 已形成测试覆盖较强、执行计划和风险边界较透明的实验性受控交付执行与观察基础设施；本轮进一步关闭了裸清理入口、Audit 误重试、公开 `planDigest` 断链和 Credential Health 阻塞。Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子且幂等的 Run Admission、跨平台 Provider Launcher、正式 Provider 凭据/代理/能力证据、可证明的 Shutdown/Restart、完整历史导出和生命周期安全清理仍未闭环。

仍不应描述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程并发安全的 Repo Runtime；
- 拥有 Crash-safe Durable Inbox、完整 Replay 和 Restart Resume 的 Session 平台；
- 当前 `engines` 中每个 Node Major 都经过持续支持验证的产品；
- DSH 在 Linux、Windows、真实模型、代理和所有凭据来源下均已兼容；
- 具备宿主级网络隔离，或已验证 DSH 内部 Tool Allow/Deny 的系统；
- 已完成任意规模长会话、安全物理清理和全站可访问性验收的产品。

## 3. 评审范围、方法与证据边界

本轮覆盖：

- `34a542f...` 到用户 `5fa791e...` 的全部代码与文档增量；
- Node Compatibility Workflow、YAML 合同测试及四档真实 Actions 结果；
- CommandGateway Abort、Timeout、No-progress、Progress Evidence 与 Subprocess Registry；
- README、CHANGELOG、用户手册、Current Review、第二十一轮报告及收口方案；
- 默认 Session Composer、Advanced StartRunForm、Responsive Run Surfaces、TopBar、Session List/Detail/Right Rail、历史与审批；
- Workflow Plan/Digest、Draft Approval、Provider/Mode Policy、`project.run`、`project.clean`；
- DSH Metadata Probe、正式 Run Env、Adapter、Provider Registry、L1/L2 与 Escape Hatch；
- SessionService、WorkflowEngine、Run Admission、RunPlan、Dual-write、JobRunner；
- CI Audit、Node Engines、Branch Protection、发布与供应链证据；
- #13–#33 的边界、依赖与是否存在流程/架构过度设计；
- DeepSeek Harness `0.1.3-alpha.1` Release、Headless、Session Persistence、ACP、Proxy 与 Safety；
- Node 官方当前 Release Status。

判断原则：

1. 只有具体 Head 的 `completed/success` 可以作为代码门证据；
2. Audit Endpoint 不可用、已发现 Advisory、应用测试失败是三种不同事实；
3. 页面 Disabled/Single-flight 不能替代服务端 Idempotency 和原子 Admission；
4. Capability Declaration、Provider Enforcement、Host Enforcement、Compatibility、Bypass、Acknowledgement、Credential/Proxy Source、Snapshot 与 Audit 必须分开；
5. 计划未请求能力不等于宿主已经隔离；
6. 选定 Node 边界通过不等于一个开放上界 Semver 的所有 Major 都受支持；
7. DSH 每 Session Lock 不等于 Tekon Repo-level Runtime Lock；
8. 自定义 Geometry Assertions 是 Layout Smoke，不是视觉、真实设备或辅助技术验收；
9. Issue、报告和测试数量不是产品成熟度；
10. 小而可逆的问题可以直接修，公共协议、迁移、恢复、发布支持和事务必须拆独立 PR。

本轮没有可访问的独立 Tekon 部署实例、Windows Runner、Firefox/WebKit、屏幕阅读器或真实 DSH L3 凭据环境。UI 判断基于源码、响应式 CSS、现有 Chromium Playwright 和用户已有的截图记录；本报告不声称完成新的像素级、真实设备或辅助技术走查。

**术语**：L2 = 带真实二进制的集成验证；L3 = 带真实凭据与模型调用的端到端验证；ACP = Agent Client Protocol（DSH 上游的会话协议）；Saga = 跨多个步骤的补偿式事务模式。

## 4. 对用户最新整改的逐项裁决

| 整改项                           | 裁决                 | 理由与边界                                                                                                                                     |
| -------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 20.19/22.12/22.19/24 Matrix | 基本关闭选定边界     | 四腿独立执行完整 Install/Build/Typecheck/Core/CLI Smoke，失败不会被排除或吞掉；不覆盖 23/25/26/Future Major，也不解决 Node 20 EOL 的支持策略。 |
| 固定 Corepack 0.34.1             | 合理                 | 解决 Node 22.12 自带旧 Corepack 无法验证 Pnpm 10 签名；仍是每腿网络安装，发布环境需保留依赖源可用性和完整性证据。                              |
| Workflow YAML 结构合同           | 有效但应停止继续扩张 | 能防止 `exclude`、`if`、`continue-on-error` 等静默绕过；不应演变为对每一行 Workflow 脚本的脆弱 Snapshot。                                      |
| Abort Listener 清理              | 关闭直接泄漏         | Settle 时移除 Listener，`once` 注册，并补注册后 Abort Recheck；共享 Signal 上的已完成命令不再积累 Listener。                                   |
| Spawn/Listener 窄竞态            | 关闭直接窗口         | Abort 发生在 Spawn 与 Listener 注册之间时，注册后重新检查并 Kill；不等于 Windows/SDK/未登记进程树已可证明终止。                                |
| CommandGateway 整体可维护性      | 仍部分完成           | 局部修复正确，但一个函数继续承载 Policy、Spawn、Redaction、Progress、Filesystem Sampler、Timeout、Cancel、Settle 与 Registry。                 |
| Production Audit                 | 本轮修复后通过       | Endpoint 瞬态失败有一次有界重试；第二次失败或 Advisory 仍红灯；功能诊断保持独立。                                                              |
| HTML 报告和 Closure Plan 镜像    | 收敛重复源           | 正式文档保留一个 Markdown 内容源和一个同步 HTML 人审版；不再复制额外 Closure Plan 或平行裁决源。                                                |

## 5. 本轮 Reviewer 直接修复

### 5.1 生产依赖 Audit 对 Endpoint 瞬态故障有界重试

用户 Head 的真实失败链是：

```text
pnpm install 成功
→ 所有功能测试和 Node Matrix 成功
→ pnpm audit 请求 npm Security Endpoint
→ 内部重试后 ERR_SOCKET_TIMEOUT
→ CI 红灯
```

这不是可以 Fail-open 的理由：Endpoint 不可用意味着无法证明当前依赖没有新 Advisory。但单次长连接故障也不应要求维护者人工重跑整个 Workflow。

当前实现：

```text
第一次 pnpm audit --prod
→ 成功：立即通过
→ 失败：等待 15 秒
→ 第二次 pnpm audit --prod
→ 成功：通过
→ 失败：明确错误并使 Job 失败
```

同时：

- Job Timeout 从 5 分钟调整为 12 分钟，容纳 Pnpm 自身网络重试和一次外层重试；
- 不使用 `continue-on-error`；
- 不根据错误文案猜测并放行；
- Audit 继续与功能测试并行，Registry 故障不会屏蔽应用诊断；
- CI #340 的 Audit 首次请求即返回 `No known vulnerabilities found`，完整 Workflow 成功。

这是一项基础可靠性修复，不代表 SBOM、Provenance、Dependency Review 和构建物签名已经完成。

> 注：本节描述的是 `2073a0f...` 时点的设计意图。对任何非零退出码都重试的实现缺口见 §17.2 第 1 条，已在 §18.1 由 `audit-production.mjs` 分类器修复。

### 5.2 未直接修改的公共 `onWarn` 语义

`runDshPreflight()` 的 Host/Version Bypass 会调用 `onWarn`。Cleanup Warning 已保护回调异常，而 Admission Warning 仍可能因日志回调抛错而失败。

当前生产通常使用 `console.warn`，没有观察到实际事故；但 API 语义不应模糊。#22 已要求二选一：

```text
纯观测 Sink：异常被吸收
```

或：

```text
显式 Policy Hook：结构化返回是否允许旁路
```

本轮没有在超大 PR 中悄然改变公共 API 行为。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道已经具备真实价值

当前成立的主路径是：

```text
需求输入或需求草案
→ 需求与计划批准
→ 服务端 RunPlan 和 Digest
→ standard-delivery 角色链
→ 隔离 Worktree
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

正向判断：

- 默认入口明确叫“启动受控交付”，没有伪装成普通聊天；
- Token、Plan、Digest、Draft/Plan Approval 或必要确认缺失时 Fail-closed；
- Workflow、Goal、Mock 和 DSH Headless 的产品边界较清楚；
- Mock 已明确为合成执行，不能作为真实交付完成证据；
- Dirty Base、远端副作用和 DSH 网络风险有显式披露；
- Session List/Detail、审批、运行控制和在线历史具备基础路径；
- Gate、Artifact、Audit、Readiness、Delivery 和 Worktree 已形成可监督工程流程；
- README 对非真实 Chunk Streaming、无 Follow-up、Best-effort Event Projection 和单 Workspace 等限制保持诚实。

因此，Tekon 已经不是只能依靠 Agent 自举的内部框架，而是工程用户可以监督使用的受控执行与证据工作台。

### 6.2 Collaborate 轨道仍未成立

普通用户仍不能在同一 Session 中完成：

```text
继续输入
→ Provider Execution-time Semantic Updates
→ Follow-up / Steer
→ Prompt-owned Cancel
→ Runtime 重启后恢复
→ 在同一上下文中升级为 Deliver
```

`LegacyAgentDriver` 仍是 One-shot 完成后投影；`followUp()`、`steer()`、`resume()` 仍未形成真实 Provider 闭环。当前 Session 的实际角色仍是：

- Run 观察面；
- 审批面；
- 治理证据面；
- 结果和历史投影面。

所以整体产品验收仍不能通过。

### 6.3 默认“人类入口”仍然偏重

默认 Composer 会启动完整 Standard Delivery 角色链。这比早期不可发现或 Agent-only 的入口进步明显，但仍不是低承诺的快速协作入口：

- 用户一次输入即触发 PM/RD/QA/Reviewer 治理链；
- 没有先进行轻量澄清再升级 Deliver 的产品路径；
- 运行前计划显示角色和 Gate，但成本、预计时间与 Provider 限制仍不是完整承诺；
- 用户不能在同一个上下文中调整方向。

在 Collaborate Vertical Slice 成立前，默认入口应继续明确“这是受控交付”，不要进一步伪装成聊天。

## 7. UI 实现与 UX 交互评审

### 7.1 已有改善

- 默认和高级入口均具备同步 Single-flight；
- Plan、Digest、Draft Approval 和 Network Acknowledgement 未准备时不能启动；
- 默认 Composer 可在 Plan 缺 Digest 或 Run 失败后原地重试；
- 320/390/700/1440px 有基础 Overflow/Layout Smoke；
- Session Right Rail 可用 Snapshot 兜底 Best-effort Event；
- 未知状态保持 Fail-closed；
- 历史有 Backward Cursor、Replay/Pending Budget、Heartbeat Backpressure 和 Truncation 提示；
- 顶栏 DSH 不可用状态具有辅助技术描述；
- 两个配置 Dialog 的焦点循环、Escape 和焦点恢复已有覆盖。

### 7.2 两套 Run UI 继续复制状态机

`SessionComposer` 与 `StartRunForm` 仍分别维护：

- Plan Query；
- Digest 检查；
- Admission 状态；
- Single-flight；
- Risk Disclosure；
- Mutation/Error/Retry；
- 成功跳转。

此前已发生网络表述、Single-flight 和重试能力漂移。后续只应抽取克制边界：

```text
RunAdmissionState
useRunSubmission
RunPlanDisclosure 数据模型
```

默认入口保持简单，高级入口保留高级参数；不要合并成巨型通用表单框架。

### 7.3 Credential Health 仍被可选 Provider 拖慢

`project.health` 在 Token 有效后同步探测 DSH Version/Config/Help。用户只想确认连接凭据，也可能等待可选 Provider 的多个外部命令。

正确结构仍是：

```text
快速 Credential Health
→ 独立结构化 Provider Health
→ Request-scoped Run Admission
→ 必要时 Execution-time Recheck
```

Provider 诊断也应区分 Not Installed、Host Node、Version、Config、Help、Timeout、Proxy/Environment 和 Probe Home，而不是只有 Available/Unavailable。

### 7.4 Responsive Geometry Scanner 已接近过度实现

当前测试能捕获页面横溢、关键控件越界和部分文本裁切，具有价值；但 400 余行自定义矩形、Canvas 文本测量和 Overlap 逻辑不能替代：

- 浏览器截图 Diff；
- Native Select 展开态；
- 字体与操作系统差异；
- 真实触控设备；
- 屏幕阅读器与焦点顺序。

后续只保留三类高价值不变量：

```text
页面无横向溢出
关键控件在视口内
核心状态可操作
```

不要继续编码更多 CSS 规则或自建视觉测试平台。

### 7.5 完整历史仍没有用户行动出口

Truncation 后只能继续分页，无法一键导出：

- 完整 Session；
- 子 Session；
- Artifact；
- Gate 与审批；
- Audit；
- 附件和完整性 Manifest。

完整导出同时服务恢复上下文、复盘、Bug Report、技术支持与审计，应由 #18 独立推进。

### 7.6 Admission 失败后仍无法判断是否安全重试

前端重试体验已改善，但服务端启动非原子。API 失败时，用户仍无法知道：

```text
完全没有创建任何内容
```

还是：

```text
已留下部分 Demand / Run / Plan / Audit / Session / Job
```

这会直接影响用户对“重试”按钮的信任。#31 必须提供 Idempotency Key、事务/Saga 和可诊断 Admission Status。

### 7.7 A11y 与真实设备证据仍有限

当前主要证据来自 Chromium、局部 ARIA 和自定义布局检查，不能外推为以下环境已通过：

- Firefox、WebKit；
- NVDA、JAWS、VoiceOver；
- 200%/400% Zoom；
- Forced Colors、Reduced Motion；
- 真实移动设备；
- 弱网、后台标签页和代理缓冲环境。

## 8. Runtime、数据与整体架构评审

### 8.1 P0：仍缺 Repo-level Single-owner Runtime

CLI 与 Web 仍可能分别拥有：

```text
SQLite / WriteQueue / Repositories
Session Store / EventBus
JobRunner / SubprocessRegistry
Workflow / Automation Executor
Git / Worktree / Provider
Shutdown 生命周期
```

Job Lease、CAS 和进程内 Generation Token 不能完整保护普通文件写入、Git Promotion、Artifact、Gate、Audit、Delivery 和外部 SDK 副作用。

长期方向仍应是：

```text
Repo-scoped Daemon/Service
→ Physical Repo Lock
→ CLI/Web 客户端化
→ 单一 Admission/Execution/Shutdown Authority
```

### 8.2 P0：Shutdown 仍不能证明 Quiescent

现有 Stop 已包含 Poll 停止、Active Poll 等待、Settle Window、AbortController、已登记子进程 Kill、Hard Deadline 和 DB Fence。

但 Deadline 返回后，不合作 Executor 仍可能继续：

- 执行 JavaScript；
- 写普通文件；
- 操作 Git；
- 留在外部 SDK；
- 持有未登记子进程。

完整闭环需要：

```text
Process/Worker Isolation
→ 真实 Kill/Join
→ Generation Fencing
→ Checkpoint/Flush
→ Crash/Restart/Late-write Fault Injection
```

CommandGateway 的 Listener 修复不能替代该主线。

### 8.3 P0：Session Event 仍是 Best-effort Projection

当前事实顺序仍是：

```text
领域表 / Audit 先成功
→ Best-effort Append Session Event
→ 找不到 Session 或追加失败时允许跳过
```

它适合作为 UI 投影，但不能承担：

- Durable Inbox；
- 权威模型历史；
- Prompt Claim/Processed；
- Crash Replay；
- Fork/Resume；
- Restart Recovery。

必须在 Authoritative Append-only Session Log 与“领域事实/Transactional Outbox 为权威、Session 可重建”之间作出明确选择。

### 8.4 P1：Run Admission 非原子且无服务端幂等键

启动横跨：

```text
Demand
→ Project
→ Run
→ Provider Snapshot
→ Execution Plan
→ Audit
→ Workspace
→ Session
→ Opening Events
→ Job
```

没有统一事务、Transactional Outbox 或显式 Admission Saga。组件 Single-flight 无法处理两个客户端、网络重试、刷新重发和中途持久化失败。

### 8.5 P1：RunPlan 仍不是执行与恢复唯一事实

尚未完整绑定：

- Demand Identity / Version / Body Hash；
- Mode；
- Base Revision；
- Workspace Physical Identity；
- Resolved Provider Executable / Config / Launcher；
- Credential / Capability / Proxy Evidence；
- Permission / Network Acknowledgement；
- Expected Artifacts；
- Executable Node Plan。

同时：

- `SessionServiceStartRunInput.planDigest` 顶层参数仍未接线；
- Project 与 Workspace 构成重复身份；
- Execute/Resume 继续从多个 Snapshot 和表行重新拼装事实。

### 8.6 P1：`project.clean` 曾是危险裸删除（本节为 `2073a0f...` 时点状态；裸删除已在本轮挂起，见 §18.1）

当前仍可直接删除：

```text
.tekon/runs/<runId>
```

没有与 Active Job、SubprocessRegistry、Worktree Lease、Automation、Audit/Tombstone 和数据库路径引用协调。

合并后优先级最高的小 PR 仍应是 #33：暂停物理删除并 Fail-closed。完整 Export、Retention 和 Lifecycle-safe Purge 由 #18 承担。

## 9. Node 支持、CI 与发布治理

### 9.1 四腿矩阵是真实进展

`2073a0f...` 时点的矩阵真实验证：

```text
Node 20.19.x   # 实际解析为 20.19.6，非精确 floor；订正见 §17.2 第 3 条
Node 22.12.x
Node 22.19.x
Node 24.x
```

每腿包含 Native Dependency Install、全包 Build/Typecheck、Core/CLI Unit 与构建后 CLI Smoke；`fail-fast: false`，没有 `exclude`、`if` 或 `continue-on-error`。

本轮收口后已改为精确 `20.19.0`、`22.12.0`、`22.19.0` 和滚动 `24.x`，见 §18.1；新 Head 的真实结果仍以 PR checks 为准。

这比只在 Node 24 跑主 CI 明显可靠。

### 9.2 但 `engines` 仍是开放上界

根合同：

```text
^20.19.0 || >=22.12.0
```

会接纳 23、25、26 和未来 Major。当前矩阵不覆盖它们。

截至 2026-09-04，Node 官方列出的状态为：

- 20、23、25：EOL；
- 22、24：LTS；
- 26：Current；
- 官方建议生产应用只使用 Active/Maintenance LTS。

因此需要区分：

```text
Semver 可安装
持续测试兼容
生产推荐支持
Legacy Compatibility
```

不建议在本 PR 中静默移除 Node 20；这属于兼容/发布决策。#24 已更新为明确支持策略、Required Checks 和发布证据问题。

### 9.3 Main 仍无强制门禁

`main` 未启用 Branch Protection/Required Checks。即使当前 Head 全绿，仓库规则仍不能阻止红色、未完成或 Head 已变化的 PR 被人工合并。

### 9.4 供应链仍只有基础门

Production Audit 已存在且本轮更加抗瞬态故障，但仍缺：

- Required Dependency Review；
- SBOM；
- Provenance/Attestation；
- Artifact Signing；
- Release Channel；
- 可追溯 Rollback。

## 10. 代码实现评审

### 10.1 正向判断

- Abort Listener 清理与注册后 Recheck 是正确、局部、可证明的修复；
- No-progress 两阶段 Watermark 继续避免一次边界采样误杀；
- Node Workflow 合同测试能阻止矩阵静默删腿；
- DSH Metadata Probe 使用隔离工作区、最小环境、顺序 Config/Help 和 Finally Cleanup；
- RunPlan Canonical JSON/Digest、Web Fail-closed 和 Snapshot 方向正确；
- Session/Workspace SSE 的 Cursor、Pending Cap 和 Heartbeat Backpressure 明显优于早期版本；
- Provider Pin + Help/Config Contract 优于绑定上游私有文件布局。

### 10.2 仍需避免的代码方向

1. 不要继续给 CommandGateway 添加更多内嵌 Timer/Watcher 特判；
2. 不要把 Geometry Scanner 扩展成自建布局/视觉引擎；
3. 不要给每条 CI Shell 逻辑都增加脆弱字符串 Snapshot；
4. 不要通过恢复整份 Ambient Env 来支持 DSH Proxy；
5. 不要将上游 Per-session Lock 当成 Tekon Repo-level Lock；
6. 不要继续新增与 Vertical Slice 无关的 Driver/Adapter Wrapper；
7. 不要让更多恢复路径依赖 Best-effort Session Event；
8. 不要用更多 Hard Timeout 代替 Process Isolation/Join；
9. 不要在 RunPlan 未成为唯一输入前继续增加 Preview-only 字段；
10. 不要在同一超大 PR 中同时实现 Daemon、Authoritative Log、ACP、Compaction 和 A11y。

## 11. DeepSeek Harness `0.1.3-alpha.1` 对齐结论

### 11.1 当前版本关系

```text
Tekon tested pin = 0.1.2-alpha.3
已完成 Linux Wrapped L2 = 0.1.2-rc.1
DeepSeek Harness latest = 0.1.3-alpha.1
Latest tag commit = d347e703908d0406b7a7ef80e3a0e594d86b2215
```

`0.1.2-rc.1...0.1.3-alpha.1` 跨越约 328 个提交，不应被视为无行为变化的版本提升。

### 11.2 Headless 仍保持 One-shot

官方 Headless 仍是：

```text
一个 Task / Invocation
→ Reasoning 写 stderr
→ 等待 Quiescence/Flush
→ 最终 Assistant 文本写 stdout
→ 退出
```

没有 Interactive Follow-up，因此 Tekon 继续把 `dsh-headless` 限制在 Goal/One-shot 是正确的。

### 11.3 SessionHandle 与单写者锁支持正确方向，但边界不同

0.1.3 将 Persistence 收敛到 lifecycle-owned `SessionHandle`，并保证同一 Session 至多一个进程写入。这为 ACP Persistent Session、Crash Recovery 和 Writer Ownership 提供了参考。

但它只保护 DSH Session Storage；不保护 Tekon 的 Git、Artifact、Gate、Audit、Delivery 和普通文件。#16 的 Repo-level Runtime Owner 仍不可省略。

### 11.4 代理支持需要显式接线

0.1.3 正式遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。Tekon Exact Run Env 当前不传这些变量：

- 默认隐私更安全；
- 企业代理环境不可用；
- 需要显式 Trusted Proxy Config、脱敏 Snapshot/Audit 和 Resume Recheck；
- Metadata Probe 默认继续无代理；
- 不允许恢复 `{...process.env}`。

相关要求已进入 #32。

### 11.5 已知性能回退阻止盲目追新

Release Note 明确指出部分历史 Session 加载可能出现性能回退。未来 ACP/Session Spike 必须带长历史基准、v1→v2 Migration 和 Lock 故障证据，不能只因 API 更先进就进入默认产品路径。

### 11.6 Pin 策略

近期 Headless 应先完成 rc.1 的 Windows L2 与 Credentialed L3，再决定是否从 alpha.3 升到 rc.1。0.1.3-alpha.1 更适合作为 #14 ACP/SessionHandle 技术 Spike，不应与 Headless Pin 升级捆绑。

### 11.7 Safety 边界未改变

官方仍明确说明 Harness 是未经安全审计的 Experimental Developer Preview；Sandbox、Approval 和 Permission Controls 只能降低风险，不能保证隔离，也不能成为不可信 Workload 的唯一安全控制。

## 12. 是否存在过度实现或过度设计

### 12.1 横向框架领先于纵向产品价值

当前已有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session Projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 Composition Root
默认 Composer + Advanced Run 两套 Admission UI
```

而最小 Collaborate 链路仍未完成。

在以下链路成立前，应冻结与其无直接关系的新 Profile、Automation Job、Driver Wrapper、展示 Event 和 Workflow DSL：

```text
暂停裸 project.clean
→ Request-scoped Provider Admission
→ Explicit Cross-platform Launcher
→ Credential/Capability/Proxy Evidence
→ Atomic/Idempotent Run Admission
→ Canonical RunPlan Authority
→ Single-owner Runtime
→ Authoritative Session
→ Persistent Provider Stream
→ Follow-up/Cancel/Resume
→ Collaborate → Deliver
→ Export/Compaction/Lifecycle-safe Retention
```

### 12.2 Node Matrix 的成本与支持承诺应匹配

四腿完整 Install/Build/Unit 是当前宽 Node 承诺下的合理成本，但若最终只正式支持 22/24 LTS，则应缩小矩阵；不要长期支付 EOL/未推荐版本的全部 CI 成本，同时又没有明确 Legacy Policy。

### 12.3 Responsive Test 不应继续平台化

当前 Smoke 已足够发现横溢和关键控件裁切。后续应使用少量截图 Diff、真实设备与 A11y 专项，而不是继续完善自定义几何算法。

### 12.4 正式 HTML 必须同步，但不再复制平行裁决源

PR 中已积累多轮 Markdown、HTML、Remediation Plan、Closure Plan 和权威索引。重复源会造成：

- Head/Run Evidence 过时；
- Markdown/HTML 结论漂移；
- Reviewer Process 淹没用户行为；
- 合并 Diff 难以审阅。

仓库规则要求正式人审文档提供 HTML，因此本报告与本轮方案均保留一个 Markdown 内容源和一个同步 HTML 人审版。收敛目标是不再生成额外 Closure Plan 或多份平行裁决源。后续普通问题只更新 Issue/独立 PR；不再创建下一轮大一统整改回填 PR #11。

### 12.5 PR 规模本身已成为质量风险

在用户 Head 时，PR 已有 167 Commits、216 Files 和超过 4 万行新增；继续增加会降低逐行审阅、二分、迁移验证和回滚质量。

最终应 Squash Merge，并把后续主线拆为独立小 PR。

## 13. 问题清单

| ID                      | 严重度 | 状态     | 问题                                                                                            |
| ----------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| P0-ARCH-01 / #16        | P0     | 未关闭   | CLI/Web 缺 Repo-level Single-owner Runtime Authority。                                          |
| P0-ARCH-02 / #15        | P0     | 部分完成 | Abort/Kill/Deadline/DB Fence 不保证 Executor、Git、普通文件与 SDK 已 Quiescent。                |
| P0-DATA-01 / #13        | P0     | 未关闭   | Session Event 是 Best-effort Projection，不是 Durable Inbox/权威模型历史。                      |
| P0-PRODUCT-01 / #14/#19 | P0     | 未关闭   | 真实 Streaming、Follow-up、Steer、Prompt Cancel、Restart Resume 与 Collaborate→Deliver 未闭环。 |
| P1-CLEAN-01 / #33       | P1     | 止损完成 | Web/CLI 裸删除已挂起；完整 Export、Retention 与 Lifecycle-safe Purge 仍未关闭。                  |
| P1-PROVIDER-01 / #29    | P1     | 部分完成 | Credential/Provider Health 已拆分；Codex/Claude 与完整 Request-scoped Admission 仍未关闭。       |
| P1-PROVIDER-02 / #28    | P1     | 未关闭   | Wrapper/Basename 与 Windows `.cmd` 可改变 Preflight/Launcher 语义。                             |
| P1-PROVIDER-03 / #32    | P1     | 未关闭   | 正式 DSH Credential、Trusted Proxy 与 Capability Evidence 未治理。                              |
| P1-ADMISSION-01 / #31   | P1     | 未关闭   | Run Admission 缺原子性、Idempotency 与失败补偿。                                                |
| P1-EXCEPTION-01 / #22   | P1     | 未关闭   | Network/Host/Version Acknowledgement、Warning、Snapshot 与 Audit 未原子绑定。                   |
| P1-PLAN-01 / #20        | P1     | 部分完成 | 顶层 digest 已透传并在副作用前校验；Canonical Snapshot 尚未成为 Admission/Execute/Resume 唯一事实。 |
| P1-HISTORY-01 / #18     | P1     | 部分完成 | 在线预算已有基础；Complete Export、Model Compaction、Retention/Purge 未闭环。                   |
| P1-NODE-01 / #24        | P1     | 部分完成 | 精确四腿合同已更新；新 Head 的远端四腿终态待 PR checks，公开 Range 仍接纳未验证/Future Major。   |
| P1-GOV-01 / #24         | P1     | 未关闭   | Main Required Checks、SBOM、Provenance、Signing 与 Release Channel 未完成。                     |
| P1-DSH-01 / #17         | P1     | 部分完成 | rc.1 Linux L2 完成；Windows/L3/Pin 未完成，0.1.3 Alpha 仅静态复核。                             |
| P1-A11Y-01 / #21        | P1     | 未关闭   | Chromium/Layout Smoke 不能替代全站 Screen Reader、多浏览器与真实设备验收。                      |
| P2-CODE-01 / #25        | P2     | 部分完成 | Abort Listener 修复；CommandGateway 状态机与职责仍未拆分。                                      |
| P2-CI-01                | P2     | 已关闭   | Audit 已按 JSON 结果和瞬态 transport 错误分类，只对明确瞬态故障有界重试。                        |
| P2-PROCESS-01           | P2     | 未关闭   | PR、报告镜像和测试工具规模过大。                                                                |

## 14. 建议实施顺序

1. **#18/#33：实现完整 Lifecycle-safe Purge**
   裸 `project.clean` 与 `tekon clean` 已 Fail-closed；下一步补 Complete Export、Retention、引用协调和可恢复清理。

2. **#24：明确 Node 生产支持策略并启用 Required Checks**  
   区分 LTS、Tested、Legacy；决定 Node 20 和开放上界；随后补 SBOM/Provenance/Signing。

3. **#29 + #28：Provider Admission 与跨平台 Launcher**  
   快速 Credential Health、结构化 Provider Health、Request-scoped Admission、Windows Shim/Wrapper Contract。

4. **#32 + #17：正式 DSH Credential/Proxy/Evidence 与 Headless Pin**  
   先完成 rc.1 Windows L2 和 Credentialed L3；0.1.3 只做必要的 ACP/Session Spike。

5. **#31 + #22 + #20：原子 Admission、Exception Facts 与 RunPlan Authority**  
   Idempotency Key、事务/Saga、Canonical Snapshot、Execute/Resume 验证。

6. **#16 + #15：Single-owner Runtime 与 Quiescent Restart**  
   Repo Lock、Daemon、Process Isolation、Kill/Join、Checkpoint/Fencing。

7. **#13 + #14 + #19：Authoritative Session 与持续协作**  
   Durable Inbox、真实 ACP Stream、Cancel/Resume、Collaborate→Deliver。

8. **#18 + #21 + #25 + #26：历史、A11y 与工程卫生**  
   Streamed Export、Compaction/Retention、全站 A11y、多浏览器、CommandGateway 拆分、Semantic Lint。

## 15. 合并、发布与证据边界

代码快照 `a843fc1...` 的本地代码门只能证明：

- 当前环境下 151 个测试文件、CLI 8 项真实进程 e2e、Chromium 51 项 Playwright、全包 typecheck/build 与 production audit 通过；
- workflow 已声明并校验精确 `20.19.0`、`22.12.0`、`22.19.0` 和滚动 `24.x`；新 Head 的真实四档 Actions 终态仍须由 PR 外部 checks 证明；
- CommandGateway Abort Listener 的直接生命周期和窄竞态已修；
- Audit 只对无有效结果的明确瞬态错误重试一次，且当前依赖真实返回 No Known Vulnerabilities；
- Chromium 当前主路径与 320/390/700/1440 四视口未被本轮工程改动击穿。

它不能证明：

- 当前开放 `engines` 范围内所有 Major 均被支持；
- 两个客户端或网络重试不会创建重复/半成品 Run；
- Web/CLI Multi-owner 不会产生 Git/文件副作用冲突；
- Shutdown 后所有 Executor/SDK/Git 活动都已终止；
- Session Event 可完整恢复模型历史；
- DSH rc.1/0.1.3 已通过带凭据真实模型调用；
- 企业代理、工作树 `.env` 与内部 Tool Enforcement 已治理；
- 完整历史、Model Compaction 和安全 Purge 已完成；
- Firefox/WebKit/屏幕阅读器/真实设备已经验收。

PR #11 已远超适合继续增长的规模。最终建议 Squash Merge，后续所有主问题使用独立小 PR。本轮未执行 Merge、Release、Deploy 或仓库 Ruleset 修改。

## 16. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第二十一轮报告](2026-09-03-tekon-product-runtime-harness-twenty-first-review.md)
- [README](../../README.md)
- [CI Workflow](../../.github/workflows/ci.yml)
- [Node Workflow Contract](../../packages/core/__tests__/ci/github-workflows.test.ts)
- [CommandGateway](../../packages/core/src/runtime/command-gateway.ts)
- [DSH Metadata Preflight](../../packages/core/src/runtime/dsh-bridge-probe.ts)
- [DSH Headless Adapter](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [Provider Registry](../../packages/core/src/runtime/provider-registry.ts)
- [SessionService](../../packages/core/src/session/session-service.ts)
- [Project Router](../../packages/web/src/server/api/routers/project.ts)
- [RunPlan](../../packages/core/src/workflow/run-plan.ts)
- [主线 Tracking #27](https://github.com/zesming/tekon/issues/27)
- [DSH 版本验证 #17](https://github.com/zesming/tekon/issues/17)
- [ACP Vertical Slice #14](https://github.com/zesming/tekon/issues/14)
- [Provider Exception #22](https://github.com/zesming/tekon/issues/22)
- [Node/Release Governance #24](https://github.com/zesming/tekon/issues/24)
- [CommandGateway #25](https://github.com/zesming/tekon/issues/25)
- [DSH Environment/Proxy #32](https://github.com/zesming/tekon/issues/32)
- [Clean Guard #33](https://github.com/zesming/tekon/issues/33)

### DeepSeek Harness 官方

- [0.1.3-alpha.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)
- [0.1.3-alpha.1 Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/README.md)
- [0.1.3-alpha.1 Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/session/session-persistence-jsonl/README.md)
- [0.1.3-alpha.1 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/acp/acp/README.md)
- [0.1.3-alpha.1 Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/SAFETY.md)
- [0.1.3-alpha.1 Node Engines](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/package.json)

### Node 官方

- [Node.js Releases](https://nodejs.org/en/about/previous-releases)

## 17. 实施方视角批注与三路交叉评估（2026-09-04）

> 本节保留上文原始报告，追加独立复核结论；若与上文冲突，以本节标明的“订正”及后续实施证据为准。方法：将官方 `deepseek-harness` 同步到 release tag `dsh-v0.1.3-alpha.1`（commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`），再由两个只读 explorer 分别核对报告事实和 DSH 合同，由一个最高思考等级 reviewer 独立检查 PR 增量、CI、测试与文档。以下区分事实、推断和建议，不把尚未实施的事项写成完成。

### 17.1 已达成一致的判断

1. **同意保持 DSH tested pin，不盲目追新。**
   - **事实**：`0.1.2-rc.1...0.1.3-alpha.1` 跨越约 328 个提交；Headless 仍是一项任务一次 invocation，reasoning 写入 stderr、最终文本写入 stdout，且没有 interactive follow-up。官方 0.1.3 同时引入 lifecycle-owned `SessionHandle`、Session 单写者租约、v2 格式和已知历史加载性能回退。
   - **证据**：[0.1.3-alpha.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)、[Headless startup](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/src/startup.ts)、[Session persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/session/session-persistence-jsonl/README.md)。Tekon 的 pin 位于 `packages/core/src/runtime/dsh-bridge-probe.ts`，正式 run exact-env 位于 `packages/core/src/runtime/dsh-headless-adapter.ts`。
   - **判断**：DSH 每 Session 锁只保护其 JSONL 持久化，不保护 Tekon 的 Git、Worktree、Artifact、Gate、Audit、Delivery 或普通文件；它不能替代 #16。当前 pin 维持 `0.1.2-alpha.3`，rc.1 Windows L2 和 credentialed L3 仍由 #17 处理，0.1.3 仅进入 #14 ACP/SessionHandle spike。

2. **同意 P0 主链仍是发布阻断项，但不同意继续塞入 PR #11。**
   - **事实**：Web 与 CLI 仍有各自的数据库、JobRunner 和 Runtime composition root；Session dual-write 仍允许投影失败；Headless 仍是 one-shot。
   - **判断**：#13/#14/#15/#16/#19 是“稳定持续协作工作台”的发布 blocker，不是本轮局部增量的 merge blocker。把 daemon、worker isolation、durable inbox 和 ACP 一次性塞入当前超大 PR，会降低可审阅性和回滚质量。

3. **同意先关闭纵向、可证明的合同缺口。**
   - **事实**：Web `project.clean` 与 CLI `tekon clean` 均可直接递归删除；`SessionServiceStartRunInput.planDigest` 被声明但未进入 `prepareRun`；`project.health` 在凭据有效后同步等待可选 DSH preflight。
   - **判断**：#33、#20 的公开合同断链、#29 的 credential-health 阻塞面适合本轮做成小切片；#29 只能标为部分关闭，不能外推为 Codex/Claude capability admission 已完成。

### 17.2 必须订正的四项

1. **Audit 重试不是当前声称的 fail-closed。**
   - **事实**：`.github/workflows/ci.yml` 当前对 `pnpm audit --prod` 的任何非零退出码都重试，包括已经返回有效 Advisory 的情况。若第一次发现漏洞、第二次结果异常返回 0，Job 会误放行。现有 CI #340 首次成功，未覆盖该分支。
   - **订正**：§5.1 中“漏洞仍硬失败”的设计意图正确，但现有实现和测试不足以证明。它是本轮 merge blocker：只允许可分类的 transport/timeout/5xx 重试；有效 Advisory 和未知错误立即 fail-closed。

2. **第二十二轮 Markdown-only 违反仓库正式文档规则。**
   - **事实**：`AGENTS.md` 要求人类审阅的正式文档提供 HTML，修改正式源稿时同步 HTML。
   - **订正**：§12.4 应理解为“不再复制不必要的 Closure Plan/多份裁决源”，不能取消同一正式文档的 HTML 人审呈现。本报告和整改方案都必须交付同步 HTML。

3. **`20.19.x` 不等于精确验证 `20.19.0`。**
   - **事实**：Node matrix 的 `20.19.x` 在 CI #341 实际解析为 `20.19.6`；合同测试只比较 major.minor，会对未运行精确 floor 假通过。
   - **订正**：在精确 `20.19.0` 通过前，§4/§9/§15 只能证明“20.19 minor 最新 patch”，不能证明 `engines` 的精确最低 patch。执行方案将矩阵改为精确 `20.19.0`、`22.12.0`、`22.19.0`，24 继续跟踪当前 24.x LTS，并让测试核对完整版本字符串。

4. **正式报告不能在仓内自引用尚不存在的最终文档 HEAD。**
   - **事实**：报告记录的代码 snapshot `2073a0f` 有对应 Core #431/CI #340；包含报告本身的 `e69b938` 则由 Core #432/CI #341 验证。任何再次修改报告都会产生新 HEAD。
   - **订正**：仓内报告绑定“被评审代码 snapshot + 对应 checks”；文档最终 commit 与 checks 通过 PR #11 的外部状态验证，不在同一提交正文中制造不可满足的自引用。每次代码 snapshot 改变仍必须重新绑定其 checks。

### 17.3 本轮执行裁决

本轮在同一 PR 中实施以下范围，并在代码前先完成方案评审：

1. 修复 Audit 分类重试及其真实分支测试；
2. 精确验证 Node 20.19.0、22.12.0、22.19.0，保留 24.x，并强化 Workflow 合同测试；
3. 暂停 Web `project.clean` 与 CLI `tekon clean` 的全部物理删除；Web 只在 token、confirm、runId 格式和 scope 均有效后记录不含秘密的拒绝 Audit，Audit 写失败也绝不删除；
4. 将顶层 `planDigest` 透传给 `WorkflowEngine.prepareRun`，用单元测试锁定公开合同；
5. 让 `project.health` 只做快速凭据判断，新增独立、受认证的 `project.providerHealth` 供 TopBar 异步查询 DSH 状态；不恢复 ambient proxy，不声称关闭 #29 全部问题；
6. 补齐本报告与实施方案 HTML，更新 current、README、CHANGELOG 和用户手册 Markdown/HTML；行为变更按规则将根包与所有子包 lockstep 升至 `0.21.0`。

本轮明确不做：修改 Node `engines` 范围、升级 DSH pin、引入 trusted proxy、修改 GitHub Ruleset、实现 daemon/outbox/ACP、扩张 Geometry Scanner。前四项需要独立产品/发布决策或外部权限；后两项超出当前 PR 可安全验证的纵向切片。

## 18. 收口实施结果与最终复审

### 18.1 代码快照与六项结果

本节评审的代码快照是 `a843fc100037adce6fd1a86f6d9097ce95dd32fd`，版本为 `0.21.0`。包含本报告的文档提交与最终 GitHub Actions 由 PR #11 的外部 Head/checks 证明，不在仓内制造自引用。

| 收口项 | 当前结果 | 仍保持开放的边界 |
| --- | --- | --- |
| Production Audit | 新脚本解析 pnpm JSON；有效 Advisory、零漏洞 JSON 但非零退出、未知结构/错误均立即失败；只有没有有效结果时的明确 timeout、DNS/connect、HTTP 5xx 重试一次 | 新的 transport 错误类别只有在取得事实证据后才扩充 |
| Node matrix | 精确 `20.19.0`、`22.12.0`、`22.19.0`，加滚动 `24.x`；setup-node 后断言实际解析版本 | 新 Head 四腿 Actions 尚须外部 checks；公开 `engines` 上界与 EOL 策略仍属 #24 |
| Clean guard | Web/CLI 物理删除均已挂起；合法 Web 请求写脱敏拒绝 Audit 后返回 409，Audit 写失败固定返回 500；文件和其他领域事实不变 | #18/#33 的 Export、Retention、引用协调和 Lifecycle-safe Purge 未实现 |
| `planDigest` | workflow/goal 均透传；input/options/canonical digest 在目录、DB、Audit 副作用前重新计算并校验 | 独立 `planSnapshot` 绑定及完整 Admission/Execute/Resume 权威仍属 #20 |
| Health 分层 | Credential Health 不再 spawn/wait DSH；Provider Health 独立认证、SHA-256 token key、60 秒 TTL、128 项上限和 single-flight；TopBar token 轮换使用不碰撞的有界 opaque scope | Codex/Claude admission、跨平台 launcher、结构化 capability snapshot 仍属 #28/#29 |
| 文档与版本 | 根包及 Core/CLI/Web lockstep 为 `0.21.0`；README、CHANGELOG、用户手册、技术文档、报告和方案 MD/HTML 同步 | 不再新增平行 Closure Plan 或下一轮大一统报告 |

### 18.2 本地验证证据

- `pnpm test`：151 个测试文件，1614 passed、1 skipped。唯一 skip 是未设置 `DSH_CLI_PATH` 的 opt-in DSH L2 live probe；L1 fixture 合同仍通过。
- `pnpm -r typecheck`：Core、CLI、Web 全部通过。
- `pnpm -r build`：Core、CLI、Web 全部通过。
- `pnpm --filter @tekon/cli test:e2e`：3 个文件、8/8，通过真实构建后二进制；`clean` 失败后 worktree 内容保留，`status`/`log` 仍可用。
- `pnpm --filter @tekon/web test:e2e`：Chromium 51/51，最终完整运行无 retry/flake。新增 TopBar 用例覆盖 credential 先返回、provider 延迟/500、token scope 轮换。
- `node scripts/ci/audit-production.mjs`：真实 registry 调用首次返回 `No known vulnerabilities found`。
- PR 中间 Head `9fe3659...` 的 Core run `33889063233` 被 Actionlint `SC2016` 拦截：Node 断言的单引号 shell 脚本含 `${...}`。代码快照 `a843fc1...` 已改为 step env 传值和无插值字符串拼接；合同测试先红后 4/4，通过代码/测试复审。最终远端结果仍以后续 Head checks 为准。
- 320/390/700/1440 截图：四档均有 `scrollWidth === clientWidth`；人工目视未见错位、重叠、横向溢出、裁切或状态展示错误。临时截图不归档，验收结论保留在本报告。
- `git diff --check`：通过；变更文件存在且非空，正式文档未保留占位标记。

### 18.3 独立复审循环

1. 执行方案先后经过三轮最高思考等级技术评审，最终 `hasMustFix=false`。
2. 测试质量复审先发现客户端 auth scope 碰撞、Audit 真实入口、Clean 不变量、TopBar Playwright、Node 精确断言和 digest 假覆盖等问题；修复后又在真实包 cwd、全套 Playwright 与合法未知 JSON 等分支发现缺口。全部修复后，最终复查 `hasMustFix=false`；TopBar route 场景另以 `CI=1 --repeat-each=3` 验证 12/12、零 flaky。
3. 代码/安全复审未发现 Audit fail-open、Node matrix 绕过、物理删除残留、Provider 未认证读缓存/启动 probe，或 digest 校验后产生 admission 副作用的确认缺陷。唯一 must-fix 是权威文档仍保留旧版本/旧 clean 结论，本节和 `current.md` 已完成回填，随后再次送审。

### 18.4 残余风险与最终裁决

- Provider server cache 从 probe 完成时计算 60 秒，而客户端按固定 60 秒刷新；边界时序下第一次刷新可能仍命中旧缓存，UI 最坏接近 120 秒才重新探测。真实 Run 始终独立执行 admission preflight，因此不是安全绕过；后续建议按返回的 `checkedAt` 安排刷新。
- `planSnapshot` 仍可独立注入而未与 canonical digest 绑定，这是完整 #20 authority 的已知开放项，不由本轮局部透传切片外推关闭。
- 新 Head 的 Node 四腿和最终文档提交只有 GitHub Actions 终态可以证明；本地合同测试不替代远端 runner。
- Chromium、四视口截图和局部对话框键盘测试不替代 Firefox/WebKit、真实设备、屏幕阅读器和全站 A11y 验收。

因此，**第 22 轮定义的六项局部收口切片通过本地代码门与独立复审，可以进入 PR CI；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”整体产品验收。** P0 架构主链和完整 #18/#20/#24/#28/#29/#31/#32/#33 边界保持开放。
