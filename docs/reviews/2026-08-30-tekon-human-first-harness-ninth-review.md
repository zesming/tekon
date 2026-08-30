# Tekon 人类可用性、持续协作与 DeepSeek Harness 第九轮全面复审

- **日期**：2026-08-30
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威快照**：`c732d5db278a3906bddb71a9debe7bd9578614fd`
- **用户 v0.19.0 整改快照**：`f7be7550680a792f9a619e6de2056612226e9d2b`
- **本轮 reviewer 代码快照**：`4d4daeaf176f2457b4d64b084f73fe511661fd4f`
- **产品版本**：`0.19.0`
- **DeepSeek Harness 官方基线**：`cd5ef8148158c3a752a658978873241fdf8e2bbc`（`dsh@0.1.2-alpha.1`）
- **代码自动化状态**：`4d4daeaf...` 的 Core #314 与 CI #223 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Playwright 全部成功
- **裁决**：本轮整改与 reviewer 低风险修复通过代码合并门；整体产品仍未通过“面向普通人的稳定持续协作研发工作台”验收

## 1. 执行摘要

v0.19.0 是一次有价值的集中整改，不是纯粹增加测试或修改报告措辞。以下改进在当前实现中基本成立：

- Session 子表外键迁移和孤儿 quarantine；
- 连接健康缓存不再保存原始 token，并有容量与 TTL 边界；
- Workflow/Role 详情面板具备 focus trap、Escape、焦点恢复和背景 inert；
- RPC event page limit 增加最大值；
- Web workflow 启动要求 plan digest；
- DSH preflight 被前移到 Run 持久化之前；
- shutdown 后增加数据库写入栅栏；
- SSE 开始处理 `response.write()` 的背压信号。

但本轮代码复核也发现，“新增机制存在”仍被几处文档直接表述成“完整闭环”。用户快照上存在四个可以独立验证的真实缺陷：

1. **Web 校验的是扩展 RunPlan，实际持久化的却是 Engine 自行回退生成的另一份计划**；自定义 Workflow 在校验后还会再次读取，存在 validation-to-execution TOCTOU。
2. **Web DSH preflight 依赖进程级共享变量 `pendingAgent`**；并发启动不同 Provider 时，后一个请求可以覆盖前一个请求的预检对象。
3. **错误信息和 CLI 都声明支持 `TEKON_DSH_ALLOW_VERSION` / `--allow-version`，正常调用路径却没有把值传入 Core preflight**。
4. **服务端新增 `replay-truncated` SSE 控制帧，客户端却把每个带 data 的帧都强转为 PresentedEvent**，会把没有 `seq/type` 的控制对象送进 EventFeed 和窗口合并逻辑。

上述四项已在本轮 reviewer 提交中修复，并补充了对应测试。修复后当前代码合并门通过。

仍然不能把 Tekon 定位成稳定持续协作产品。最关键的主链路仍是：

```text
repo 级单一 Runtime owner
→ 可证明的 quiescent shutdown / restart recovery
→ authoritative Session log / durable inbox
→ 真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为执行与恢复的唯一输入
```

## 2. 最终判断

### 2.1 当前 PR 增量

本轮代码快照 `4d4daeaf176f2457b4d64b084f73fe511661fd4f`：

- Core #314：`completed/success`；
- CI #223：`completed/success`；
- Root build/typecheck、installer syntax、CLI unit/e2e、Web build/typecheck/unit、Playwright 均成功。

因此，**v0.19.0 用户整改与本轮 reviewer 低风险修复通过当前代码合并门**。

这只说明当前改动在现有合同下可构建、类型正确、自动化通过；不表示执行了 merge、release 或 deploy。

### 2.2 整体产品成熟度

当前最准确的定位仍是：

> Tekon v0.19.0 是测试覆盖较强、计划与风险边界逐渐透明的实验性受控交付执行与观察基础设施；其 Deliver 轨道已有真实试用价值，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的恢复语义和全链路历史预算尚未完成。

不应使用以下表述：

