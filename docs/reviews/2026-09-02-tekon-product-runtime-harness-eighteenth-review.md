# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十八轮全面复审

- **日期**：2026-09-02
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`1bc0cc5d5bfad72e617ff263e321df8bb5fc86b9`
- **用户本轮整改 Head**：`9daa912128a4d7407eb1eb95aecb4bf31f8b6a09`
- **本轮产品行为代码修改**：无；用户只追加评审批注并修正一处注释，本轮 reviewer 只收敛报告和 issue 合同
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前最新发布**：`0.1.2-alpha.4`
- **用户整改自动化**：`9daa912...` 的 Core #408 与 CI #317 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **最终裁决**：当前增量通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

用户本轮增量只有两项：

1. 向第十七轮报告追加两路评估批注，确认 #28 Provider command、#29 Provider health、#31 Run admission 三个问题成立；
2. 修正 `dsh-headless-adapter.ts` 的一段注释，明确 launcher arg 白名单始终执行，但 execution-time preflight 仍受 executable basename 推断影响。

这两项修正均准确，没有产品行为变化。对应 Head 的 Core/CI 首次执行全部成功。因此，本轮增量本身可以通过代码合并门。

重新从完整仓库反向审查后，发现三个此前没有充分写入权威问题清单的合同缺口：

1. **P1-PROVIDER-EXCEPTION：Core 默认 DSH 配置自行设置“不受限网络已确认”**。`dshHeadlessProviderConfig()` 直接返回 `acknowledgeUnrestrictedNetwork: true`。Web/CLI 已知入口有额外前置确认，但 Core 默认工厂和未来调用方不需要提供本次确认事实，也能构造 Adapter 并持久化 ack=true。能力声明与人类确认被混成了一个默认值。
2. **P1-PLAN-01：`SessionServiceStartRunInput.planDigest` 是静默失效的公共参数**。接口注释声称该参数会绑定 canonical plan，但 `startRun()` 从未读取或转发它。当前主入口之所以工作，是因为相同 digest 又被塞入不透明的 `engine` input。公共 API 有两条表面数据通道，其中一条实际无效。
3. **P1-UX-PROVIDER：CLI preflight 通过外层可变 `activeAgent` 传递本次 Provider**。`SessionService` 先构造 Engine，再调用一个不接收 input 的 `preflight()`；CLI composition root 把本次 agent 写入外层变量供 preflight 读取。单次 CLI 命令通常串行，因此主路径暂未暴露，但并发/重入时存在串用 Provider 的结构性风险，也复现了此前 Web 已修复的 request-scope mutable-slot 模式。

此外，重新审查 RunPlan 和数据模型后确认：`WorkflowEngine.prepareRun()` 每次 Run 都创建一个固定名为 `tekon` 的新 Project，而 Session 层按物理 repo 复用 Workspace。同一仓库存在“每 Run 一个 Project + 每 repo 一个 Workspace”两套身份模型，增加了 RunPlan physical identity、overview、迁移和 single-owner lock 的语义成本。

本轮没有继续修改产品代码。原因不是问题不真实，而是上述问题需要和 #22 Provider exception、#29 Provider admission、#20 RunPlan authority、#31 原子 Run admission 一起处理。直接把 DSH 默认 ack 改为 false，或只把一个 digest 字段接上线，会涉及公共 Core API、旧 Provider snapshot、resume 兼容、Audit 证据和失败补偿；在 140+ commit、190+ file 的 PR #11 中零散修改，反而会制造新的部分闭环。

本轮直接完成的是：

- 扩充 #22，使其覆盖默认网络自确认、Snapshot/Audit 与旧 Run 的兼容策略；
- 扩充 #29，使 Provider preflight 成为 request-scoped，并删除 CLI `activeAgent` 可变槽；
- 扩充 #20，使其覆盖失效 `planDigest` 参数、执行事实同构和 Project/Workspace 身份模型；
- 生成本报告并更新稳定权威入口与 PR 描述。

产品主裁决不变：Deliver 已具备工程使用价值；Collaborate、single-owner Runtime、权威 Session、原子 admission、可证明的 shutdown/restart、RunPlan 执行权威与完整历史/模型上下文预算仍未闭环。

