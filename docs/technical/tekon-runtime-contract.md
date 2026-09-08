# Tekon 运行时与 Harness 集成合同

2026-09-08 · 当前版本以根 `package.json` 为准 · 状态：现行维护合同；验证结果见[正式审阅入口](../reviews/current.md) · [文档总索引](../README.md)

本文归并已落地的计划受理、Session/Job、运行控制和 Provider 边界。产品范围见[产品说明](../product/tekon-current-product-scope.md)，操作见[手册](../manual/tekon-user-manual.md)。规范描述预期不变式，不以本文代替发布验收。

## 1. 执行入口与事实源

CLI/Web 通过 `SessionService` 和默认 workflow executor 共享运行语义；workflow-run、workflow-resume、goal-run 属于运行执行 Job，readiness/delivery 等 automation 属于独立操作域。控制一个 Run 时不得误伤其他 Run；恢复时比较新旧执行 Job，不将 automation 算作该 Run 的旧执行。

`workflow_instances`、Node/RoleRun、`jobs`、Artifact、Gate、Audit、Delivery 等持久领域记录是相应事实源。`session_events` 是观察投影；新 Session 的三个开场事件具有下述原子保证，后续事件按尽力交付处理，可能缺失。Event Bus 通知失败不能推翻已持久化领域结果。

Profile 只改变允许的策略，不替代安全权限。`autonomous-delivery` 只在长驻服务中自动准备已通过运行的材料；远端写仍需显式批准。内置 Goal 模板仅豁免必须包含 reviewer 节点的要求，其他治理约束仍生效；普通 Deliver 模板不适用此豁免。

角色目录中的 `tools.yaml` 与 `permissionProfile` 主要用于 prompt summary、顶层命令策略和界面提示；workflow helper 使用的 `defaultCommandPolicy` 也不等于 Provider 内部工具的执行沙箱。CommandGateway、工作树、顶层 human gate 和 delivery 审批只覆盖 Tekon 管理并能观测到的动作；当前测试验证的是编译结果和顶层调用路径，不能据此宣称阻断 Agent 在 Provider 内部自行执行 `git`、`gh` 或其他外部工具。OS 隔离、网络出口和所有外部副作用仍是独立风险边界。

Claude workflow 将 `commandPolicy` 与 Provider `permissionProfile.tools` 相交，Tekon 仅为双方允许的以下精确命令新增免审批规则：`npm test`、`npm run test/build/lint/typecheck`，对应的 pnpm 直接命令与 run 形式，以及 `git status/diff/log`。这里斜线表示分别列出的命令，不是通配授权；这些规则不自动涵盖额外参数。Claude 内置只读规则与宿主权限配置仍可能独立批准其他命令。显式 deny 继续拒绝，`requiresHumanApproval` 转为 Claude 原生 ask；当前没有将原生 ask 接到 Web 人工决定的桥，遇到未获准命令可能失败或等待至超时。自定义 args 不得覆盖权限模式、工具规则或额外目录。获准脚本仍能执行仓库代码；该配置不提供 OS、网络或子进程隔离。角色 `tools.yaml` 仍只作为节点提示，不等于这些运行时规则。