- 面向普通用户的稳定持续协作研发工作台；
- 多进程并发安全的本地 Agent Runtime；
- 拥有 crash-safe durable inbox 和模型历史恢复的 Session 平台；
- 已完成生产级 shutdown、restart resume 和任意规模长会话有界化；
- 可把 DeepSeek Harness sandbox 当作唯一安全边界的系统。

## 3. 评审范围与方法

本轮重新核验了：

- 根目录产品说明、CHANGELOG、安装与版本合同；
- Core 的 Workflow、RunPlan、Session、JobRunner、Provider、CommandGateway、迁移和仓储层；
- CLI 的 run、provider preflight、Session composition root 与恢复路径；
- Web 默认入口、高级入口、计划 API、project.run、健康状态、SSE、QueryCache、EventFeed、配置详情面板；
- 第八轮报告、第 18/19 节批注、整改方案与当前权威入口；
- PR 当前 Core/CI 终态；
- DeepSeek Harness 官方 Safety、Headless、SDK client、ACP server 文档和当前发布版本。

判断原则：

1. 一项合同必须同时核对生成、校验、持久化、执行和恢复路径；
2. 并发安全不能由单请求测试代替；
3. “有上限”必须同时检查 DB、API、SSE 缓冲、浏览器内存、DOM 和模型上下文；
4. 控制帧、业务事件和模型可见事件必须分层；
5. best-effort 投影不能被称为权威事实源；
6. 自动化通过不是架构问题已关闭的依据；
7. 局部修复不能遮蔽仍缺失的用户纵向闭环。

## 4. v0.19.0 七项整改逐项复核

| 整改项 | 当前结论 | 复核说明 |
| --- | --- | --- |
| canonical RunPlan | **部分关闭** | Web digest 强制化与参数扩展成立；本轮 reviewer 修复了 Web 校验对象与持久化对象不一致、模板二次读取问题。仍未绑定 demand/version、base revision、workspace identity、网络确认事实、预期 artifact 和 resolved Provider config；Goal 仍免校验；恢复执行仍主要读取 execution plan/provider snapshot，而不是重新校验 canonical RunPlan。 |
| DSH preflight | **入口侧基本关闭，Provider 方向未关闭** | 用户已把 probe 前移到 `prepareRun` 前；本轮修复了共享 `pendingAgent` 并发串扰和失效的 allow-version 逃生开关。仍缺官方 `0.1.2-alpha.1` contract fixture 与真实 smoke，且 headless 本质仍是 one-shot。 |
| 长 Session 有界化 | **部分关闭** | RPC limit、初始 tail、reconnect 预算和基础 drain 处理成立；本轮修复客户端控制帧污染。`loadEarlier` 仍不是严格的 before-cursor 分页，过滤扫描只有固定 5 页，慢客户端期间服务端 `pending` Map 仍无容量上限，截断也未向用户显示可理解警告。 |
| 连接健康 | **当前目标基本关闭** | token cache key 已 SHA-256 化、容量 128、TTL 清理；Provider 字段明确为 dshHeadless。它证明的是 Web token 与 dsh binary presence，不是所有 Provider 的模型可调用性，这一点当前文案已经较诚实。 |
| Session 外键迁移 | **基本关闭** | 三张子表已 table rebuild、加入 cascade FK，并 quarantine 孤儿。迁移检测只验证“存在指向 sessions 的 FK”，未严格核对 source column/on-delete；迁移结束建议增加 `foreign_key_check` 作为独立验证。 |
| 配置详情 dialog | **局部关闭** | 当前 Role/Workflow 详情有 dialog name、focus trap、Escape、焦点恢复、滚动锁定和 inert。该结论仅适用于这两个面板，不能外推为全站无障碍验收。 |
| shutdown closed fence | **增量成立，P0 未关闭** | deadline 后 repository/DB 写会快速失败，而不是继续静默写入关闭句柄。但不合作的进程内 executor Promise 仍可以继续计算、访问文件系统或 Git；`stop()` 超时返回不等于资源已 quiescent。 |

## 5. 产品逻辑评审

### 5.1 Deliver 轨道已经具备明确价值

当前主路径能够表达：