## 2. 评审范围与方法

本轮覆盖：

- PR #11 当前 Head、上一轮之后的完整 diff、Actions 终态；
- README、用户手册、CHANGELOG、`docs/reviews/current.md`、第十七轮报告及其最新批注；
- Core：WorkflowEngine、SessionService、RunPlan、Provider Registry、AgentRuntime、Codex/Claude/DSH Adapter、JobRunner、dual-write、CommandGateway；
- CLI：run、Session composition root、Provider preflight、resume/cancel；
- Web：默认 Composer、高级 run、project health/run、TopBar、Session right rail、SSE 与历史窗口；
- #13–#31 的问题边界、依赖和重复/过度拆分风险；
- DeepSeek Harness `0.1.2-alpha.4` 的官方 release、Headless、ACP、base composition 与 Safety；
- 产品逻辑、UI/UX、架构、实现质量、测试可信度和过度设计。

判断原则：

1. `completed/success` 必须绑定具体 commit，不能用上一 Head 的绿色结果替代；
2. capability declaration、human acknowledgement、admission、snapshot、Audit 与 Host enforcement 是不同事实；
3. 类型和注释承诺的公共参数必须真实参与数据流，静默忽略比显式删除更危险；
4. preflight 必须由本次 request input 决定，不能依赖 process/global/context mutable slot；
5. Run 创建必须同时审查 Demand、Project、Plan、Provider、Audit、Session、Events 与 Job 的一致性；
6. UI projection 的防御性 fallback 不会把 best-effort Event 变成权威事实源；
7. “顺手修改”只适用于小、可逆、可独立证明的改动；公共协议、迁移和恢复语义必须独立 PR；
8. issue 数量、报告轮数和项目管理元数据不是产品进展。

本轮没有可访问的独立 Tekon 部署、真实 dsh alpha.3/alpha.4 二进制与 API key，也没有 Firefox/WebKit 或屏幕阅读器环境。UI 结论来自源码、ARIA 结构、响应式实现和现有 Chromium Playwright；不声称完成新的像素级视觉或辅助技术实测。

## 3. 最终判断

### 3.1 当前增量代码门

用户 Head `9daa912128a4d7407eb1eb95aecb4bf31f8b6a09`：

- Core #408：`completed/success`；
- CI #317：`completed/success`；
- Root build/typecheck：success；
- production dependency audit：success；
- CLI build/unit/e2e：success；
- Web build/typecheck/unit：success；
- Chromium Playwright：success。

因此，**本轮用户整改通过当前代码合并门**。

### 3.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider 确认事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

仍不应表述为：

- 面向普通用户的稳定多轮研发协作工作台；
- Web/CLI 多进程共享仓库时具有完整副作用 fencing 的 Runtime；
- Run 创建要么完全成功、要么完全无痕的原子任务系统；
- 任何 Core 调用路径都强制获得了本次不受限网络的人类确认；
- 能从 `session_events` 完整恢复模型上下文的 durable Session 平台；
- canonical RunPlan 已是 admission/execute/resume 的唯一事实；
- 已验证 DeepSeek Harness alpha.4 或完成真实 Provider L3 smoke；
- `network: restricted/disabled` 等价于 Host/container 级断网；
- 已完成全站 screen reader、多浏览器、缩放与真实弱网验收。

## 4. 对用户最新整改的逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| 第十七轮两路评估批注 | 通过 | 对 #28/#29/#31、CI 和流程边界的判断基本准确，没有把 issue 登记误写成问题关闭。 |
| DSH Adapter 注释修正 | 通过 | 准确区分“arg 白名单始终执行”和“capability preflight 仍依赖 basename”；没有改变运行行为。 |
| #28 Provider command | 继续成立 | DSH wrapper 可跳过二次 preflight，Codex wrapper 还会改变 safe args、Profile、sandbox 与 artifact framing。 |
| #29 Provider health/admission | 继续成立并扩大 | 除 health 耦合外，CLI `activeAgent` mutable slot 和 preflight 顺序也应纳入。 |
| #31 原子 Run admission | 继续成立 | 最新批注没有改变 `prepareRun → Session → Events → Job` 的非事务顺序。 |
| 本轮“无产品代码修改” | 合理 | 新确认项涉及公共 API、snapshot/resume、Audit、事务或迁移；不适合继续塞入当前超大 PR。 |