资料事实：Claude 的 `acceptEdits` 不自动批准普通 shell 命令，headless 支持显式工具授权；内置工具与 MCP 分别配置。参见 [程序化执行](https://code.claude.com/docs/en/headless)、[权限规则](https://code.claude.com/docs/en/permissions)和 [CLI 参数](https://code.claude.com/docs/en/cli-reference)。上述有限候选交集是 Tekon 的实现选择，不是 Claude 提供的完整沙箱。

### 1.1 已归并的架构决策

| 决策 | 当前合同 |
| --- | --- |
| 执行权威 | CLI/Web 可各自运行 Runtime；SQLite owner fence、状态 CAS 和 Git expected-old OID 只保护各自覆盖的写入。single-owner daemon 仍是演进方向，不是当前部署前提。 |
| Session 事实源 | 持久 Run/Node/Job/Artifact/Gate/Audit/Delivery 是领域事实源；`session_events` 只做观察投影，完整模型历史、durable inbox 和全域 outbox 尚未实现。 |
| Harness 接入 | headless 只用于 experimental Goal；SDK 与 ACP 是不同控制面，不能把 SDK 的初始化/提示接口解释成持续协作或完整权限合同。 |
| 高风险动作 | push、创建 PR、合入、上线及权限扩大保留人工控制；Gateway 与角色提示不能扩大为 OS/provider 沙箱。 |
| Collaborate 与导出 | follow-up、steer、持续会话恢复和完整导出仍在独立工作项中，不能由 Session feed、分页或新接口名称推断已完成。 |

PMO 的流程检查点提示将已通过或跳过的可见 Gate 结果以 JSON 提供，包含持久记录中的 nodeId、gateType、gateKey 和 status；模型必须逐字复制稳定 key，缺失时登记 missingInformation，不能重构或缩写。process-completeness 仍按真实节点、产物与 Gate 状态精确验证。QA 的 AC 证据继续使用 gateResultId，不能与 gateKey 混用。

Provider 子进程成功退出与产物导入成功分开判断。manifest 缺失、格式/schema 不合法和必需产物缺失必须保留可诊断的失败原因，沿既有 Agent 失败事件与节点审计传播；诊断采用受控摘要，不回显完整产物或解析器携带的输入值。严格导入、超时与取消判定保持原有语义，不自动修补 JSON 或绕过 Gate。格式提示只能减少生成错误，不能保证模型输出合法。

## 2. RunPlan v3 与检查绑定

[run-plan.ts](../../packages/core/src/workflow/run-plan.ts)保存完整模板、workflow/goal 模式、Provider/确认上下文及受模板引用的仓库命令描述符。v3 追加 `repoCommands`，记录来源、命令、适用性或缺失决定；模板内联命令优先，无 commandRef 的模板不依赖未使用的仓库配置。

canonical JSON 只排除顶层 digest，保留嵌套同名字段；顶层 input/options/plan 摘要必须一致；不一致时，在产生任何运行目录、DB 或 Audit 副作用之前拒绝该计划。恢复验证持久计划、模式、完整性与允许派生的修复/返工节点，不能仅校验模板名称。

Web 公开预览只返回可审阅摘要，以及每项检查的来源与计划执行或跳过方式，不泄漏原始命令、args、env 或不适用理由。逐项比较只在同服务实例及同上下文有效；配置变更需刷新后重新确认，不自动接受新 digest。

| executionBinding | 合同 |
| --- | --- |
| frozen | 有效 v3，执行/恢复/修复/返工使用受理时检查记录，执行前仍做完整性校验 |
| legacy-unbound | v1/v2/无快照兼容路径；commandRef 仍解析当前配置，v2 内联命令保持已存模板值；不自动升级 |
| invalid | 记录无效，拒绝依此执行，保留原 Run 供核查 |
| unknown | 暂不可读或无法识别，不宣称冻结；由服务端继续校验 |

绑定不冻结 package scripts 正文、测试代码、PATH 二进制、依赖和宿主环境。要使用新检查配置，应明确发起新任务。

## 3. 原子 Admission 与请求账本

[admission-store.ts](../../packages/core/src/db/admission-store.ts)以物理仓库作用域、Request ID 和规范化意图摘要识别请求。意图包含需求/引用、模式、模板、Profile、Provider、超时、脏工作区与网络确认等显式参数，实现不得用白名单静默丢弃意图字段。Request ID 为 8–128 个字符，由 ASCII 字母、数字、下划线或短横线组成。

Run 领域记录、必需治理 Audit、Session、`session/created` / `workflow/started` / `user/message`、初始 Job 和请求记录在同一 SQLite 事务提交；失败全回滚。相同身份和意图重试返回原 Run/Session/Job，不重复开场事件；意图不同返回 `REQUEST_ID_CONFLICT`。常规 Audit 追加也在事务内分配单调时间，并将上一条记录的 hash 写入新记录的 prevHash，避免多连接追加分叉。

目录准备在事务后执行，`filesState` 为 pending/ready/recovery_required。只有 ready 的初始 Job 可认领；已受理不等于已执行。目录恢复沿用原身份和初始 Job，不复活 cancelled/passed/failed。查询仅观察，不负责修复文件；原请求重试或服务启动恢复处理文件准备。

浏览器侧另有请求账本，保存在当前标签页 sessionStorage，按物理仓库与凭据指纹隔离，仅存作用域/意图指纹、requestId 和受理状态，不存正文或 token。认证 token 由独立认证功能保存。未知结果保留原身份，not-found 不是未受理证明。已经收到确认后，本地记录或导航失败不能撤销确认；页面保留原 Run/Session 入口。存储不可用或账本损坏在 Run 请求发出前阻止提交。

## 4. SQLite owner fence 与关闭

[JobRunner](../../packages/core/src/session/job-runner.ts)原子 claim queued Job，续租并以 owner/status 条件更新 checkpoint/settle。生产执行链通过 AsyncLocalStorage 把 Job/owner 作用域带入 [WriteQueue](../../packages/core/src/db/write-queue.ts)，[withOwnedWrite](../../packages/core/src/session/session-store.ts)在同库写事务中复核所有权再执行同步持久化写。失去 owner 或离开允许状态的旧执行无法写入该作用域保护的领域表。进程内 token 额外隔离本地执行代次。

事件订阅者启动独立 automation 操作，不继承发布者租约；否则原 Job 完成后，其租约不再允许写入，会错误阻断后续 readiness/delivery 投影。租约过期的已认领 Job 转 interrupted，不自动重放 Agent/Gate；queued 未认领路径独立处理。

关闭顺序为停止新轮询/claim、等待在途工作、超时 abort 与终止受管理进程，再进行有硬上限的 drain。JobRunner.stop 在硬截止时间后中断未结算执行、清理本地执行 token 并返回；单独调用 stop 不关闭写队列。CLI/Web 组合根在 runner.stop 返回后、关闭 SQLite 前调用 db.markClosed() 设置 closed 栅栏，再调用 db.close()；WriteQueue 通过 isClosed 检查拒绝迟到写入。硬超时和 closed 栅栏都不是物理退出证明。

CLI/Web 仍可各自运行 Runtime；这不是 repo daemon 独占锁。SQLite 写 fence、状态 CAS 和 Git expected-old OID 各有范围，不能保证 OS 逃逸进程、任意文件写入或所有外部副作用都被物理隔离。旧文档“没有持久写 fencing”的判断已过期，“全副作用 fencing 已完成”的判断同样不成立。

## 5. 暂停、取消与退出证据

暂停记录 Run/Job 控制意图，活动 Agent/Gate 可继续至检查边界；回执不是即时进程冻结。初始 queued Job 被认领时若 Run 已暂停，认领方跳过 Agent/Gate 并将该 Job 结算为 done，Run 保持 paused。恢复若赶在认领前，可在原子入队事务内复用仍 queued、属于该 Run 的原 Admission Job 并解除暂停。事务必须同时复核 Run 非终态、原 Job 身份与状态；若原 Job 已结算为 done，则走正常恢复入队，若已有活跃 owner 则返回 active-job。禁止依据事务外旧读取返回已 done 的 Job，也不得产生两个活动执行 Job。

取消先以终态 CAS 记录持久意图，passed/failed 赢家保持原结果。控制投递失败保留同 Run 重试入口，并由分批巡检补发；巡检游标到末尾后从头继续，单项失败不阻塞后续项；取消生命周期事件与 Session 状态在同库事务内协调，不重复追加已有事件。API 回执分别报告取消已记录、投递/观察待恢复及终态竞争，不宣称所有进程停止。

| Job exitEvidence | 证明范围 |
| --- | --- |
| never-started | 新版入队/Admission 原子记录的未开始事实；claim 原子清空；不能从历史 queued 推断 |
| managed-handles-closed | 生产执行 Promise 已排空，且该 Job scope 的全部受管理句柄已收到 close |
| null/缺失 | 未确认；历史 abortState=stopped、租约过期、kill 返回或 unregister 都不补造证据 |

Registry 按 Job scope 隔离，旧代 close/kill 不污染新代。退出证据只覆盖 Tekon 管理的句柄；人工检查确认写 Audit，不伪造物理退出证据。

## 6. 显式恢复与代次确认

`enqueueIfNoActiveByRunId` 在 `BEGIN IMMEDIATE` 内复核 Session→Run、Run 终态、最新执行 Job、确认身份和活动 Job，再完成恢复状态交接与入队。queued 复用是同一事务中的特例。执行 Job 按 createdAt/id 稳定排序，新代创建时间严格晚于前代，automation 不参与代次。

| 返回结果 | 行为 |
| --- | --- |
| enqueued | 已受理新 Job，或复用符合条件的初始 queued Job；不证明模型已开始 |
| active-job | 已有 queued/running/paused/cancelling 执行 Job，不重复入队 |
| terminal | passed/failed/cancelled 不可复活 |
| exit-unconfirmed | 旧执行退出未知，需检查并显式确认 |
| stale-confirmation | previousJobId 已过期，刷新后重新确认 |

历史 interrupted 无 Job 时需显式 `previousJobId=null`；CLI 使用字面 `none`，不能用省略代替。人工确认必须同时带 confirmStopped 和当前 previousJobId。恢复权交接收敛遗留 running Node/RoleRun 为 interrupted，保留 worktree 与已完成 Agent 证据；已完成 Agent 的待执行 Gate 从 Gate 位置继续。

正常关闭宿主在首次 Gate 执行中打断命令时，保留已完成 Agent、原工作树和 awaiting-gate 节点，Run 记 interrupted；显式恢复只继续 Gate。关停或取消信号优先于迟到的成功/失败结果，不因此启动修复、耗尽重试或提交工作树。被终止的 Gate 尝试可以保留 failed 结果，以 `gate.execution.interrupted` 关联停止原因；它不等于一次真正的质量失败。

返工后重新执行 reviewer 时，其工作树保留至该节点全部 Gate 通过，再由 NodeExecutor 统一提交释放。修复意图刚写入而原工作树仍有效时，优先使用经校验的原租约。自动修复已完成后的 Gate 中断，通过同 Run 的最后修复意图、失败 Gate、确定性修复节点及工作树租约恢复关联；后续重新执行原节点创建的租约优先于历史修复。真实 Gate 执行前必须找到合法的活动工作树；错误关联、歧义或缺失证据明确阻断，不回退主仓库。

若关停发生在工作树已提交释放、节点尚未完成的窗口，只有该次执行完整的 promoted→released 审计证据才允许完成收尾；不承诺撤回已经完成的 Git 写入。修复执行本身未完成时保留实际未完成状态，不承诺跳过 Agent。

原节点从 blocked/interrupted 重跑 Agent 时，复用同 Run、节点和角色的未释放直接租约，保持工作树、分支、baseHead 与未提交修改；repair alias 不作为原节点租约复用。直接租约的缓存与冷恢复均校验唯一性、角色及最新创建事件标识，冲突明确失败，不自动挑选或释放旧租约。CLI 以 Job 终态和 Run 状态共同决定退出码，failed/interrupted/cancelled Job 即使留下 running Run 也返回非零并给出日志入口。

普通修复 Agent 异常与关停分别处理：原有提交释放流程成功且仍有重试预算时，从当前 Run 分支为原节点创建新工作树，再进入 awaiting-gate 执行复查。新工作树已创建、节点仍为 needs-revision 时，只有最新 Agent 已完成、租约属于原节点，且该租约创建事件晚于最后修复失败与最后修复意图，才恢复为 Gate checkpoint；后续修复意图会撤销该资格。复查通过即可正常收尾，失败则继续剩余修复预算；该复查被关停后，新引擎沿持久租约恢复 Gate。工作树提交或释放失败保留真实错误并中止，不吞掉异常后继续，也不开放主仓库回退路径。

Web/CLI 审批后恢复共用守卫：能预见退出风险时不写审批；审批写入后发生竞争时返回“审批已记录，运行尚未恢复”，不谎报审批回滚或执行已开始。Run 详情和 Session 用同快照 `getRunRecovery` 展示取消与恢复状态，不从缺失 SSE 或无活跃 Job 推导退出。

## 7. Session 观察合同

事件携带 schema version、sessionId、单调 seq、时间、payload、visibility/modelVisible 和可选关联来源。未知事件可忽略；`modelVisible: true` 表示该事件可进入模型上下文，不保证模型实际看到了完整历史。legacy adapter 将一次 `runAgent` 映射为一个 Step，合成 Tool 与 Artifact 摘要；DSH 使用官方最终 assistant 文本。当前不是逐块模型原文 streaming，不支持 followUp/steer 或持续会话恢复。

SSE 使用 token 鉴权和物理仓库 scope，先订阅后回放，按 sinceSeq/Last-Event-ID 去重追平。在线回放有界，超预算明确告知切换最近记录；历史仍可分页。首连/重连及治理变更触发领域快照刷新，迟到响应不能覆盖新状态。分页、事件 replay 和 API 字段不代表完整导出、durable inbox 或权威上下文重建。

## 8. DeepSeek Harness 集成与上游资料

事实基线：上游源码核对至 [d347e703](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215)。GitHub 已有 [0.1.3-alpha.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，截至 2026-09-06，对应 npm 查询返回 E404；源码、GitHub Release、可安装发行包是不同证据。Tekon tested CLI pin 保持 `0.1.2-alpha.3`，其内部包依赖使用 `^0.1.2-alpha.3`，固定顶层 CLI 版本不能锁定整棵依赖树。

资料事实：[headless 参考](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.3/apps/cli/reference/README.md)提供一次 task、最终 stdout 及 stderr 日志；[SDK application profile](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/bundle/sdk-app)暴露 initialize、session/prompt、shutdown，不提供 cancel、session/close 或权限问答合同；[ACP profile](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/bundle/acp-app)是不同控制面，不能将其 Session 能力归给 SDK。

对 Tekon 的推断：现有 AgentAdapter 的一次性边界适合 experimental Goal-only headless，不足以承担持续协作。SDK/ACP 应独立比较控制、事件、恢复、权限与生命周期后做真实纵向验证，不能由新增接口或源码同步推断兼容完成。

运行护栏：DSH 默认关闭，网络出口不受限，需显式知情确认；preflight 与正式 Run 关闭内置 telemetry。内置 metadata probes 使用临时 cwd、DSH_HOME/DSH_AGENTS_HOME 和最小环境，完成后清理；正式 Run 使用精确白名单。它们不是 OS sandbox，同 UID 二进制仍可能读宿主文件，正式 Run 的 worktree .env、代理和凭据来源需要独立评估，参见上游 [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md)。

DSH 要求 Node `^22.19.0 || >=24.0.0`，Tekon 主合同为 `^20.19.0 || >=22.12.0`，两者不能混用；Tekon preflight 对不满足其 DSH 宿主策略的版本先行拒绝。兼容性升级按 [#17](https://github.com/zesming/tekon/issues/17)保存实际完整依赖树/lock、包来源和 integrity，再做 Wrapped L2 与真实模型 L3；跳过 preflight 版本检查不等于受支持的升级路径。

## 9. 验证与过程文档归档

验证需覆盖受理回滚/并发重试、计划漂移/历史兼容、取消补偿/终态赢家、真实 SQLite 多连接 owner 竞争、Job scope 退出、确认过期/无 Job、queued 暂停的认领交错以及 CLI/Web 恢复。真实进程用例证明执行与退出边界；真实 Provider 交付还需 Artifact、实际 Gate、同 Run 中断恢复、Audit 和 eval，不以 mock 代替。

已完成过程计划迁移映射：阶段 1–4 的 Session/Job/治理合同归入 §1–7；阶段 5b 的 Provider 边界归入 §8；后续 Admission/RunPlan 与 R26 生命周期整改归入 §2–6。旧 roadmap 中尚未实现的持续协作、导出和平台隔离归入[产品边界](../product/tekon-current-product-scope.md)，不能因删除过程文件标成已完成。旧过程方案与报告可从[基线 86a3d48 的 docs 目录](https://github.com/zesming/tekon/tree/86a3d48/docs)和 Git 历史检索，正式 reviews 保留原证据范围。

### 9.1 历史方案迁移对照

| 已清理的旧入口 | 仍适用内容 | 现行入口 |
| --- | --- | --- |
| `tekon-v2-technical-plan.md/html` | 角色、Workflow、Gate、Artifact、Worktree、CLI/Web 的早期架构词汇；其中未来计划和权限承诺已失效 | 本合同 §1–§7；用户操作见[手册](../manual/tekon-user-manual.md) |
| `tekon-web-architecture.md/html` | Sessions/Advanced 信息责任、路由与证据导航的设计输入 | [运行控制设计](../design/tekon-run-control-design.md)；本合同 §1、§7 |
| `tekon-replatform-current-scope.md/html` | 阶段完成标签不能替代真实能力，Session feed 不是权威日志 | 本合同 §1、§7；[产品范围](../product/tekon-current-product-scope.md) |
| `adr-0001-runtime-authority-and-collaborate.md/html` | SQLite owner fence、关停、headless/SDK/ACP、Collaborate 递延的修订结论 | 本合同 §1.1、§4–§8；[产品范围](../product/tekon-current-product-scope.md) |

删除旧入口只减少重复正文，不删除固定快照、正式验收证据或截图资产。新结论必须先更新本合同、产品范围、设计或手册，再由 Git 历史承载过程讨论。