```text
需求塑形
→ 人工批准
→ 运行前计划预览
→ Workflow 执行
→ Gate / Artifact / Audit
→ Review
→ PR prepare
→ 人工确认后 create-pr
```

相比早期版本，当前产品在以下方面更加诚实：

- 默认入口明确启动受控交付，而不是伪装成通用聊天框；
- DSH 被限制为 Goal / one-shot；
- 计划不可用时不能启动；
- 网络不受限需要显式确认；
- PR 创建仍保留人工红线；
- 失败 Session 有清晰的行动状态。

这条轨道可以继续用于低风险仓库、dogfooding 和有人监督的真实样本。

### 5.2 Collaborate 仍没有形成产品闭环

默认页面采用 Session/Composer 形态，但用户在同一 Session 中仍不能：

- 继续追问；
- 对运行中的 Agent steer；
- 追加上下文；
- 对当前 prompt 做真正的 Provider 级 cancel；
- 在 Runtime 重启后恢复同一 Agent；
- 把一段探索性协作升级成受控 Deliver。

`LegacyAgentDriver` 仍明确让 `followUp`、`steer`、`resume` 抛出 `NotSupportedYet`；`events()` 还是等待 one-shot 完成后再一次性产出 buffered events。产品外观已接近协作工作台，底层能力仍是一次性交付执行器。

### 5.3 “需求计划”与“运行计划”仍有双重心智模型

当前存在两套相邻但不同的概念：

- Draft 的 generatePlan / planApprove；
- Workflow API 返回的 RunPlan digest。

前者是需求卡审批过程，后者是启动时的执行参数快照。代码中二者分别校验，UI 尚未把它们解释成两个不同层次。普通用户容易认为“计划已经批准”就等于“接下来一定执行那一份计划”。

后续应明确：

- Demand Plan：说明做什么、边界与验收；
- Execution RunPlan：说明由谁、在哪个 base、以什么权限/预算/Workflow 执行；
- Run 创建时把两者版本和摘要一起绑定。

### 5.4 Goal 边界基本诚实，但不能继续膨胀

Goal 当前适合：

- one-shot 探索；
- 无 required artifacts 的轻量任务；
- dsh-headless 实验入口。

它不应继续承担 Session collaboration 的替代品。若 Goal 再增加 Profile、Automation、Delivery 或复杂 Gate，会扩大状态矩阵，却仍不能解决 follow-up 与恢复。

## 6. UI 与 UX 评审

### 6.1 默认入口与高级入口

正面变化：

- 两个入口都依赖服务端计划；
- workflow 模式都提交 digest；
- 本轮修复后，默认 profile/allowDirtyBase 会在 plan 与 run 两端一致归一化；
- Web 持久化的是实际通过校验的同一份计划，而不是 Engine 回退计划。

仍需改善：

- RunPlan 应显示 base revision、workspace、resolved timeout、Provider route 和 artifact expectations；
- 计划变更导致 digest mismatch 时，UI 应主动重新拉取并解释哪些字段改变，而不是只展示服务端错误；
- Draft Plan 与 RunPlan 需要明显区分标题与审批语义。

### 6.2 长历史交互仍可能误导

“加载更早历史”当前通过：

```text
earliestSeq - pageSize - 1
→ 调用 sinceSeq 的向前分页
```

它没有真正的 `beforeSeq` 上界。若中间存在大量 internal/ui-filtered 事件，服务器可能返回当前窗口之后的可见事件；客户端去重后几乎没有向前推进，却仍增加 retainFloor。固定 5 次 raw-page scan 也意味着超过该范围的连续内部事件会返回空 visible page + `hasMore=true`，而 API 没有返回新的 raw cursor 供客户端继续。

应改成真正的 backward cursor contract：

```text
beforeSeq
→ raw rows ORDER BY seq DESC LIMIT n
→ server 返回 visible events + nextBeforeSeq
→ client 只在 next cursor 变小时认为发生进展
```

### 6.3 replay truncation 需要用户可见语义

本轮已修复控制帧被错误加入 EventFeed 的代码缺陷，但截断目前仍是静默行为。用户只会看到历史突然从较新的尾窗开始，无法判断：