## 5. 本轮新增或扩大的问题

### 5.1 P1-PROVIDER-EXCEPTION：默认配置代替用户确认不受限网络

#### 事实

`dshHeadlessProviderConfig()` 当前同时声明：

```ts
acknowledgeUnrestrictedNetwork: true
permissionProfile.network: 'enabled'
```

Provider Registry 使用该配置作为默认值，再应用 runtime override。`assertAgentProviderCapabilities()` 只检查 ack 是否为 true。因此直接使用 Core 高层工厂、不提供本次 acknowledgement，也可以构造 dsh-headless Adapter。

现有 Web/CLI 主入口另有前置检查，所以这不是已知 UI 的直接点击绕过；问题在于 Core 公共能力边界和未来调用方：

```text
Provider 能力声明
= 默认需要不受限网络

人类确认事实
= 本次调用者明确同意
```

两者不应由同一个默认配置布尔值同时表达。

#### 组合风险

网络 Audit 由 `SessionService.onPrepared` 写入，但 `WorkflowEngine.prepareRun()` 已经在此前持久化 Run、Provider snapshot、Plan 和 `run.started` Audit。若 hook 失败，可能留下：

```text
Provider snapshot: ack=true
Audit: 无 run.network-acknowledged
Session/Job: 无
```

恢复路径又从 Provider snapshot 重建 Adapter。这使默认自确认、非原子 admission 和 resume 形成组合风险。

#### 裁决

已将 #22 扩展为完整 Provider exception admission：

- 默认 Provider config 不得自行产生人类确认；
- acknowledgement 必须来自本次 Web/CLI/API input；
- capability、compatibility、bypass、ack source/time/surface 分字段保存；
- RunPlan、Provider snapshot 和 Audit 必须原子一致；
- 旧 ack-only snapshot 必须 fail-closed、隔离或明确迁移。

本轮不直接把默认值改为 false，因为那会改变公开 Core factory、既有测试和旧 snapshot/resume 语义；必须与 #31/#20 一起用独立 PR 完成。

### 5.2 P1-PLAN-01：公共 `planDigest` 参数静默失效

`SessionServiceStartRunInput` 暴露：

```ts
planDigest?: string
```

注释称其用于 canonical plan audit binding。但 `SessionService.startRun()` 没有读取或转发这个字段。

当前 Web/CLI 主入口同时将 digest 放在：

```text
SessionService 顶层 planDigest
+ opaque engine input.planDigest
```

真正进入 `WorkflowEngine` 的是后者。直接 Core 调用者只传顶层字段会被静默忽略。

影响：

- 公共 API 与真实实现不一致；
- 两个 digest 来源可能漂移；
- 类型不能证明 preview、validation、persistence 与 execution 使用同一计划；
- 未来维护者可能修一条路径而漏掉另一条。

只把顶层 digest 机械转发也不够，因为它可能覆盖一个不同 canonicalPlan 的 digest，继续制造不一致。#20 应统一为单一 `RunAdmission/RunPlan` 参数源，并由持久化层验证 snapshot、digest、ExecutionPlan 和 Provider config 同构。

### 5.3 P1-UX-PROVIDER：CLI preflight 依赖隐藏可变状态

CLI composition root 当前使用：

```text
createEngine(input)
→ activeAgent = input.agent
→ SessionService 调用 deps.preflight()
→ preflight 读取 activeAgent
```

同时 `SessionService.startRun()` 的顺序是先 `createEngine()`，后 `preflight()`。

单个 CLI 命令通常不会并发调用，因此当前风险不是高频事故；但公共结构存在：

- preflight 无法从签名证明对应本次 input；
- 同 context 并发/重入可覆盖 `activeAgent`；
- Provider 判定依赖外层 mutable slot；
- 已知环境错误在 Adapter 构造之后才检查；
- Web 和 CLI 又形成不同的 admission 编排。

#29 已增加 request-scoped 验收：`preflight(input.engine)` 或等价 capability snapshot，删除 `activeAgent`，并在 Engine/Adapter 和持久化之前执行。

