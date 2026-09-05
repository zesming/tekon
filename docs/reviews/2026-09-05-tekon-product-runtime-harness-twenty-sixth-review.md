# Tekon 第二十六轮复审：取消投递与终态反馈

**2026-09-05 · v0.23.1 · [原 PR #11](https://github.com/zesming/tekon/pull/11)**

| 核验对象 | 固定快照与证据 |
| --- | --- |
| 用户整改基线 | `1e277464dbf9eeb9f97620421405d7a5913bc067` |
| 上轮实际交付 | `4bb7c260da2f8557f23beab42e01baca65f3ef2a` |
| 本轮代码修复 | `ed7e0bb0768c622357357d24eb20b726708cd66d` |
| 基线自动化 | [Core #444](https://github.com/zesming/tekon/actions/runs/33965871103)、[CI #353](https://github.com/zesming/tekon/actions/runs/33965871112) 均 completed/success |
| 修复自动化 | [Core #445](https://github.com/zesming/tekon/actions/runs/33967697106)、[CI #354](https://github.com/zesming/tekon/actions/runs/33967697121) 均 completed/success；新增 12 项回归实际执行 |
| 文档自身的最终 Head | 由 PR 描述及对应 Checks 单独记录，不以代码 Head 的绿色代替 |

## 1. 结论、范围与证据等级

**v0.23.1 的 R25 回执整改有效。本轮另发现两处具体问题：P1 取消投递可能被观察写入截断，且重复请求不再补发；P2 页面会把“完成已先赢得终态”的取消响应误报为已取消。两处均采用局部修复并补测试。** 没有因缺少 daemon、ACP 或事件溯源就将项目一概判为 P0，也没有重新报告已经完成的原子受理、有效命令绑定、共享提交控制器或健康检查拆分。

本次从远端 Head 和全部增量文件清单出发，检查产品文档、受理控制器、SessionService、运行控制组件、Workflow Engine/Node/Gate、JobRunner、真实后台执行器、命令网关、状态机、相关测试和上游官方合同。覆盖全仓结构与关键高风险调用链，不宣称逐行证明全部文件。结论分别标记为代码事实、执行复现、已修复切片或后续建议。

本地无法通过 DNS 访问依赖源，未完成 clone、安装和全仓 `pnpm test`。本地复现使用经 Git blob SHA 核对的真实源码与受控端口；其中取消复现替代了数据库终态写入端口，不能冒充 SQLite 集成。新增仓库测试再使用真实 SQLite/JobRepository/JobRunner 验证，集成结果以指定 SHA 的远端 CI 为准。没有独立 subagent；完成了第二遍保守自检，并撤回一个被组合根实现反驳的疑点。没有新的应用截图式审计、读屏、Windows、真实 DSH 模型调用或生产故障演练；HTML 排版验证只针对本报告。

## 2. 本轮已认可的整改

| 领域 | 判断与理由 |
| --- | --- |
| R25 回执合并 | 当前 `confirmedRecords` 同时保存 accepted 与 recovery-required 身份，合并旧账本时检查 fingerprint/Run/Session 冲突，而非任意覆盖确认。 |
| 目录恢复重试 | 已确认但目录待恢复的请求仍可沿原 requestId 重试；不会因“曾收到回执”而禁止必要恢复。 |
| scope 与错误归属 | 切换 scope 在本地 I/O 前撤销旧所有权；`errorOwner` 与 epoch 防止 A 的迟到响应抹去 B 的错误。 |
| 异步导航 | `onAccepted` 支持 Promise，组件返回真实导航结果；本地后处理失败与服务端受理事实分离。 |
| 既有主链路 | RunPlan v3 的命令描述符/适用性绑定、同库受理与幂等、目录就绪屏障、Credential/Provider 分层以及停用裸 clean 继续成立。 |

依据：[当前受理控制器](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/web/src/client/hooks/use-run-admission.ts)、[当前权威记录](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/docs/reviews/current.md)、[SessionService](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/core/src/session/session-service.ts)。作者记录的 2034 项本地通过及 148 项 Chromium 通过是作者验收证据；本轮独立核对了对应远端基线检查，没有把作者的截图或独立代理审阅写成本轮自己的执行结果。

## 3. R26-01 / P1：取消意图已记录，但 Job 未必收到

### 3.1 故障路径与影响

基线 `SessionService.requestCancel()` 的顺序为：

```text
Workflow CAS 写为 cancelled
→ 查找 Session
→ 若本次没有新写终态，直接返回
→ 写 agent/cancel-requested 事件
→ 查找活动 Job 并请求取消
→ 更新 Session 并写 agent/cancelled
```

若 Session 查询或事件写入在 Run CAS 成功后失败，执行控制还未送达 Job。若 Job 投递本身暂时失败，也会留下同样的分离状态。再次调用时，Run 已经是 cancelled，`written=false` 的早返回阻止补发。对于已经运行的 Job，这可能使数据库显示取消，但执行者尚未获得该取消意图。

依据：[基线取消实现](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/core/src/session/session-service.ts#L462-L535)、[幂等终态写入](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/core/src/workflow/state-machine.ts)。这是可复现的编排顺序缺陷，不是已观察到的用户生产事故，也不是认定所有取消都会失效。

### 3.2 修复：先投递控制，再更新观察

```text
Workflow 终态裁决
→ 若 passed/failed 已赢，保持原终态，不取消 Job
→ 若 cancelled 新写入或已存在，查找活动 Job 并重试取消投递
→ 然后处理 Session 观察
→ 重复请求仍不重复发出取消生命周期事件
```

复用现有 JobRunner 的 queued CAS 和 owned-job `cancelling/abortState` 协议，不增加新表、常驻协调器或通用事务平台。返回中可以保留本次找到的 jobId。先写 Workflow 的裁决顺序保留，避免取消与完成竞争时推翻终态赢家。

**具体关闭：**观察失败不能阻止先行 Job 投递；已有 cancelled 状态不能阻止显式重试尚未完成的投递。

**未扩大承诺：**没有把 Run、Job、Session 与事件全部改成一个事务；事件缺失仍可能留下，观察错误仍会向调用者报告。这里不自动修复所有历史 Session 状态，也不保证进程崩溃后无需重试便能补发，更不保证外部进程已退出。对于其他进程拥有的 Job，新增测试只证明持久取消请求已写入，不冒充实际跨进程终止验证。

### 3.3 验证

本地真实 SessionService 源码、受控端口的同组测试：**修改前 4 失败/2 通过，修改后 6/6**。它验证的是顺序、重试和终态裁决，数据库写入由受控端口模拟。

新增 `session-service-cancel-recovery.test.ts` 使用真实内存 SQLite、迁移、repositories、SessionStore 与 JobRunner，覆盖七项：事件写入故障、首次 Job 投递失败后重试、另一 owner 的持久取消请求、Session 查询故障、重复事件不增加，以及 passed/failed 两种终态赢家。测试不启动真实 Provider，也不声称模拟 owner 就等于启动了第二个 OS 进程。

## 4. R26-02 / P2：HTTP 成功不等于“运行已取消”

### 4.1 已确认的接口组合

`SessionService` 在 passed/failed 已先完成时返回 `terminalConflict=true`，`project.cancel` 返回当前真实 Run，并不将该竞争视为 HTTP 错误。这个服务端裁决正确。但 `RunControls` 忽略结果，无条件显示 `Run … cancelled`。用户看到的动作结果因此可能与服务端的完成或失败状态冲突。

依据：[服务端返回](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/web/src/server/api/routers/project.ts#L444-L459)、[原组件处理函数](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/web/src/client/components/runs/RunControls.tsx#L147-L160)。

### 4.2 修复与边界

| 实际响应 | 新反馈 |
| --- | --- |
| cancelled | 已记录取消；不代表所有后台进程已退出 |
| passed / failed | 已完成或已失败，未改为取消 |
| 其他意外状态 | 请求已返回，请核对最新运行状态 |
| RPC 抛错 | 保留原错误处理路径 |

本地调用真实组件处理函数、控制 Hook/RPC 端口：修改前四项失败，修改后四项通过。仓库新增五项 Vitest 断言，额外覆盖 RPC 失败。这是组件动作处理测试，不是浏览器焦点或辅助技术测试。

Node 官方明确区分信号成功发送与进程终止，`exit` 与 stdio 完全关闭也不是同一事件。因此 UI 不能从 HTTP 200 或数据库 `cancelled` 直接推导“全部后台活动结束”。参考：[Node Child Process](https://nodejs.org/api/child_process.html#subprocesskilled)。

## 5. 产品逻辑与 UI/UX

### 5.1 当前价值与阶段边界

受控 Deliver 已经有清楚的用户结果：确认需求和检查、发起带身份的请求、观察或查询同一个 Run、处理审批、再准备交付材料。当前应保留对“已受理”“目录就绪”“开始执行”“请求取消”“实际停止”的分别表达。本轮两个问题的共同原因不是按钮数量，而是用某一层成功代替另一层成功。

R25 的共享控制器和稳定回执值得保留。后续最小交互改进不是增加更多全局状态，而是提供可查的执行控制状态：例如取消投递失败时保留原 Run 入口和可重试说明。是否新增“取消中/已停止”字段，应由实际 Job/子进程证据驱动，不能先加绿色徽标再补执行语义。

### 5.2 主要页面检查结论

| 用户步骤 | 当前判断 | 后续验证 |
| --- | --- | --- |
| 凭据与 Provider 就绪 | 拆分后的分工成立，不再称为同步耦合未修复 | 实际首次安装、未安装 Provider、权限与代理错误的人类可理解性 |
| 计划确认与发起 | v3 绑定范围和共享受理流程成立 | 缺失/不适用检查很多时的信息层级；不要在普通路径堆叠原始 JSON |
| 回执与目录恢复 | 新控制器已保护确认事实和原身份 | 保持多请求错误归属，不把存储或导航错误解释成服务端回滚 |
| 运行与取消 | 本轮修正投递顺序和假成功提示 | 真正的执行/取消/退出三段证据与跨进程故障 |
| 历史与交付 | 观察页有用，完整导出仍是独立能力 | 只读证据包、完整性清单及敏感信息处理 |

本轮 UI/UX 是源码与交互合同评审，不是新的截图式视觉审计。已有四宽度截图和作者浏览器证据可用于复查其声明，但不能被本轮重复计作新测试。取消反馈仍复用已有 Flash 系统；没有在此次补丁中改变焦点、定时消失或读屏策略。

对辅助技术，应按 [W3C 状态消息说明](https://www.w3.org/WAI/WCAG22/Understanding/status-messages) 检查不转移焦点的状态通知能否被程序识别；这只是后续验收依据，不能仅凭文字修复宣称全站无障碍通过。

## 6. 整体框架、数据与实现

### 6.1 一个被复核排除的疑点

只读 `GateEngineRunInput`、`runCommandGate` 和 fallback Engine，会发现它们没有显式转发 signal/registry。若据此认定 Web 的 Gate 取消断链，结论是错误的：真正后台入口 `createWorkflowJobExecutor.buildEngine()` 将 gateway 包装为每次调用统一注入 `registry`、`registryKey=runId` 和 `input.signal ?? ctx.signal`，并把同一个 gateway 传给 Agent、Gate 和 Worktree。

依据：[真实后台组合根](https://github.com/zesming/tekon/blob/1e277464dbf9eeb9f97620421405d7a5913bc067/packages/core/src/session/workflow-job-executor.ts#L99-L151)。本轮撤回该主路径疑点，转而修复真正发生在它之前的 SessionService 投递边界。不要只依据过时注释或局部类型做架构判决。

### 6.2 应当保留的机制

同库 admission、请求意图哈希、目录后置恢复、v3 有效命令绑定与历史兼容，分别对应数据库原子性、客户端重试、文件侧失败和执行配置漂移，不是为了抽象而抽象。它们与后续进程终止是不同验收范围。不得因为发现取消缺陷就倒推“启动事务无效”或“RunPlan 全部不可信”。

JobRunner 已有排队 Job 条件取消、owned-job 持久取消状态和 owner 轮询传播。当前应优先使用这些事实，而不是在服务层复制另一个终止协议。状态观察和实际控制的耦合值得逐步消除，但本轮不强制全域事件溯源或平台化 outbox。

### 6.3 剩余范围及优先顺序

1. **执行生命周期实测。** 选一个真实 Provider，用同一个 Run 验证执行、用户取消、确认退出、关闭和重启恢复；注入事件写失败、Job 更新失败、owner 变化和控制端断开。检测实际存活进程与文件写入，不只看状态徽标。
2. **取消恢复的一致观察。** 本补丁先保证控制投递；历史 Session/event 缺失的补偿、崩溃后的自动重试和 UI 可重试入口仍应单独设计，避免从“再调接口有效”扩大成自动恢复保证。
3. **只读完整导出。** 在恢复物理删除前，提供 Session、Artifact、Gate、Audit 的有界服务端导出和清单。现有 clean 停用保持，不把本轮变为生命周期清理项目。
4. **持续协作按产品场景推进。** 第二条输入、运行中语义更新和 restart resume 需要真实 Provider 支持；不将整个协作里程碑变成本次小修复的前置条件。

## 7. DeepSeek Harness 官方对照

2026-09-05 查询官方 releases，最新发布仍为 **`dsh-v0.1.3-alpha.1`**（2026-09-04 11:34:32 UTC 发布）；Tekon 当前声明的 tested pin 保持 **`0.1.2-alpha.3`**，本轮没有升 pin 或运行真实模型请求。

- [发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)包含 SessionHandle、Session 单写者锁及存储格式变化。对 Tekon 的启示是生命周期需要可观察的所有权；DSH Session 锁不自动覆盖 Tekon Git、Worktree 或所有外部命令。
- [Headless 合同](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/README.md)仍是一项任务一次调用，reasoning 进入 stderr，最终回答进入 stdout，随后退出。保留 Goal/一次性边界合理，不能把它当作多轮会话实现。
- [ACP 合同](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/acp/acp/README.md)提供持久 Session、标准语义更新、prompt cancel 与 close，明确将取消、更新排空、持久化和资源释放纳入关闭语义；但不提供 raw provider deltas、旧更新重放或完整 transcript replay/fork。可先验收一条最小真实链路，而非直接承诺完整会话产品。
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/SAFETY.md)仍明确项目未经安全审计。权限和 sandbox 不是唯一安全控制；精确 pin、metadata probe 或合成回归通过都不是生产安全证明。

## 8. 过度实现与过度设计判断

当前最需要克制的是继续叠加新的“状态权威”。本轮缺陷可以用现有 JobRunner 协议加正确顺序、现有 RPC 结果加正确反馈解决，不需要新状态表、通用取消框架、全局注册中心或第二个事件总线。

共享回执控制器已经较复杂，但 scope、请求身份、服务端回执、本地存储和异步导航确实存在不同寿命，不能按行数断言过度设计。继续加分支前，应先明确每类事实的来源及不变量，用少量代表性时序覆盖；只有共享测试夹具确实重复时再抽取，不建立另一个测试 DSL。

新增 Core 测试使用真实 SQL，Web 测试执行实际处理函数，两者验证不同边界；本地受控复现作为诊断证据，不计入仓库测试总数。HTML 人审版来自同一 Markdown，不新增独立“当前裁决”。大型 PR 的迁移和耦合风险也不能通过 squash 自动消除；后续应按可独立回滚的行为切片推进。

## 9. 验证记录与交付边界

| 层级 | 已做及不能外推的范围 |
| --- | --- |
| 本地取消故障复现 | 真实 SessionService 源码，受控数据库/Job/事件端口；4 失败/2 通过 → 6/6。不是 SQLite 集成。 |
| 本地反馈复现 | 真实 RunControls 处理函数，受控 Hook/RPC；4 失败 → 4/4。不是浏览器生命周期。 |
| 仓库新增测试 | Core 7 项真实 SQLite/JobRunner 测试；Web 5 项处理函数测试。 |
| 静态检查 | 四个源/测试文件 TS 转译语法检查；原始源码和远端 blob SHA 核验；差异检查。 |
| 完整集成 | 由本次代码 SHA 的 Core/CI 及最终文档 SHA 对应检查证明，不冒称本地全仓通过。 |
| 未执行 | 新应用截图/读屏、Windows、真实 DSH L2/L3、生产负载与跨机器崩溃演练。 |

代码提交的 Core #445 与 CI #354 均 completed/success。Core 单测 99 个文件、1343 通过/1 项既有条件跳过，Core e2e 10 个文件、43 通过；Web 单测 57 个文件、572 通过。新增 Core 7 项与 Web 5 项在远端日志中逐项可见。完整 CI 包含四档 Node、CLI、Web、Chromium 与生产依赖审计；文档最终 Head 仍单独检查。

修复属于尚未合并的 v0.23.1；没有新命令、参数或安装流程，因此不另发版本。已检查 README/手册的受理与取消边界：原入口和操作步骤不变，本轮细化见本报告；不重复改写其主流程。安装脚本、协作规则与 AGENTS 未变；本补丁的修复摘要集中记录在此正式报告及 PR，不向 CHANGELOG 追加另一份复审过程。没有合并、发布、部署、强推、清理用户文件或修改仓库规则。

**交付判断：本轮两处具体缺陷已修复并通过代码提交集成回归，未再确认必须阻断本次增量的新问题。最终文档 Head 仍需成功检查；不将未验证的真实进程终态或完整持续协作写成已通过。**