- 是没有更多记录；
- 还是重连预算超限；
- 还是网络中断导致历史被截断。

建议在 Session 顶部显示非阻断提示：

> 连接恢复时历史量超过在线回放预算，已切换到最近记录；完整历史仍可按页读取。

### 6.4 Dialog 改进有效，但结论应限制范围

`useDialogA11y` 已为当前两个详情面板提供：

- 初始焦点；
- Tab/Shift+Tab 循环；
- Escape；
- 焦点恢复；
- body scroll lock；
- 背景 inert。

这是正确方向。下一步需要做全站清点，覆盖确认框、Drawer、审批弹层、错误区域、动态状态播报、对比度和多浏览器，而不是再为每个面板复制一套 hook。

## 7. 整体框架与架构评审

### 7.1 P0：仍缺 repo 级单一 Runtime authority

Web 和 CLI 仍各自：

- 打开 SQLite；
- 创建 WriteQueue；
- 创建 JobRunner；
- 创建 SubprocessRegistry；
- 管理 worktree/Git/Provider 子进程；
- 独立执行 shutdown。

jobs row CAS 能减少双 claim，但不能覆盖：

- Git branch 与 worktree promotion；
- artifact/gate/audit/session projection 的副作用；
- process-local registry；
- automation listener；
- readiness/delivery 派生任务；
- shutdown 和恢复所有权。

`run_locks` 表本身不等于 Runtime owner。正确方向仍是 repo-scoped daemon/service + CLI/Web 作为客户端。

### 7.2 P0：Session Event 仍不是权威事实源

Dual-write bridge 明确：

- 找不到 Session 静默跳过；
- append 失败只 reportError；
- 未知领域事件不映射；
- Session Event 失败不能影响治理主路径。

这意味着 Session Event 可以做 UI 投影，但不能独立承担：

- 模型历史；
- durable inbox；
- prompt claim/processed；
- crash recovery；
- fork/replay；
- exactly-once 或可证明的 at-least-once 处理。

需要独立 ADR 明确三选一：

1. authoritative Session log；
2. 领域表权威 + transactional outbox；
3. 明确只读 projection，并取消所有“可恢复模型历史”的暗示。

### 7.3 RunPlan 已能做审计快照，但还不是执行权威

本轮 reviewer 修复后，Web 会持久化通过 digest 校验的原始 canonical snapshot。然而执行过程仍主要依赖：

- 另行持久化的 executable plan；
- workflow_instances；
- provider snapshot；
- 当前 repository/base/worktree 状态。

resume 并不会重新校验：

```text
canonical plan digest
= executable plan
= provider snapshot
= workspace/base identity
```

因此当前 RunPlan 是可靠度更高的审计与知情确认材料，但还不是唯一执行输入。

### 7.4 Shutdown 的正确终点仍是“实际退出”

当前 `Promise.race([drainTasks, hardDeadline])` 到期后清空内存控制表并返回。DB closed fence 能阻止后续 DB 写，但不能阻止：

- 未合作 executor 继续占 CPU；
- 直接文件写；
- 非 registry 子进程；
- Git 命令或外部 SDK 内部活动；
- 迟到日志与错误。

需要把不可信/不合作执行器放入可终止的 process/worker boundary，并将 stop 合同定义为：

```text
停止接收
→ 取消
→ drain
→ SIGTERM
→ SIGKILL
→ wait for actual exit
→ flush/checkpoint
→ close DB
```

### 7.5 DSH 长期方向仍应采用 ACP 优先的独立 vertical slice

Headless 继续适合作为受限制的 one-shot Goal provider；不应扩展成长期 AgentDriver。

ACP 更接近 Tekon 缺失的合同：

- persistent session；
- session/list 与 resume；
- execution-time semantic updates；
- prompt cancel；
- quiescent close；
- 多 Session 隔离；
- permission request。

但 ACP 明确是 trusted controller 自动化面，不提供 DSH UI 私有 plans、terminals 或 elicitation。Tekon 应把它映射成 Provider transport，而不是把 ACP UI 能力和 Tekon 产品模型混为一谈。