### 5.4 P2-DOMAIN：Project 与 Workspace 双重身份模型

`WorkflowEngine.prepareRun()` 每次启动都会创建：

```text
Project(id=random, name='tekon', repoPath=当前 repo)
```

Session 层则使用：

```text
getOrCreateDefaultWorkspace(projectRoot)
```

所以同一物理仓库拥有两种不同生命周期的容器身份：

- Project：每 Run 新建；
- Workspace：每 repo 复用。

如果 Project 只是 immutable admission snapshot，应明确命名和语义；如果它代表用户项目，则每 Run 新建是错误模型。该重复抽象会增加 overview、权限、RunPlan identity、迁移、历史导出和 daemon repo lock 的复杂度。

此项已并入 #20，不再创建新的独立 issue，避免问题过度碎片化。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道已经基本成立

当前默认 Web/CLI 路径的真实产品合同是：

```text
需求输入
→ 服务端 RunPlan / digest
→ standard-delivery 角色链
→ 隔离 worktree
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

成立的部分：

- 默认按钮明确为“启动受控交付”，不再伪装为轻量聊天；
- 计划、digest、token 或必要确认缺失时 fail-closed；
- dirty base、网络例外与远端副作用有明确确认；
- Goal 与 Workflow/Deliver 边界较清楚；
- dsh-headless 保持 Goal-only，不被包装成完整交付 Provider；
- Session 列表、详情、审批、控制和在线历史已有基本可用路径；
- README 对真实 streaming、follow-up、Event projection 与 Workspace 限制已有披露。

因此 Tekon 已经是一套面向工程用户的受控任务执行和证据工作台，不应再评价为“只能由 Agent 自举、人完全无法使用”。

### 6.2 Collaborate 轨道仍未成立

用户仍不能在同一 Session 中完成：

```text
继续输入
→ Provider execution-time semantic updates
→ follow-up / steer
→ prompt-owned cancel
→ 浏览器刷新与 Runtime 重启后恢复
→ 在同一上下文中升级为 Deliver
```

`LegacyAgentDriver.events()` 仍等待 one-shot Adapter 完成后才遍历缓存；`followUp()`、`steer()` 和 `resume()` 仍抛 `NotSupportedYet`。这意味着 Session 的真实角色仍是 Run 观察、审批和治理证据面，而不是持续协作工作台。

### 6.3 Admission 失败不是用户可理解的产品状态

由于 #31 的非原子启动，用户看到“启动失败”时无法判断：

- 什么都没有创建；
- Run 已创建但未入队；
- Session 已创建但 opening events 不完整；
- 是否可以安全重试；
- 是否会出现重复 Run。

稳定产品必须把 admission 与 execution failure 分开，并提供明确状态：

```text
validating
→ admitting
→ queued
```

失败要么完全无可见对象，要么进入明确 `admission-failed`，可以清理、重试和审计。

## 7. UI 实现与 UX 交互评审

### 7.1 已经改善的部分

- Composer 在计划读取失败时提供重试，并禁止盲目启动；
- 执行前展示角色链、控制点、人工确认和网络声明；
- Session right rail 可用 Session snapshot 兜底 Event 缺失；
- Gate repository 决定真实 pending decisions；
- 未知状态 fail-closed，不再伪装成 running；
- 在线历史具备 backward cursor、replay/pending budget 和 truncation 提示；
- 顶栏 dsh 不可用状态同时对视觉用户和辅助技术可见；
- 两个配置详情 Dialog 已有 Esc、焦点循环、焦点恢复和背景 inert；
- 当前 Chromium Playwright 主路径通过。

### 7.2 仍未关闭的 UX 缺口

1. **Credential 与 Provider 健康仍混在一个顶栏状态**  
   token 已有效时，可选 dsh metadata probe 仍可能拖慢“连接有效”的反馈。应拆成快速凭据状态和独立 Provider capability 状态。

2. **Provider 故障诊断过于二值**  
   当前 UI 只显示 available/unavailable，详细原因需要手工执行 CLI。未来 Provider 设置页应展示结构化 failure kind、checkedAt 和行动建议。

3. **完整历史没有直接出口**  
   截断后可以分页，但没有“导出完整 Session/证据包”的一键入口，无法方便地支持复盘、技术支持、审批留档和 bug report。

4. **Admission 失败缺少恢复说明**  
   因非原子启动，前端错误无法诚实告诉用户是否已经留下 Run。#31 完成前不应用“请重试”掩盖未知状态。

5. **UI 历史预算不等于模型上下文预算**  
   DOM 和浏览器内存有界，不代表 Provider prompt 有 summary、compaction、token budget、fork/resume 和 retention policy。

6. **默认路径仍暴露过多工程概念**  
   Session、Run、Gate、Artifact、Profile、Provider 和 Token 对工程用户尚可接受，对普通用户仍缺任务语言映射和渐进披露。

7. **全站可访问性和跨浏览器证据不足**  
   当前不能从局部 ARIA 与 Chromium 自动化推导 NVDA/JAWS/VoiceOver、Firefox/WebKit、200%/400% 缩放、forced-colors、reduced-motion 和真实弱网已通过。

8. **缺少视觉回归矩阵**  
   极长标题、多审批卡、长 Artifact、历史截断、Provider 故障和窄屏组合仍主要依赖人工发现。

当前最适合作为独立 UX 小项目的仍是完整历史导出；它不依赖完整 Collaborate，即可直接改善恢复、复盘和审计体验。

## 8. Runtime 与整体架构评审

### 8.1 P0：repo 级 single-owner Runtime 仍未实现

Web 与 CLI 仍可分别构造和持有：

- SQLite connection、WriteQueue、repositories；
- Session store、EventBus；
- JobRunner；
- SubprocessRegistry；
- Workflow/Automation executor；
- Git/worktree、Provider 与 shutdown 生命周期。

Job owner、lease、CAS 和进程内 generation token 能保护部分 Job 行，却不能完整 fence：

- 普通文件写入；
- Git/worktree promotion；
- Artifact；
- Gate；
- Audit；
- Automation/Delivery；
- 外部 SDK 和未登记子进程。

长期方向仍应是：

```text
repo-scoped daemon/service
→ physical repo lock
→ CLI/Web 客户端化
→ 统一 admission、execution、Git、DB、Provider 和 shutdown authority
```

### 8.2 P0：Shutdown 仍不能证明 quiescent

当前 JobRunner 已有：

```text
停止 poll
→ 等待 active poll
→ settle window
→ AbortController
→ kill 已登记子进程
→ hard deadline
→ DB closed fence
```

但 hard deadline 到达后，不合作 executor 仍可能继续运行 JavaScript、写普通文件、执行 Git 或留在外部 SDK 中。清空 controller/token map 也不等于任务已经退出。

完整闭环需要 executor process/worker 隔离、真实 kill/join、generation fencing、checkpoint/flush 和 crash/restart/late-write 故障注入。

### 8.3 P0：Session Event 仍是 best-effort projection

当前数据语义仍是：

```text
领域表 / Audit 先成功
→ best-effort append session_event
→ 找不到 Session 或 append 失败时允许跳过
```

它适合 UI 观察投影，但不能独立承担：

- durable inbox；
- 权威模型历史；
- prompt claim/processed；
- crash replay；
- fork/resume；
- restart recovery。

应明确选择 authoritative append-only Session log，或让领域事实/transactional outbox 永久权威、Session 仅为可重建 projection。不能同时把它描述为“允许丢失的 UI 事件”和“未来完整恢复基础”。

### 8.4 P1：Run admission 缺事务或 Saga

#31 仍是当前最靠近用户可见正确性的架构问题之一。Provider preflight、RunPlan 校验、Demand/Project/Run/Plan/Provider/Audit/Session/Events/Job 必须形成明确 admission boundary。

推荐优先评估：

```text
A. SQLite admission transaction + transactional outbox
```

或：

```text
B. admitting → queued / admission-failed 幂等 saga
```

文件目录和远端副作用不能直接塞入数据库事务；需要提交后幂等创建或显式补偿。

### 8.5 P1：RunPlan 尚未成为唯一执行事实

当前 RunPlan 已覆盖角色、Gate、阶段、Agent、Profile、Timeout、Dirty Base 和 Template identity，但尚未完整绑定 Demand、mode、base、Workspace physical identity、resolved Provider、permission/network acknowledgement、expected Artifacts 与 executable plan。

execute/resume 仍读取独立 ExecutionPlan、Provider snapshot 和其它字段。`SessionService.planDigest` 的静默失效进一步说明计划事实尚未通过一个类型和一个存储边界统一。

## 9. 代码实现与测试质量

### 9.1 正向判断

- 用户本轮仅修文档/注释，没有用无关代码制造“整改”；
- DSH Adapter 的 arg whitelist 注释现在与真实行为一致；
- Web/CLI 对主要 dsh 入口已有 explicit network confirmation 与 pre-persistence preflight；
- Session/Workspace SSE 的 cursor、backpressure 和 pending budget 已有较强回归覆盖；
- Session right rail 对 Event 缺失和未知状态有防御性 fallback；
- CommandGateway 的 no-progress 两阶段 watermark 修复仍通过；
- CI 将 production dependency audit 与功能测试分离，当前所有 lane 成功；
- #30 被关闭为 not_planned，说明评审过程开始主动删除流程性工作，而不是只增加任务。

### 9.2 需要收敛的实现热点

1. **Provider config 混合能力和确认事实**  
   `AgentAdapterConfig` 中的 capability、permission profile、acknowledgement 和 runtime override 边界不够清晰。应引入明确 admission record，而不是继续增加布尔字段。

2. **SessionService 泛型 engine input 过于不透明**  
   `TEngineInput=unknown` 让 Service 无法校验 plan/provider/admission 是否同构；顶层 `planDigest` 又成为失效参数。下一步应形成显式 `RunAdmission` 类型，而不是增加更多 parallel optional fields。

3. **CLI composition root 使用隐藏可变槽**  
   `activeAgent` 说明 preflight API 设计不足。应从签名修正，不应用更多锁或全局状态补丁。

4. **CommandGateway 职责仍过密**  
   policy、env、spawn、process group、redaction、filesystem sampler、timeout 和 stream settle 仍集中在一个模块。后续先抽纯 timeout state machine、clock、activity sampler 与 termination adapter，不应继续堆 timer 特判。

5. **Provider command identity 仍由 basename 推断**  
   DSH/Codex 的 fake test seam 与生产安全合同混在一起，需 #28 独立重构。

6. **真实 Provider 证据仍不足**  
   fake binary 和 metadata fixture 不能替代真实 Codex/Claude/dsh 的 success/failure/cancel/redaction smoke。

## 10. 是否存在过度实现或过度设计

### 10.1 横向平台化仍领先于纵向闭环

仓库已经拥有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
大量阶段计划、ADR、复审报告和 issue
```

