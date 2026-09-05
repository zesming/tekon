# Tekon 第二十四轮复审：受理事务成立后的执行与观察边界

日期：2026-09-05 · 产品版本：**0.22.0** · 对应 [PR #11](https://github.com/zesming/tekon/pull/11)。

| 核验对象 | 本轮证据 |
| --- | --- |
| 用户远端基线 | `f86e0c86fd3eba8b9823bb6efc64914993900bea` |
| 本轮实际代码修复 | `c08caa1606de49e2ced70ef257c30db2ff01bf75`，非强制快进到原 PR 分支 |
| 基线自动化 | Core #437、CI #346 均 completed/success |
| 修复自动化 | [Core #438](https://github.com/zesming/tekon/actions/runs/33949295290)、[CI #347](https://github.com/zesming/tekon/actions/runs/33949295294) 均 completed/success；CI 9 个 Job 均成功 |
| Web 单测证据 | 49 files、468 passed；新增查询失效回归 5/5 实际进入远端测试 |
| 报告提交 | 本文绑定代码修复 SHA；包含文档自身的最终 Head/checks 由 PR 外部状态证明 |
| DSH | Tekon tested pin 保持 `0.1.2-alpha.3`；官方复核发布为 `0.1.3-alpha.1` |

**结论：仍有问题，不给整仓无条件通过。** 本轮修复一个可确定复现的缓存失效竞态；v0.22.0 的完整模板摘要、数据库原子受理、requestId 重放、目录恢复屏障和共享提交控制器均有实质进展。最重要的剩余 P1 是：**计划绑定了 commandRef 的名字，却没有绑定执行时解析出的仓库命令或“不适用”判定。** 自动化通过证明当前覆盖的合同，不等于所有执行环境已冻结，也不等于稳定持续协作产品验收。

## 1. 范围与方法

本次沿全仓关键链路审阅，而非宣称逐行证明所有文件正确：内部 current/report、AGENTS、变更清单、RunPlan、执行计划、受理数据库、SessionService、Audit、Gate、CLI/Web 边界、查询缓存、共享提交控制器及远端 CI。先比较上轮实际提交与最新用户 Head，再检查新实现的输入、持久化、失败和恢复路径；不把历史未关闭清单直接复制为当前事实。

证据分为三类：**已执行复现**用于本轮缓存缺陷；**源码调用链确认**用于有效仓库命令绑定；**设计建议或未验证能力**用于真实 Provider、执行生命周期和体验后续。未使用不可用的独立 subagent，已做第二遍保守自检。容器不能联网安装全仓依赖，未运行本地完整 pnpm test；集成证据来自绑定本次 SHA 的 GitHub Actions。

本轮没有新的 Tekon 应用截图、真实读屏或设备走查。仓库已归档的 R23 四宽度截图是用户整改证据，不能冒充本轮新拍摄。UI 结论来自实现、状态机及远端 Chromium 回归；本报告自身的 HTML 排版检查也不算应用 UX 验收。

## 2. 上轮重点问题：哪些已经关闭

| 上轮问题 | 本轮判断 | 事实与边界 |
| --- | --- | --- |
| 修改 gate.commandRef 或 mode，摘要不变 | 已关闭该直接缺陷 | RunPlan v2 包含规范化完整模板和 mode；摘要仅排除顶层 digest，保留嵌套同名字段 |
| 独立 planSnapshot 可与计划分裂 | 已关闭新 v2 准入切片 | 每份 input/options 的 canonicalPlan、snapshot、digest 都与实际上下文重新投影结果比较 |
| 持久节点可以偏离已确认模板 | 有实质校验 | 执行/恢复从 v2 模板派生期望节点，对原始数据库字段、额外节点及合法 repair/rework 授权进行验证；v1 与无快照历史保留明确兼容路径 |
| 启动分散写入、没有服务端幂等 | 已关闭同库受理切片 | 同一 SQLite immediate transaction 写入核心记录、审计、opening events、Job 和 requestId；同 ID 同意图返回赢家，不同意图冲突 |
| 已受理但目录失败，用户不能定位 | 有实质恢复路径 | files_state 区分 pending/ready/recovery_required，目录后置检查，失败保留原身份，未就绪不执行 |
| 两个启动入口各自实现提交状态 | 主要状态已共享 | RunAdmissionController/useRunAdmission、AdmissionNotice 和本地 ledger 统一重试、查询、明确新建及已受理单调性 |
| 清除请求后迟到结果仍覆盖缓存 | scope/代数切片已关闭 | QueryCache 统一拥有结果发布权；本轮另发现的是“运行中的失效通知”，不是重复报告上轮问题 |

依据：[RunPlan v2](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/workflow/run-plan.ts)、[执行计划校验](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/workflow/execution-plan.ts)、[受理事务](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/db/admission-store.ts)、[Session 编排](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/session/session-service.ts)、[共享提交控制器](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/web/src/client/hooks/use-run-admission.ts)。

这不是把“创建数据”简单包进事务：实现还考虑了另一进程已获胜、本次环境验证失败、提交后目录失败和通知失败的身份保留。把文件准备放到事务后、用持久就绪状态阻止执行，是比在事务中执行长时间外部命令更合适的边界。[SQLite 官方资料](https://www.sqlite.org/atomiccommit.html)说明的是数据库事务原子性；Git、Provider 和普通文件的恰好执行一次不能由此自动获得。

## 3. R24-01 / P2：查询中收到失效通知，被旧响应吞掉（已修复）

### 事实与影响

原 QueryCache.invalidate 只设 stale=true；useQuery 在 stale 且没有 in-flight 时才重新读取。原请求尚在运行，所以不会立即重查；随后旧请求调用 set，将 stale 重置为 false。最终清理 in-flight 后，订阅者也看不到重查需求。

```text
查询 A 开始
→ 审批/运行变更或 SSE 通知使 key 失效
→ A 仍登记在运行中，暂不重查
→ A 返回旧快照，set 将 stale 清零
→ 失效通知丢失，界面继续显示旧快照
```

这可能使待审批、Session/Run 列表或状态刷新落后。它是观察一致性缺陷，不是认证绕过或数据库回滚。源码依据：[原 QueryCache](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/web/src/client/lib/query-cache.ts)、[useQuery 订阅规则](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/web/src/client/hooks/use-query.ts)。

### 修复方式

为每个请求登记增加 invalidated 位。失效时撤销旧请求发布结果/错误的资格，但保留登记至结算，避免一连串 SSE 通知启动重叠查询。结算后保留 stale，订阅者发起一次去重后的新读取；无订阅者则保留 stale，待后续消费者读取。

没有取消底层网络，也没有新增缓存框架。已有清除 scope、请求代数和同 key 去重语义保留。该方案等待当前读取结算，因此不是硬中断或网络超时策略；持续高频失效下的刷新延迟仍应在负载测试中观察。

### 复现与回归

| 场景 | 旧代码 | 修复后 |
| --- | --- | --- |
| 旧成功响应不得吞失效；两个订阅者共享新读取 | 失败 | 通过 |
| 旧失败不得发布过时错误；仍应重查 | 失败 | 通过 |
| 无订阅者时保持 stale，后续可刷新 | 失败 | 通过 |
| 20 次失效合并为一次后续读取 | 失败 | 通过 |
| 不影响其他 key 前缀 | 通过 | 通过 |

本地使用真实 QueryCache 源码转译及 Node test runner，订阅者按 useQuery 的已读合同模拟；不是整页浏览器复现。原文件 blob SHA 为 `93e1e0dd7404e7f77e7507603134bf1afdefc0bc`；修改前 4 失败/1 通过，修改后 5/5。新增同等 Vitest 回归已在 CI #347 Web Job 实际执行；该 Job 共 49 文件、468 项通过。

[实际修复提交](https://github.com/zesming/tekon/commit/c08caa1606de49e2ced70ef257c30db2ff01bf75)只修改缓存和新增测试。远端源码 blob `975be197ed84494d6c39e8ce2060700750493b20`、测试 blob `d01cf53a7c21d15ee74cb7d86ed585005dc44127` 均与本地一致。[React 官方文档](https://react.dev/reference/react/useEffect)说明了响应乱序及忽略过期响应的原则；它支持生命周期判断，但并不代替本轮具体失效时序测试。

## 4. R24-02 / P1：有效仓库命令尚未进入执行确认（仍需处理）

### 与上轮问题不同

现在把模板里的 commandRef 从 build 改成 test，会改变 v2 摘要，这是正确修复。但 commandRef 是名字，不是最终命令。GateRunner.resolveGateCommand 在执行每个 Gate 时仍调用 loadRepoProfile(repoPath)，从当前 `.tekon/repo-profile.yaml` 解析对应配置。

```text
已确认模板：commandRef=build
→ 受理后修改 repo profile 的 commands.build
→ 执行时重新读取当前 profile
→ 同一 RunPlan 使用不同 tool/args/env
```

另外，解析结果若变成 not-applicable，GateRunner 会生成 skipReason；GateEngine 对支持的命令 Gate 直接记录 skipped。这是可从实现确定的条件路径，本轮未另行执行完整 Provider/Git 场景，不能写成已观察到的生产事故或恶意绕过。

依据：[GateRunner 的运行时解析](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/workflow/gate-runner.ts#L116-L156)、[GateEngine 的 skip 分支](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/gate/engine.ts#L53-L69)。

### 为什么重要

用户确认的应是将要执行的检查，而不只是检查别名。当前 v2 解决了模板本身漂移，却没有冻结运行时依赖的配置。如果产品承诺“计划确认后按该计划执行和恢复”，同摘要下变更命令或跳过检查就仍然超出了这条承诺。

### 建议与验收

在 #20 的后续小切片中，解析本次确实使用的 commandRef，把有效命令、明确的不适用事实和来源版本纳入受理快照；执行/恢复使用该解析结果，或检测到变化时明确暂停并重新确认。不要只在每次新 Engine 构造时缓存 profile，因为那仍未绑定用户确认时刻；也不要无差别哈希整个仓库。

验收至少覆盖：受理后改变 tool/args/env、从命令改为 not-applicable、恢复时 profile 已变化、显式内联 command 不受无关 profile 项影响、旧快照迁移或诚实降级。数据绑定不意味着把秘密展示在浏览器预览中；当前 whitelist preview 应保留。

本轮没有将其混入缓存补丁：这涉及新的持久执行事实和旧 Run 兼容策略，不是改一行加载位置就能正确关闭的问题。在修复或收窄承诺前，不给“执行环境完整不可变”无条件通过。

## 5. 产品逻辑与 UX

### 5.1 当前主路径已经从“发出请求”推进到“可查询的受理”

默认与高级入口现在共享请求身份和恢复控制；遇到不确定响应时保留原 requestId，查询不到也不武断认为未受理，明确另建任务才使用新身份。这比旧的“失败即重新点启动”更符合人类使用习惯。接受事实保持单调，能够避免迟到 lookup 将已接受状态退回未知。

受控 Deliver 的价值是计划、角色、Gate、证据和人工审批；持续 Collaborate 仍是另一条能力路线。后者尚未完成不应抹去前者本轮的进步，也不应被列为每次小补丁的 P0。

### 5.2 R24-03 / P3：恢复状态用语仍可统一

AdmissionNotice 的恢复标题是“创建失败需恢复”，同一处说明又表示请求已受理、目录未就绪。建议统一为“已受理，等待目录恢复”，把数据库受理事实与文件准备失败分开。原请求查询、观察入口和禁止误判未受理的文案已有，问题是状态命名，不是需要重建恢复系统。

依据：[AdmissionNotice](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/web/src/client/components/runs/AdmissionNotice.tsx)。本项为体验建议，未修改行为或测试，亦未声称经过新的屏幕阅读器走查。

### 5.3 后续体验应聚焦低成本动作

优先给执行配置变化提供“哪些检查变化、为什么需重确认”的说明；把 Provider 不可用、探测失败和凭据无效保持分离；为完整历史提供只读导出入口。不要因为出现多个错误态，就先建设通用诊断平台。恢复 UI 不应鼓励用户在尚未判定旧请求状态时重复创建。

本轮不再要求两个入口合并成一个大表单：共享受理控制器已成立，简单入口和高级参数表面可以继续各司其职。截图/几何检查可保护布局不变量，但不能证明全站焦点顺序、真实读屏、Firefox/WebKit 或设备弱网均已验收。

## 6. 框架架构与数据一致性

### 6.1 受理事务与执行所有权要分层判断

同数据库受理已具备事务、幂等冲突和赢家重读；不应继续写“Run/Session/Job 分散创建，没有服务端 requestId”。opening events 与初始 Audit 也已在事务中完成，不再依赖旧 onPrepared 异步钩子。

但同一 Run 的后续 Provider、Git、Artifact 和关机生命周期不是这笔事务。若要宣称多个 CLI/Web 进程都能安全执行所有副作用，仍需相应 owner、租约恢复和故障注入证据。单执行者加 repo lock 是可选的简单方案，daemon 是部署形态之一，不是唯一正确答案。

### 6.2 新 v2 完整性保护值得保留

执行前对原始数据库节点、顺序、依赖、Gate 和合法派生节点做校验，避免 schema 默认值把篡改补全成正常状态。验证实际捕获的 Audit 数组也比仅先调用 verify 再读取另一份事实更稳妥。v1 算法冻结而不是重写历史，是必要兼容成本，不应简单删除。

剩余需求/base/Provider/权限证据应按真实恢复场景逐步绑定。不要把一个可靠受理事务膨胀成包办任意工作流、跨机器一致性和所有外部副作用的通用引擎。

### 6.3 事实源与持久协作

本轮事务保证 opening prefix，不代表所有后续领域事件都成为完整模型历史。将 UI projection 用于观察是合理的；未来若以它恢复对话，必须明确消息消费、重放边界和唯一事实来源。可以采用领域表加 outbox，也可以选择权威会话日志；不因未做完整事件溯源便一概判为严重缺陷。

关闭、恢复和取消仍应按实际 Provider 终态验证：已返回 cancel/stop，不自动等于进程、Git 或 SDK 已全部停止。本轮没有新的 Windows、跨机器、真实模型或长时崩溃测试，不能扩大保证范围。

## 7. DeepSeek Harness 官方对照

截至本轮查询，官方最新发布仍为 `dsh-v0.1.3-alpha.1`（2026-09-04 发布；Tag `d347e703908d0406b7a7ef80e3a0e594d86b2215`）。Tekon 的 tested pin 保持 `0.1.2-alpha.3`，本轮未升级。

| 官方内容 | 对 Tekon 的判断 |
| --- | --- |
| Headless：每次调用一个任务，推理输出到 stderr，最终文本到 stdout，完成退出，无交互 follow-up | 现有 Goal/one-shot 接入合理；不能靠包装最终 stdout 获得持久协作 |
| ACP：new/list/resume/close、prompt/cancel、标准语义消息与工具生命周期 | 可作为下一条真实 Provider 纵向切片；需要 Tekon 自己处理审批、UI 和历史 |
| ACP 明确不提供 raw provider deltas、旧更新重放及完整 transcript replay/fork | “接 ACP 就得到逐 token 流和全部历史恢复”是不准确的验收预期 |
| 新 SessionHandle、每 Session 单写者锁及格式 v2 | 可参考生命周期设计；不能替代 Tekon 的 Git/worktree/受理和副作用所有权 |
| 实验性、未经安全审计；sandbox/审批不能保证隔离 | 继续使用最小权限与独立宿主控制，不把 tested pin 或 metadata probe 当安全认证 |

依据：[发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)、[Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/README.md)、[ACP 合同](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/acp/acp/README.md)、[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/SAFETY.md)。

建议选择一个受控 Provider，先验证创建会话、一次 prompt、可见语义更新、取消、关闭、重启 resume、第二次 prompt。逐 token 展示、完整转录导出、fork 另设验收，不默认由 ACP 提供。本轮未进行真实 DSH L2/L3，官方资料只是选型依据。

## 8. 实现质量与过度设计

**值得保留的复杂度**：原子受理、目录后置恢复、赢家身份保留、v1/v2 兼容、合法派生校验、共享 UI 控制器。每一项对应真实失败模式，不能因文件较长就判为过度设计。

**需要克制的扩张**：受理存储中较多 any/手写行映射可以先收敛为少量准确 RawRow 类型；不要引入另一套 ORM。错误码与恢复状态最好有单一映射边界，不继续在每层推断字符串。缓存补丁只增加失效发布权，不新建通用事件总线或替换全部查询库。

**文档与测试**：按仓库规则保留 Markdown 内容源和同步 HTML 人审版是合理交付，不再因双格式本身报错。现有截图与浏览器测试有实际状态依据；应避免为了格式一致再制造一套独立结论。真正的过度风险是重复事实和并行状态机，而不是报告数、Issue 数或行数本身。

建议本次评审只保留一份新报告、一个 current 索引和同一 PR 的结论，不增加新的平台化 Tracking。后续分别处理有效命令快照和真实 Provider 生命周期；是否 squash 是维护者的历史策略，不能替代对可执行风险的审查。

## 9. 验证记录与交付边界

| 验证层 | 实际完成情况 |
| --- | --- |
| 本地真实 QueryCache 定向测试 | 修改前 4 失败/1 通过，修改后 5/5；两份修改 TypeScript 转译语法检查通过 |
| 代码与远端一致性 | 原文件及修复源/测试的 Git blob SHA 已比对 |
| 修复提交 Core | #438 completed/success |
| 修复提交 CI | #347 completed/success；Root、Audit、Node 20.19.0/22.12.0/22.19.0/24.x、CLI、Web、Chromium 共 9 个 Job 成功 |
| Web Job | [日志入口](https://github.com/zesming/tekon/actions/runs/33949295294/job/101260982844)，新增 5 项回归、49 files/468 tests 成功；日志显示对应 PR merge checkout |
| 本地全仓 / 新应用视觉 / 独立 reviewer | 未完成本地依赖安装与全量测试；无独立 subagent；无新的应用截图或读屏验证 |
| 真实 Provider / 平台 / 故障规模 | 未新增 Windows/macOS、真实 DSH L2/L3、生产负载或跨机器故障证据 |

本补丁属于尚未合并 v0.22.0 的缺陷修正，不单独发布或升版本。公开 CLI/RPC/安装流程未变，README、用户手册和 AGENTS 无新增操作需要同步；行为说明、复现和限制在本报告及 PR 中归档。不新增与用户使用无关的 CHANGELOG 评审过程。未执行 merge、release、deploy、强推或 ruleset 修改。

**后续顺序：先补有效仓库命令及不适用事实绑定，再验证一个 Provider 的执行/取消/恢复链路；完整导出作为独立用户能力推进。当前缓存缺陷已修复，但在有效配置绑定问题处理前，不给“整仓无问题、确认即完整冻结执行环境”的无条件通过。**