## 8. 代码实现与工程质量

### 8.1 正面评价

- Workflow template 使用严格 schema；
- CommandGateway 继续使用 argv 执行而非 shell；
- secret redaction、artifact manifest、progress evidence 有较强回归覆盖；
- migration 已考虑旧库 table rebuild 和孤儿隔离；
- QueryCache 有 auth scope、generation 和 in-flight 清理；
- Web/CLI/Playwright 测试合同较丰富；
- Provider config snapshot 能保存实际 resolved timeout/permission 信息；
- 本轮增加的 plan persistence 与 SSE control-frame 测试是有效的反回归测试。

### 8.2 本轮发现并修复的代码问题

#### FIX-01：Web canonical plan 不一致

用户快照中：

- project router 校验扩展计划；
- engine factory只收到 `planDigest`，没有 `canonicalPlan/planSnapshot`；
- Engine 因此自行生成字段较少的 fallback snapshot；
- project workflow 在校验后再次读文件。

本轮改为：

- 一次加载 Workflow；
- 同一对象用于 digest 与 `workflowSpec`；
- 默认 agent/profile/allowDirtyBase 显式归一化；
- 同一 canonicalPlan、digest、snapshot 进入 Engine 并持久化；
- 测试直接读取 `workflow_instances.plan_digest/plan_snapshot` 验证。

#### FIX-02：Web DSH preflight 并发串扰

用户快照用 `pendingAgent` 在 factory 与 no-arg preflight hook 之间传值。`await createEngine()` 会产生并发交错窗口。

本轮把 preflight 移入 request-scoped async engine factory，直接读取本次 `input.agent`，不再使用共享可变槽。

#### FIX-03：DSH version escape hatch 失效

Core 错误信息指导用户设置 `TEKON_DSH_ALLOW_VERSION`，但 `runDshPreflight` 不读取该变量；CLI 的正常路径调用 Core 时也没有传 `--allow-version`。

本轮：

- Core 统一读取 option 或 env；
- CLI 删除重复的 probe 实现，直接调用 Core；
- 新增 CLI flag 与 env 两条真实进程测试。

#### FIX-04：SSE control frame 污染事件列表

`replay-truncated` data 没有 PresentedEvent 的 `seq/type`。客户端此前仍调用 `onEvent`，会破坏 merge、Last-Event-ID 和 EventFeed。

本轮按 event name 识别控制帧、只更新 resume cursor、不送入业务事件回调，并增加 reconnect 测试。

### 8.3 仍需收敛的复杂度热点

- `project.ts` 仍同时承担 token、health、draft、plan、Provider、clean、run/resume/cancel；
- Workflow/Job/Session/Delivery 多套状态需要大量映射；
- SessionService 的通用 hook 与 composition root 容易形成隐式跨层协议；
- Core/CLI/Web 曾各有 DSH probe 逻辑，虽然本轮已收敛 CLI，adapter 内仍保留自己的 lazy guard；
- current review、历史 review、remediation plan 数量持续增长；
- Automation/Profile/Legacy Driver 的组合矩阵明显大于当前纵向用户价值。

建议把 project router 拆成：

```text
ProjectHealthService
RunAdmissionService
RunControlRouter
ProjectReadRouter
```

但拆分应以减少状态所有者为目标，不要只增加 wrapper 文件。

## 9. 过度实现与过度设计判断

### 9.1 当前横向抽象已经领先于核心纵向价值

已存在：

- AgentAdapter；
- AgentDriver / LegacyAgentDriver；
- Provider Registry；
- JobRunner；
- Session projection；
- dual-write；
- Profile；
- Automation；
- Goal；
- Readiness；
- Delivery；
- CLI/Web 两套 composition root；
- 多轮 review/remediation 权威文件。

而最小持续协作闭环仍缺：

```text
同一 Session 发第二条消息
→ Provider 运行中持续发真实事件
→ 用户 cancel / steer
→ Runtime 重启
→ resume 同一 Agent
→ 升级到 Deliver
```