而最小持续协作闭环仍未完成：

```text
同一 Session 继续输入
→ Provider execution-time updates
→ follow-up / prompt cancel
→ Runtime restart + resume
→ Collaborate → Deliver
```

因此下一阶段应冻结与下列目标无直接关系的新 Profile、Automation job、Driver wrapper、展示 Event 和 Workflow DSL：

```text
single-owner Runtime
→ atomic admission
→ authoritative Session
→ persistent Provider stream
→ follow-up/cancel/resume
→ Collaborate → Deliver
→ RunPlan authority
→ export/compaction/retention
```

### 10.2 Project/Workspace 是可能的重复建模

每 Run 新 Project 与每 repo Workspace 同时存在，是典型“抽象先于清晰领域语义”。应先决定用户真正管理的是 repo/workspace、project，还是 immutable run snapshot，再决定保留、合并或重命名。

### 10.3 评审流程本身仍需停止增长

PR #11 已超过 140 个提交和 190 个文件。继续创建第十八轮报告本身不是理想流程，但用户本轮再次要求全面复审，且最新 Head 改变了权威状态。本报告应作为 PR #11 的最终评审增量；后续只在对应独立 PR/issue 中更新，不再向本 PR 回填新的架构代码或创建第十九轮总报告。

#30 的关闭是正确示范：没有多人并行或 release train 时，Markdown checklist 已足够，原生 subissue/milestone/assignee 会增加维护成本而不改善产品。

