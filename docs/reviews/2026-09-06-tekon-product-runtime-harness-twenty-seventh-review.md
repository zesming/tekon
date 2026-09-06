# Tekon 第二十七轮复审：排队暂停与执行恢复

**2026-09-06 · v0.24.0 → v0.24.1 · [原 PR #11](https://github.com/zesming/tekon/pull/11)**

| 核验对象 | 固定快照 |
| --- | --- |
| 用户整改基线 | `f0c007b791d1da0f0f3b45b7b81718a905e760aa` |
| 上轮实际交付 | `9c64fe890fa45e22929c364ae954aa443c501e40` |
| 本轮代码修复 | `7bbb9ff27a2fb18814916e077de0edcd7f836e1a` |
| 基线检查 | [Core #449](https://github.com/zesming/tekon/actions/runs/34003336134)、[CI #358](https://github.com/zesming/tekon/actions/runs/34003336135) 均成功 |
| 修复检查 | [Core #450](https://github.com/zesming/tekon/actions/runs/34005898445)、[CI #359](https://github.com/zesming/tekon/actions/runs/34005897725) 均 completed/success，九个 CI Job 全部成功 |
| 文档自身 Head | 最终 PR 描述独立记录其 SHA 与 Checks，不复用代码提交的绿色 |

## 1. 结论与范围

**v0.24.0 的取消补偿、退出证据、过期执行处置和恢复确认是实质整改。本轮另确认并修复一处 P1：已暂停但尚未认领的初始 Job 仍可能执行。修复同时保留显式恢复原排队 Job 的语义，并防止它覆盖终态赢家。**

本轮不再重复报告已关闭的 RunPlan v3 命令绑定、原子/幂等受理、目录就绪屏障、共享回执控制器、Credential/Provider 分层、裸 clean 停用，以及此次已落地的取消观察修复。持续协作未开放，不构成本次补丁天然不合格的理由。

检查从远端提交和全部增量清单出发，覆盖产品/手册、SessionService、JobRepository、JobRunner、默认执行器、Workflow/Node/Gate、网关与注册表、写入队列、审批路由、运行控制与确认 Hook、既有测试和正式验收材料。属于全仓结构及关键高风险调用链审查，不宣称逐行证明所有源码、所有生产场景。

**证据分级：**代码事实、定向执行复现、远端集成、作者归档实测和建议分别表述。本地 DNS 不可用，无法安装全仓依赖，未执行本地完整 `pnpm test --run`；定向测试使用经过 Git blob 核对的真实源码和受控端口。无独立 subagent，本轮进行了二次自检，但不称为独立审阅。没有重新启动应用做截图审计、真实读屏、Windows、模型调用或负载演练；报告排版验证不是应用视觉验收。

## 2. 对 v0.24.0 整改的逐项裁决

| 领域 | 裁决及依据 |
| --- | --- |
| 取消观察恢复 | 认可。Session 与缺失取消事件在同库事务内协调；事务失败不留下半对事件，原事件保留，完整状态不反复改时间。见 [run-recovery.ts](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/session/run-recovery.ts)。 |
| 后台补发 | 认可。现有轮询中有界扫描、逐行失败隔离并推进游标，后续绕回重试，避免坏记录永久挡住后面候选。不是新增第二套取消平台。 |
| 过期租约 | 认可。已认领执行转为 interrupted，而非自动重跑；持久 job/status 通知使在线观察者能刷新。租约失效没有被误当作旧进程退出。 |
| 退出证据 | 认可已声明范围。登记键为 Job；生产执行器排空且其管理句柄实际 close 后才产生 managed-handles-closed。kill、unregister、人工确认和旧 stopped 均不能独自产生同等证据。 |
| 恢复确认 | 认可。事务内复核最新执行 Job，确认绑定上一代 ID；历史无 Job 要求显式 null/CLI none，过期确认不能授权新代次。见 [session-store.ts](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/session/session-store.ts)。 |
| 迟到数据库写入 | 认可。写入队列在实际操作处应用 owner 检查；独立事件订阅者明确退出发布者执行作用域。不能继续写成“完全没有执行者 fencing”。见 [write-queue.ts](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/db/write-queue.ts)。 |
| 审批与恢复 | 认可正向整改。审批决定与后续恢复的结果分开回执，终态竞争不把取消赢家重开；确认 Hook 按 Run/Job 比较而非仅靠滞后 effect 重置。 |
| 真实 Provider | 认可作者新增的有限实测，而非继续声称“没有任何真实证据”。其适用范围见第 6 节。 |

上述机制的故障、并发、回滚、公平性及跨进程用例可查 [run-recovery.test.ts](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/__tests__/session/run-recovery.test.ts) 和 [run-recovery.e2e.test.ts](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/__tests__/session/run-recovery.e2e.test.ts)。本轮修复后的 Core e2e 继续执行并通过了这六项真实 OS 进程用例。

## 3. R27-01 / P1：初始 Job 不应把持久暂停当作自动恢复

### 3.1 已确认的调用链

基线的行为如下：

```text
Run 已受理，初始 Job = queued，尚无执行 owner
→ requestPause 将 Run CAS 为 paused
→ JobRunner.requestPause 只更新 running/paused Job，queued 保持原样
→ claimNext 可认领非终态 Run 下的 queued Job
→ 新 owner 没有收到此前的内存 pause flag
→ workflow-run / goal-run 无条件进入 executePreparedRun
→ Node 可以开始执行
```

依据：[SessionService.requestPause / resumeRun](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/session/session-service.ts)、[JobRunner.requestPause](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/session/job-runner.ts)、[初始执行分派](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/session/workflow-job-executor.ts)、[Engine 节点边界](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/core/src/workflow/engine.ts)。

这不是“暂停当前进程是否立即生效”的争议。复现固定在**暂停先完成，Job 随后才被认领**，用户已经撤回了开始后续工作的意图，系统却仍可能发起模型和文件副作用，因此定为 P1。

### 3.2 局部修复及配套恢复

初始 `workflow-run` / `goal-run` 分派前读取持久 Run：若已经 paused，沿用既有 paused 结算路径，不调用执行方法、不创建 RoleRun、不开始 Agent。Job 结束的是本次投递，Run 仍是 paused，不伪造为交付成功。

单做这一点还不够。既有 `resumeRun()` 对尚未认领的原 Admission Job 只返回原 ID，并不清除 Run 上的暂停。因此同步补齐：**明确请求恢复该原 Job 时，只 CAS paused → running，并复核并发终态。** 若 cancelled/passed/failed 已赢，返回其真实终态；不创建替代 Job，不覆盖赢家。

两种正常路径分别为：

```text
暂停 → 初始 Job 先排空但不执行 → 显式恢复 → 新执行 Job 继续原 Run
暂停 → 在认领前显式恢复 → 解除暂停 → 原 Job 执行，不多建 Job
```

修复：[代码提交](https://github.com/zesming/tekon/commit/7bbb9ff27a2fb18814916e077de0edcd7f836e1a)。没有新迁移、状态表、暂停服务或通用调度框架。

### 3.3 测试先行与边界

真实源码、受控端口的同一组本地测试：**修改前 4 失败 / 4 通过，修改后 8/8**。覆盖 workflow/goal 首次分派、原 Job 恢复、终态竞争，并保留普通运行、明确 resume、未知 Job kind 和已终态路径。

新增仓库 [queued-pause.test.ts](https://github.com/zesming/tekon/blob/7bbb9ff27a2fb18814916e077de0edcd7f836e1a/packages/core/__tests__/session/queued-pause.test.ts) 共 **6 项**：使用真实 SQLite、Admission、JobRunner、默认 Workflow Executor 和真实 Git 工作树；模型端显式 mock，未替换 engineFactory。验证暂停时 RoleRun 为零、Run 仍 paused、Session 为 idle；恢复后执行一次；queued 原身份不变；三种终态竞争均不被覆盖。六项已在远端 Vitest 实际运行并通过。

该修复不声称任意指令时刻的暂停都是原子中断，不保证活动命令被物理挂起，也不覆盖独立直接调用 Core Engine 的所有并发场景。活动节点仍按原来的节点边界策略停下。后续应以具体交错测试扩大证据，而不是把这一个补丁描述为全部控制竞争已关闭。

## 4. 产品逻辑与 UI/UX

### 4.1 已形成的人类使用价值

当前默认产品仍是受控 Deliver：需求/草案、计划确认、绑定检查、隔离执行、Gate/Artifact/Audit、审批和 PR 准备。可靠受理、查询原请求、本地失败不推翻回执、退出未知时显式确认，使用户不再只能“提交后等待一个成功/失败”。[README](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/README.md) 对完整交付与轻量协作、合成 feed 与模型原文、绑定描述符与宿主环境的区别保持明确披露。

v0.24.0 又把取消意图、Job 投递、观察修复和退出证据分开。这个方向应保留，不能重新把数据库里的 cancelled 解释为全部资源已经退出。

### 4.2 R27-02 / P3：暂停和恢复的反馈可以更精确

[RunControls](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/web/src/client/components/runs/RunControls.tsx) 的暂停/恢复 Toast 仍使用 `paused` / `resumed`。暂停是节点边界控制；恢复接口可能只是接受原排队 Job，并不表示模型已经启动。

建议与本轮取消反馈统一：暂停显示“暂停请求已记录，活动步骤将在边界停下”；恢复显示“已受理恢复，请观察原运行”。真正状态继续从服务端快照读取。这是低优先级信息表达建议，不是另一个已复现的终态覆盖漏洞，本轮未扩大 UI 改动面。

### 4.3 确认与恢复信息

[useResumeConfirmation](https://github.com/zesming/tekon/blob/f0c007b791d1da0f0f3b45b7b81718a905e760aa/packages/web/src/client/hooks/use-resume-confirmation.ts) 将确认绑定 Run 和上一 Job，失效后即时不能提交；这比只在 effect 中清空复选框更稳健。列表、详情和 Session 使用同一恢复快照，错误有常驻区域，审批已记录但尚未恢复可以分别反馈。这些不是需要推倒重做的界面。

后续优先验证首次用户能否理解“已受理、等待目录、已请求暂停、退出未知、已确认退出”等状态差别，以及完整只读历史导出的可发现性。不建议先建设通用诊断平台。

### 4.4 视觉与辅助技术证据

作者归档了四视口 32 页截图及 Chromium 164 项回归，见 [本轮作者验收](2026-09-06-r26-recovery-acceptance.html)。本次复审读取源码、验收描述和关联结构，不将作者的视觉验收记成自己重新执行的截图审计。没有新应用截图或真实读屏证据，不能新增 Firefox/WebKit、触控、缩放、forced-colors 或弱网已经通过的结论。

## 5. 架构、数据与代码实现

**同库受理已经成立，不再判为非原子。** 请求身份、Run、Session、Job、开场事件与必要审计由 Admission 统一提交；文件后置准备有屏障。它不保证后续外部命令恰好执行一次，但本轮新增的中断后显式确认策略正是在管理这一边界，而不是假装分布式副作用自动回滚。

**执行所有权已经有实质保护。** `withExecutionWriteScope` 把 owner fence 延伸到排队后真正执行的数据库写入；独立事件订阅者不继承发布者旧租约；恢复入队在事务内复核最新执行代次。因此不能继续仅凭 CLI/Web 各有进程就断言“所有状态可被旧 owner 覆盖”。文件、Git 和外部服务的保证仍需按各自 API 验证，不能由数据库 fence 外推。

**退出证据的命名和作用域是正确的。** 按 Job 而非只按 Run 登记句柄，避免旧代清理误伤新代；生产执行器排空与 close 共同产生受管理证据。Node 官方区分 `close`、`exit` 和发送信号，`kill()` 成功不证明进程已经终止；现实现没有再做这种等同。[Node child_process](https://nodejs.org/api/child_process.html#event-close)。证据仍不涵盖逃逸、未登记的后代及任意外部任务，这个限制应保留。

**恢复扫描应保持可观测，而不是立即换调度框架。** 当前每页上限、游标推进、逐行失败隔离有真实公平性测试。未来若负载显示积压，再增加每轮候选数、修复失败数和最长滞后指标。没有负载数据，不把“没有复杂调度器”定为缺陷。

**事实源要按用途约束。** 开场与取消协调事件有事务保证；后续通用 Session feed 仍有 best-effort 投影。用于观察可以成立；将来用于模型历史或用户消息消费时，需要独立定义持久化、消费、重放和迁移合同。领域表加 outbox 或权威会话日志都是方案，不能要求项目现在同时实现两套。

## 6. 真实 Provider 证据：本轮不再使用旧结论

[作者 R26 验收 §4](2026-09-06-r26-recovery-acceptance.md) 及其中的 [跨宿主记录](evidence/2026-09-06-r26/claude-host-restart.json) 报告了 Claude Code 2.1.261、独立 Node 宿主重开磁盘 SQLite、取消后不再执行，以及 interrupted Run 显式恢复至 passed/done。停止后 1.2 秒的文件内容树比较也有明确排除项。

**裁决：认可这是已有的真实 Provider 生命周期证据，不再写成“完全没有真实 Provider 验证”。** 本轮没有重跑该模型实验，不能把作者归档说成本轮亲自观测。

范围仍限定于 Linux 隔离只读任务、受管理句柄和有限观察窗口；没有交付 Gate/eval，也不是 SIGKILL 后任意逃逸进程的完备证明。下一步应在同一 Provider 上增加一个包含真实构建 Gate、Artifact 和恢复后验证的交付任务，而不是继续重复最小只读用例，也不应据此声称所有 Provider/平台已就绪。

## 7. DeepSeek Harness 官方对照

本次重新读取官方 Releases：最新观察仍为 **`dsh-v0.1.3-alpha.1`**，发布于 2026-09-04；Tekon tested pin 维持 **`0.1.2-alpha.3`**，不自动升级。[Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)。上游引入 SessionHandle 单写者生命周期、格式 v2 和代理环境支持，同时披露部分历史加载性能回退；这些是迁移输入，不是仅修改版本号即可获得的免费能力。

| 官方资料内容 | 对 Tekon 的判断 |
| --- | --- |
| [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/README.md)：一次调用一个任务，最终 stdout，结束退出，无交互 follow-up | 继续用于一次性 Goal 合理；无需为了持续协作不断扩张 Headless Adapter。 |
| [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/acp/acp/README.md)：持久 Session、标准语义更新、取消与关闭；不提供 raw deltas、旧更新重放、完整 transcript replay/fork | 后续可选协议；接入不等于会话历史产品已经完成，应分别验收持久消息、重连展示、取消、关闭和恢复。 |
| [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/SAFETY.md)：未经安全审计，sandbox/approval 不保证隔离 | Tekon 必须保留明确的访问范围、凭据最小化和外部副作用批准，不能把上游当唯一安全控制。 |

## 8. 是否过度实现或过度设计

**值得保留：**原子 Admission、v1/v2/v3 兼容、命令描述符物化、目录恢复屏障、回执身份保护、按 Job 的退出证据、事务内确认复核和有界补偿。这些都对应已证明的失败模式，不因代码增加就认定过度设计。

**应克制：**不要为这个排队暂停问题新建暂停表、控制服务或全域事件平台；本轮仅修正现有分派和恢复边界。复杂测试有价值，但应说明模拟端口、真实 SQLite、真实 OS 子进程与模型调用各证明什么，不能相互替代。HTML 人审版符合仓库约定，不按格式本身判为过度实现。

**维护建议：**继续减少重复事实和字符串结果判断；在有第二个真实消费者或实际错误之前，不急于把每个分支抽成公共框架。PR 体量会增加审阅和回滚成本，但 squash 不会自动消除迁移与行为耦合；后续按可独立验收的小切片推进更重要。

## 9. 验证及交付边界

| 验证 | 实际证据 |
| --- | --- |
| 基线 | Core #449 / CI #358 成功，绑定用户 SHA。 |
| 本地定向 | 两份实际源文件核对 Git blob；8 项受控端口测试先红后绿，4 fail/4 pass → 8 pass。不是 SQLite 集成，也不是全仓测试。 |
| 新增集成 | `queued-pause.test.ts` 6/6；真实 SQLite、Admission、默认执行器、Git 工作树和显式 mock Provider。 |
| 修复 Core | #450：101 文件 / 1373 passed / 1 项既有 DSH opt-in skipped；Core e2e 11 文件 / 49 passed，含既有跨进程恢复六项。 |
| 修复 CI | #359 completed/success，九个 Job 全部成功；构建/类型、审计、四档 Node、CLI、Web 与 Chromium。 |
| 最终文档 Head | 必须单独读 Core/CI 和九个 Job 终态后再更新 PR，不以本表代替。 |

本轮测试未增加重试、未削弱原断言。旧行为源码与修复源码的 blob 均核对后才提交。基线 Gate、暂停恢复确认、取消补偿和 owner fencing 用例继续保留。

v0.24.1 为补丁升级：根和三个内部包仅改变版本字段，不调整依赖、安装或启动参数。README/手册已有 pause/resume 与退出未知确认流程，本次恢复其既有行为而非增加新命令；原 v0.24.0 CHANGELOG 不覆盖改写，本轮变更摘要由本报告和 current 双格式入口记录。安装脚本、AGENTS 和既有验收材料保持不变，不将审阅过程写入用户操作步骤。

**交付裁决：排队前暂停缺陷已修复，新增回归在远端实际通过；在本轮审阅范围内未再确认必须阻断本次增量的新问题。** 整体生产就绪仍应按 Provider、操作系统、真实交付任务及恢复/负载场景逐项验收，不能用一次绿色 CI 总括。

未执行合并、发布、部署、强推、物理清理或仓库规则修改。