因此后续冻结原则应保持：除非直接服务上述闭环、single-owner 或权威事实源，否则暂缓新增：

- 新 Profile；
- 新 Automation job kind；
- 新展示型 event；
- 新 Driver 包装层；
- 新 Workflow 语法；
- 新评估器。

### 9.2 不要用“通用框架完整度”替代产品完成度

当前最有价值的下一步不是让每个抽象都拥有更多方法，而是选一个真实 Provider 做完整 vertical slice。只有真实协作闭环跑通后，才能判断哪些现有抽象值得保留，哪些是过早泛化。

## 10. DeepSeek Harness 官方对照

### 10.1 当前发布与运行合同

官方当前 master 基线 `cd5ef814...` 的根版本为 `0.1.2-alpha.1`，Node 合同为 `^22.19.0 || >=24.0.0`。Tekon 当前 tested pin 仍是 `0.1.1-rc.2`。

这个差异不应被自动升级掩盖：

- DeepSeek Harness 明确处于快速变化的 developer preview；
- Tekon 依赖 help anchor 与插件 id 字符串；
- 必须重新录制真实 help/config/version fixture，并做带 API key 的 smoke 后再升 pin。

### 10.2 Headless

官方明确：

- one task per invocation；
- final answer 后退出；
- no interactive follow-up；
- reasoning 进入 stderr；
- 只有 reasoning 与最终回答被打印；
- 第一 token 前没有 heartbeat。

因此当前 Tekon 的 Goal-only 边界正确；headless 不应承担 Collaborate。

### 10.3 ACP

官方 ACP surface 提供：

- persistent session new/list/resume/close；
- prompt/cancel；
- semantic messages/thought/tool/config/context updates；
- serialized per-session updates；
- quiescent teardown；
- permission request；
- 多 Session 并发隔离。

同时它不提供 Tekon 需要自行拥有的产品层 plans、terminals、commands、additional directories 或 elicitation。

### 10.4 SDK

官方 TypeScript SDK 提供 owned subprocess、persistent client、run event/notification collection 和明确错误类型；close 使用 protocol shutdown → stdin EOF → SIGTERM → SIGKILL，直到实际进程退出。

但 SDK 当前明确没有 mid-turn cancel；放弃一轮通常意味着关闭 runtime。因此：

- 若优先验证 prompt cancel/resume，ACP 更匹配；
- 若优先验证简单 TS 接入和事件采集，SDK 更容易；
- 两者都应作为独立 Provider transport spike，不直接替换现有通用 Driver。

### 10.5 安全边界

官方 Safety 明确：

- 未经安全审计；
- 不能视为 secure 或 production-ready；
- sandbox/approval/permission 只能降低风险，不能保证隔离；
- 不应作为 untrusted workload 的唯一安全控制。

Tekon 必须继续拥有自己的：

- 最小权限进程；
- credential scrub；
- workspace scope；
- 容器/VM 或专用环境；
- 人工副作用 Gate；
- 宿主备份与审计。