## 11. DeepSeek Harness `0.1.2-alpha.4` 对齐

### 11.1 当前版本事实

```text
Tekon tested pin = 0.1.2-alpha.3
DeepSeek Harness latest = 0.1.2-alpha.4
```

继续精确 pin alpha.3 是合理的 fail-closed 决策；latest 不自动等于 compatible。

### 11.2 Headless 继续保持 Goal-only

官方 Headless 仍是一项任务一次 invocation，最终回答后退出，没有 interactive follow-up。它适合脚本、CI 和 one-shot Goal，不适合作为持续 Session 的伪实现。

### 11.3 alpha.4 扩大默认网络工具面

alpha.4 为 Headless、ACP、Python SDK 和 custom profile 默认启用 `web_fetch`。这不会绕过 Tekon 当前对 dsh“不受限网络需确认”的入口检查，但会加重本轮发现的默认 ack 与 Audit 事实链问题：上游默认网络能力扩大后，Tekon 更不能让 Provider config 自行代替用户确认。

升 pin 前仍需：

```text
L1 source/fixture
→ L2 real metadata binary
→ L3 credentialed Provider smoke
→ web_fetch / acknowledgement / snapshot / Audit review
```

### 11.4 ACP 仍是 Collaborate 的优先验证边界

官方 ACP 已提供 persistent session、list/resume/close、prompt/cancel、semantic updates、permission request 与 quiescent close，更接近 Tekon 缺失的持续协作能力。