## 11. 主要问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级单一 Runtime owner，Job CAS 不能覆盖全部副作用。 |
| P0-ARCH-02 | P0 | 部分完成 | closed fence 防 DB late write，但 hard deadline 不证明不合作 executor 已退出。 |
| P0-ARCH-03 | P0 | 未关闭 | Session Event 仍为 best-effort projection，不是 durable inbox/权威历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | follow-up、steer、真实 prompt cancel、restart resume、Collaborate → Deliver 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | Web 校验/持久化一致性已修；RunPlan 仍未绑定完整输入，也未成为执行/恢复唯一事实。 |
| P1-SESSION-01 | P1 | 部分完成 | loadEarlier 非真正 before-cursor；过滤扫描无 continuation cursor；慢客户端 pending buffer 无容量上限。 |
| P1-DSH-01 | P1 | 部分完成 | request-scoped preflight 与 escape hatch 已修；pin 落后官方发布且缺真实 smoke。 |
| P1-DATA-01 | P1 | 基本关闭 | FK rebuild/quarantine 已落地；建议补严格 FK shape 与 foreign_key_check。 |
| P1-A11Y-01 | P1 | 部分完成 | 两个配置详情 dialog 已闭环；全站 screen reader、多浏览器、对比度尚未验收。 |
| P1-CODE-01 | P1 | 未关闭 | project router 和状态映射复杂度继续上升，边界与所有权不清。 |
| P2-UX-01 | P2 | 未关闭 | replay truncation 未向用户显示；更早历史按钮可能没有实际向前推进。 |
| P2-DOC-01 | P2 | 未关闭 | current.md 同时保留“已闭环”与上一轮“不能关闭”快照，版本成熟度文字仍写 v0.18.0。 |
| FIX-PLAN-WEB | P1 | 本轮修复 | Web 校验计划、执行模板和持久化计划不一致。 |
| FIX-DSH-RACE | P1 | 本轮修复 | Web `pendingAgent` 可在并发启动中串扰 preflight。 |
| FIX-DSH-ALLOW | P2 | 本轮修复 | 文档化的 DSH allow-version flag/env 在正常路径无效。 |
| FIX-SSE-CONTROL | P1 | 本轮修复 | `replay-truncated` 控制帧被当作 PresentedEvent。 |

## 12. 建议实施顺序

1. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB、Automation 和 shutdown 所有权。

2. **executor 隔离与 restart contract**  
   真实 process/worker kill + join，interrupted checkpoint，故障注入和重启恢复。

3. **authoritative Session log / durable inbox ADR**  
   定义 append、claim、processed、retry、compaction、migration 和投影边界。

4. **DeepSeek ACP real-provider vertical slice**  
   只做 persistent session、execution-time updates、prompt cancel、close、restart resume；不要同时扩张 UI 与 Workflow DSL。

5. **Collaborate → Deliver**  
   第二条消息、steer、计划升级、审批点与交付切换。

6. **RunPlan 作为执行权威**  
   绑定 Demand version、Provider config、权限确认、base/workspace、Artifacts；execute/resume 验证 snapshot 与 executable plan 一致。

7. **真正的历史 cursor 与模型 context budget**  
   before/after cursor、SSE buffer cap、截断提示、summary/compaction 一起设计。

8. **数据和全站可访问性专项**  
   foreign_key_check、孤儿指标、screen reader、Firefox/WebKit、对比度和动态播报。

## 13. 合并与发布边界

当前 PR 可以证明：

- 当前改动通过现有构建、类型、单元、CLI e2e 和 Chromium Playwright 合同；
- Deliver 路径具备较强实验基础；
- 本轮四个具体运行时缺陷已修复；
- v0.19.0 的外键、health、dialog 等局部整改有真实实现。

它不能证明：

- CLI/Web 并发执行对 repo 副作用安全；
- hard-deadline 返回后所有 executor/子进程均已退出；
- Session history 可作为模型的完整恢复事实；
- 任意长历史均有稳定的网络和内存预算；
- DSH `0.1.2-alpha.1` 已被 Tekon 正式兼容；
- 普通用户持续协作闭环已经完成；
- 全站无障碍和多浏览器已经验收。

本 PR 未执行 merge、release 或 deploy。

## 14. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第八轮报告](2026-08-30-tekon-human-first-harness-eighth-review.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [第八轮整改方案](../superpowers/plans/2026-08-30-eighth-review-remediation-plan.md)

### DeepSeek Harness 官方（固定基线）

- [Root package / version](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/package.json)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/SAFETY.md)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/bundle/headless/README.md)
- [SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/sdk/client/README.md)
- [ACP server](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/acp/acp/README.md)

## 15. 结论

**代码合并门：通过。** v0.19.0 用户整改和本轮 reviewer 修复已经在代码快照 `4d4daeaf...` 上取得完整绿色终态。

**整体产品验收：不通过。** 当前最需要的是一个真实持续协作 vertical slice 和明确的 Runtime/Session 所有权，不是继续增加横向包装层。

允许的最终成熟度表述：

> Tekon v0.19.0 已形成测试较强、计划和风险边界更透明的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart 和全链路历史预算尚未闭环。