推荐独立切片：

```text
owned ACP subprocess
→ session/new
→ prompt
→ execution-time updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

不要把 ACP 强塞进现有 one-shot `AgentAdapter`；先验证协议、生命周期、事实源和权限映射。

### 11.5 Safety 边界不变

DeepSeek Harness 官方仍明确为未经安全审计的 developer preview；sandbox、approval 和 permission controls 只能降低风险，不能保证隔离。Tekon 必须继续依赖 least privilege、Host/container policy、credential minimization、worktree scope、Audit 和人工副作用 Gate，不能把 Harness 当作唯一安全控制。

## 12. 问题清单

| ID / Issue | 严重度 | 状态 | 当前结论 |
| --- | --- | --- | --- |
| #16 single-owner Runtime | P0 | 未关闭 | CLI/Web 仍各自持有 DB、JobRunner、Git/worktree、Provider 与 shutdown。 |
| #15 executor isolation/restart | P0 | 部分完成 | Abort/kill/deadline/DB fence 不证明普通文件、Git、JS 和 SDK 已 quiescent。 |
| #13 authoritative Session | P0 | 未关闭 | Event 仍是 best-effort projection，不是 durable inbox/权威模型历史。 |
| #14/#19 Collaborate | P0 | 未关闭 | 真实 stream、follow-up、steer、prompt cancel、restart resume、Collaborate→Deliver 缺失。 |
| #31 atomic Run admission | P1 | 未关闭 | prepareRun、Audit、Session、Events、Job 缺事务/saga 与失败补偿。 |
| #22 Provider exception facts | P1 | 本轮扩大 | 默认 DSH config 自行 ack；Snapshot/Audit/resume 事实链不完整。 |
| #20 RunPlan authority | P1 | 本轮扩大 | 顶层 planDigest 静默失效；Project/Workspace identity 分裂；execute/resume 未统一。 |
| #29 Provider health/admission | P1 | 本轮扩大 | credential/provider health 耦合；CLI activeAgent mutable slot；Codex/Claude 前置 probe 缺失。 |
| #28 Provider command identity | P1 | 未关闭 | DSH/Codex basename 改变 preflight 或 controlled argv 合同。 |
| #18 history/context budget | P1 | 部分完成 | 在线资源有界；完整导出、compaction、retention 和规模矩阵缺失。 |
| #17 DSH alpha.4 | P1 | 部分完成 | latest 为 alpha.4；tested pin alpha.3；L2/L3 与 web_fetch 复核未完成。 |
| #21 a11y | P1 | 未关闭 | 局部 ARIA/Chromium 不能替代全站辅助技术与多浏览器验收。 |
| #25 CommandGateway | P2 | 未关闭 | 职责过密，timeout state machine 和 sampler 未独立。 |
| #26 lint/format | P2 | 未关闭 | 无真实 JS/TS semantic lint gate，format debt 仍大。 |
| #24 required checks | P1 | 暂缓 | main 未保护，CI 仍依赖人工流程。 |
| #30 native project metadata | P3 | not_planned | 当前轻量 checklist 足够，避免流程过度设计。 |

## 13. 推荐实施顺序

1. **#16 single-owner daemon + repo lock**  
   统一 repo、DB、Git、Provider、Job 和 shutdown authority。

2. **#15 executor isolation + restart contract**  
   process/worker、kill/join、generation fencing、checkpoint 和故障注入。

3. **#29 / #28 Provider admission 与 command identity**  
   两项可并行：前者解决 capability/health/request scope，后者解决 executable/framing/test seam。

4. **#31 atomic Run admission + #22 exception facts**  
   将 Provider acknowledgement、RunPlan、Snapshot、Audit、Session、Events、Job 纳入事务或 saga。

5. **#20 canonical RunPlan authority**  
   统一唯一参数源、execution snapshot、Workspace identity 和 resume 验证。

6. **#13 authoritative Session / outbox / durable inbox**  
   建立 claim/processed/retry 和完整模型历史。

7. **#14 ACP real-provider vertical slice**  
   persistent session、semantic updates、prompt cancel、quiescent close、restart resume。

8. **#19 Collaborate → Deliver**  
   同一 Session follow-up/steer、计划升级和人工审批点。

9. **#18 complete-history export + model compaction**  
   Host streaming export、flush/snapshot、manifest、subsession/artifacts 和统一 retention。

10. **#17/#21/#25/#26 与 release governance**  
    DSH 验证、全站 a11y、CommandGateway 拆分、semantic lint、SBOM/provenance/signing。

## 14. 合并与发布边界

当前代码门通过只证明：

- `9daa912...` 的文档/注释增量没有击穿现有自动化；
- 现有 Root、Audit、CLI、Web unit 和 Chromium Playwright 合同成功；
- 第十六/十七轮已经落地的 Adapter preflight、TopBar a11y、Session/SSE 等修复仍通过回归。

它不能证明：

- 所有 Core 调用路径都获得了本次网络确认；
- Run admission 失败不会留下半成品；
- Web/CLI 多进程不会产生 Git/文件副作用冲突；
- shutdown 后所有 executor、Git、文件和 SDK 工作都已终止；
- Session Event 可恢复完整模型上下文；
- RunPlan 已成为执行/恢复唯一事实；
- DSH alpha.4 或真实 Provider 模型调用已验证；
- Firefox/WebKit、屏幕阅读器和真实弱网设备已通过。

PR #11 已远超适合继续增长的规模。最终建议 squash merge；后续所有问题必须经 #27 中的独立小 PR 推进。`main` 仍未启用 required checks，合并前需人工确认 PR Head 与最终 Core/CI 终态一致。

本轮未执行 merge、release、deploy 或仓库 ruleset 修改。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第十七轮报告](2026-09-02-tekon-product-runtime-harness-seventeenth-review.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [WorkflowEngine](../../packages/core/src/workflow/engine.ts)
- [SessionService](../../packages/core/src/session/session-service.ts)
- [RunPlan](../../packages/core/src/workflow/run-plan.ts)
- [AgentRuntime](../../packages/core/src/runtime/agent-runtime.ts)
- [Provider Registry](../../packages/core/src/runtime/provider-registry.ts)
- [DSH Adapter](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [Codex Adapter](../../packages/core/src/runtime/codex-adapter.ts)
- [CLI Session composition](../../packages/cli/src/lib/session-context.ts)
- [Web project.run](../../packages/web/src/server/api/routers/project.ts)
- [主线 Tracking #27](https://github.com/zesming/tekon/issues/27)
- [Provider exception #22](https://github.com/zesming/tekon/issues/22)
- [RunPlan authority #20](https://github.com/zesming/tekon/issues/20)
- [Provider health/admission #29](https://github.com/zesming/tekon/issues/29)
- [Atomic Run admission #31](https://github.com/zesming/tekon/issues/31)

### DeepSeek Harness 官方

- [dsh v0.1.2-alpha.4 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/bundle/headless/README.md)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/packages/acp/acp/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.4/SAFETY.md)
