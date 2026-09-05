# Tekon 第二十四轮复审：受理事务成立后的执行与观察边界

日期：2026-09-05 · 产品版本：**0.22.0** · 对应 [PR #11](https://github.com/zesming/tekon/pull/11)。

> 时点说明：§1–9 保留报告作者的 v0.22.0 结论；§10 为接续代理同步至 `0a6edc9` 后追加的独立复核和整改裁决；§11 记录 v0.23.0 的实施、验收与剩余边界。历史段落中的未完成项不代表接续整改后的当前状态。

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
→ 同一 RunPlan 使用不同 tool/args
```

RepoProfile 当前支持的执行字段为 tool/args，description 只作说明，不包含 env 字段。另外，解析结果若变成 not-applicable，GateRunner 会生成 skipReason；GateEngine 对支持的命令 Gate 直接记录 skipped。这是可从实现确定的条件路径，本轮未另行执行完整 Provider/Git 场景，不能写成已观察到的生产事故或恶意绕过。

依据：[GateRunner 的运行时解析](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/workflow/gate-runner.ts#L116-L156)、[GateEngine 的 skip 分支](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/gate/engine.ts#L53-L69)。

[RepoProfile schema 与解析器](https://github.com/zesming/tekon/blob/f86e0c86fd3eba8b9823bb6efc64914993900bea/packages/core/src/repo/profile.ts#L28-L38)也已核对，命令解析只返回 tool/args。

### 为什么重要

用户确认的应是将要执行的检查，而不只是检查别名。当前 v2 解决了模板本身漂移，却没有冻结运行时依赖的配置。如果产品承诺“计划确认后按该计划执行和恢复”，同摘要下变更命令或跳过检查就仍然超出了这条承诺。

### 建议与验收

在 #20 的后续小切片中，解析本次确实使用的 commandRef，把有效命令、明确的不适用事实和来源版本纳入受理快照；执行/恢复使用该解析结果，或检测到变化时明确暂停并重新确认。不要只在每次新 Engine 构造时缓存 profile，因为那仍未绑定用户确认时刻；也不要无差别哈希整个仓库。

验收至少覆盖：受理后改变 tool/args、从命令改为 not-applicable、恢复时 profile 已变化、显式内联 command 不受无关 profile 项影响、旧快照迁移或诚实降级。数据绑定不意味着把秘密展示在浏览器预览中；当前 whitelist preview 应保留。

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

## 10. 接续独立复核与整改裁决（2026-09-05）

### 10.1 同步、复现与证据层级

Tekon 已从 `f86e0c8` 快进至 `0a6edc95363965daad081ab23ddf254ce2feaa65`，完整保留作者的缓存修复及报告勘误，工作区同步前干净。DSH 已实际 fetch origin 和 tags，HEAD 与 origin/master 仍为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，没有新增提交；tested pin 不变。

本次使用独立代理分别调查有效命令设计、真实查询/SSE链路和 DSH/执行生命周期。专用角色在当前 runtime 出现配置/请求错误，改用可正常执行的最高思考等级独立代理；以下结论不是将主代理自检改称独立评审。

| 事项 | 证据 | 接续判断 |
| --- | --- | --- |
| R24-01 | 当前真实 QueryCache 两文件 20 项通过；独立核对 useQuery 订阅、请求发布权与 SSE key 前缀 | 原补丁的精确切片成立；尚需真实页面＋SSE时序补证，不能扩大成所有观察链路闭环 |
| R24-02 | 主代理以真实 Engine、SQLite、Mock Agent 和本地 npm scripts 复现；控制组 passed，受理后改变参数则 exit-code failed，改 N/A 则 skipped；三组摘要相同 | 不只是 commandRef 名字变化的问题，有效命令/适用性事实确实可在受理后漂移；必须冻结 |
| security 边界 | `GateRunner` 对 security N/A 不生成跳过，`GateEngine` 仍执行内置扫描 | 新绑定不能把安全扫描误变成 skipped，必须保留此特殊规则 |
| Workspace 重连 | 服务端新连接首轮只设置 signature；客户端 live 不触发列表重查 | 独立发现的 P2：断线期间变更可能一直不显示；本轮补真实重连红测并整改 |
| 审批卡片 | Session SSE 审批事件只失效 session.list；Gate query 的 runId/hasPendingApproval 可保持不变 | 独立发现的 P2：其他入口审批后卡片可能陈旧；本轮补跨入口浏览器证据 |
| R24-03 | 共享 Notice、CLI 和手册同时出现“创建失败”与“已受理” | 接受用语收敛建议，机器状态与 unknown 边界不改 |

有效命令复现使用固定、安全的 npm scripts：原命令 `npm run check-original` 正常退出；变更命令 `npm run check-changed` 以 7 退出。没有调用真实模型、网络包安装或生产命令。三组 Run 的摘要均为 `a605b3689cf31d55ed6a607b8b68a3220fa2daa66733f551ea1e2c55ecdbd4f3`：

| Run ID | 条件 | Build Gate / Workflow |
| --- | --- | --- |
| `run_178222f2-73fb-4ca7-8c82-910a52c1ddfa` | 不改 profile 的正对照 | passed / passed |
| `run_8c3e10a8-1288-4832-9e2a-069fc107638f` | 受理后改 args | failed（exit-code）/ blocked |
| `run_89b6e399-c138-46b3-acc8-c876c796be92` | 受理后改为 notApplicable | skipped（not-applicable）/ passed |

探针临时目录已清理；本表保留关键 Run/Gate 结论，不将其称作真实 Provider 可交付性 eval。后续实施前，Workspace 重连与跨入口审批已由真实 HTTP/SSE、SQLite 和 Chromium 复现为失败；修后对应旅程通过。新增观察测试还覆盖迟到成功、迟到 500、多帧失效合并和重新挂载，不以仅调用 cache 函数替代页面证据。

### 10.2 执行绑定：采用冻结事实，不在执行中切换配置

采用 [第 24 轮整改方案](../superpowers/plans/2026-09-05-twenty-fourth-review-remediation-plan.html)：RunPlan v3 记录实际消费的 ref 解析结果与来源，结果区分 resolved、not-applicable、missing；内联命令优先，无消费引用时不读 profile。先以原模板生成稳定 Gate key，再将绑定物化进持久执行 Gate 并移除动态 ref 入口。执行/恢复以同一快照校验期望节点，repair/rework 继承原物化事实。

拒绝“仅在 Engine 构造时缓存 profile”的方案：它既不绑定用户确认时刻，也会使 v3 恢复与 requestId 重放依赖当前坏配置。文件读取放新受理同步分支，纯准备 helper 只接收已捕获事实；所有输入/选项摘要继续比较。旧 v2/v1/无快照不重写历史，在观察入口明确历史绑定边界。

预览仍采用白名单；只增加检查状态、来源、实际行为说明和不透明比较标识，用于提示哪些检查变化，不公开 tool/args/env 或不适用原始理由。方案首轮独立 review 指出模板 skipReason 优先级不能遗漏、公开逐 Gate 无密钥摘要会增加低熵字段猜测入口；已补齐物化后行为优先级和服务端临时 HMAC 比较作用域，并通过第二轮最高等级技术复查及编辑性审阅后实施。持久计划摘要不包含这些临时显示标识。新预览和历史绑定提示是新增用户可见能力，本轮与缺陷修复合并按 MINOR 目标 `0.23.0` 管理，而不是仅按最初纯绑定补丁的 PATCH 建议计。

绑定 `npm/pnpm` 调用不等于冻结 package script 正文、测试代码、依赖、PATH、Git/base 或 Provider。关闭 R24-02 不代表整个 #20 的执行环境已不可变。

### 10.3 执行所有权与 DSH：保留已有机制，明确尚未证明的保证

补充 §6.1：Tekon 已有条件原子 claim、事务化 enqueue、owner/status 条件写、heartbeat 失主处理、注册子进程 kill、工作树晋升 expected-old OID、有限关停 drain 和数据库关闭屏障。不能暗示这些机制不存在。依据：[Job 存储](https://github.com/zesming/tekon/blob/0a6edc95363965daad081ab23ddf254ce2feaa65/packages/core/src/session/session-store.ts#L587)、[JobRunner](https://github.com/zesming/tekon/blob/0a6edc95363965daad081ab23ddf254ce2feaa65/packages/core/src/session/job-runner.ts#L267)、[Worktree 晋升](https://github.com/zesming/tekon/blob/0a6edc95363965daad081ab23ddf254ce2feaa65/packages/core/src/runtime/worktree-manager.ts#L183)。

同时，[requestCancel](https://github.com/zesming/tekon/blob/0a6edc95363965daad081ab23ddf254ce2feaa65/packages/core/src/session/session-service.ts#L463) 先写领域取消，再请求执行取消；有界 stop 也不保证不合作执行者已退出。因此取消受理、数据库终态与实际进程静止应分开，不能把剩余尾部风险统一推给未来 Collaborate 后宣称关闭。本轮绑定实现必须继续通过已有取消、失主、关停和恢复回归，不新增绕过 owner 的写入。

DSH 的 Headless/ACP/Safety 关键结论经固定 SHA 源码复核成立。SessionHandle 的单写锁保护其会话日志，不保护 Tekon 的 Git/worktree 或其他副作用；ACP 提供 committed semantic updates，不提供 raw deltas 或旧 updates 重放。依据：[ACP 合同](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/acp/acp/README.md#L88)、[会话锁](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-persistence-jsonl/src/lease.ts#L1)、[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md#L5)。

上游 persistence README 存在“logical v1”残留文字，而 [Session 类型源码](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L86) 的版本常量为 2。采用当前源码事实，不据旧文字改写报告为 v1；这也不是 Tekon 已实现 ACP 的证据。

### 10.4 进入实施前的交付门

本轮同时处理有效检查绑定、配置可解释预览与历史提示、查询/SSE观察缺口、恢复用语。方案必须经最高等级独立循环评审后才实施；代码和测试之后还需独立 review、全仓与全套浏览器验证、四宽度新截图目视、报告逐项完成度复查。当前尚未宣称这些交付门通过。

ACP 接入、完整只读导出、全域副作用排他和真实多轮 Provider/平台专项仍是原报告明确后续方向；本轮保留其未完成事实，不通过删掉风险或收窄产品承诺来关闭有效命令缺陷。最终只推送同一 PR，不合入、发布、部署或强推。

## 11. v0.23.0 实施与验收记录

### 11.1 落地内容与证据对应

| 事项 | 实际调整 | 验证依据 |
| --- | --- | --- |
| R24-01 查询失效 | 保留原在途失效修复；SSE 初连/重连进入 live 后重查列表，审批事件同时失效对应 Gate 查询 | 真实页面、SQLite、HTTP/SSE 的 7 条旅程覆盖断线期间变更、外部 decided/requested、旧成功/500、多次失效与重挂；修前关键旅程失败，修后全部通过 |
| R24-02 有效检查 | 新受理捕获 RunPlan v3；持久 Gate 移除 commandRef 并物化 command/skip 决定；确认窗口漂移拒绝，执行/恢复不读新 profile | Core 严格输入矩阵、真实 npm 执行、provider/preflight 等待窗口零受理、SQL 篡改、repair/rework/嵌套返工；另有 HTTP 与 CLI 真进程验证 |
| 检查预览 | 两入口共享检查详情、实际行为、来源和逐项变化；服务实例私有 HMAC key/scope 仅用于显示，刷新后显式再提交 | HTTP 6 项涵盖脱敏、同实例稳定、实例轮换不改 digest、profile→自动检测可比较、missing/N/A/security/human 与坏配置错误；浏览器两入口刷新加载、认证切换、scope 轮换与四宽度展示 |
| 历史兼容 | 冻结 v2 纯投影别名，保留 v1/无快照恢复；Workflow/Review/Session/CLI 统一观察 frozen/legacy-unbound/invalid/unknown | 历史执行与完整性回归；真实 HTTP/CLI 分类测试；缺损 admission 不降级历史，原 requestId 在配置损坏后仍返回原身份 |
| R24-03 受理用语 | 两表单/详情/列表/CLI 区分 pending、recovery_required；已知 accepted 身份在刷新失败后保留 | 首轮前端审阅发现两表单丢失 filesState，先取得 10 条单测与两入口浏览器红测后修复；内存保留细分状态、账本重载使用中性提示，4 条浏览器旅程通过，最高等级独立复查关闭 |
| 旧响应隔离 | 关闭流及切换认证/Session 后拒绝旧回调；`loadEarlier` 在返回时验证同一 owner | 新确定性单测覆盖旧成功、错误和跨 Session 历史页，已有认证/取消/失主/关停回归保留 |

`skipReason` 的组合兼容在规范化执行模板和 Core 矩阵中验证；文件模板入口没有新增此配置字段。指纹依据有效事实：被 ref N/A 覆盖的旧模板理由变化仍改变总摘要，但不伪造逐 Gate 行为变化。

### 11.2 修后真实命令探针

主代理使用 v0.23.0 本地构建、真实 Engine/SQLite/Mock Agent 和本地 npm scripts 执行以下探针。初始命令为 `npm run confirmed`（退出 0），备选 `npm run changed`（退出 7）；受理后再改 profile。三组 v3 摘要均为 `c7fd4bdc4449a439bbe5318f33f55e829bb85ba0f345da701b0ac7e3690ce617`，持久 Gate 均无 commandRef：

| Run ID | 受理后变更 | 实际命令 / Gate / Workflow |
| --- | --- | --- |
| `run_015079bd-6ff7-434e-9524-471cf99ebe55` | args 指向失败脚本 | `npm run confirmed` / passed / passed |
| `run_66945ef1-33aa-48e0-baa7-31979ee27a07` | build 改为 notApplicable | `npm run confirmed` / passed（不是 skipped）/ passed |
| `run_46577e73-264e-4d18-a43f-b0ac4ec4af79` | 暂停后损坏 profile，由新 Engine 恢复 | `npm run confirmed` / passed / passed |

这与 §10.1 的修前漂移形成对照。三个临时仓库和内存数据库均已清理。探针只验证命令绑定机制，没有真实模型调用；本轮没有新增真实 Provider 可交付性 eval 分数，不能将 3/3 passed 转述为任务交付成功率。

### 11.3 独立审阅、测试与交付门

最高等级独立代理完成两轮技术方案复查及编辑性审阅后才实施；Core、服务端与 CLI 的业务代码和测试均经独立审阅，未检出必须修复项。Core 审阅后将“未知版本”测试样例改为 99，并修正 v3 无效 context 分支的 TypeScript 收窄，增量已复查通过。用户文档、MD/HTML 与版本变更的独立审阅也已放行。

最终完成度、文档与视觉复核均未检出必须修复项；R24-01/02/03 及新增观察缺口在本轮验收边界内关闭，允许提交同一 PR；不等于生产可靠性无条件通过。视觉复核提出恢复图截到淡入动画中段的非阻断建议，已在采图时固定动画终态并重拍，14 项定向回归及截图增量复查再次通过。

前端首轮审阅检出表单目录细分状态遗漏，已按测试先行修复并经第二轮独立复查放行。首次完整 Chromium 回归为 92/95，3 项失败均来自新增控件使旧泛定位器匹配两元素；已改为精确高级设置/列表刷新定位，并把认证测试响应等待限定为实际 session.list，相关 8 项定向通过，未降低几何或认证断言。包含新增表单状态覆盖的最终完整回归为 99/99（零重试）。

| 验证层 | 实际结果与证据边界 |
| --- | --- |
| 全仓 Vitest | 最终 `pnpm test --run`：178 文件、1989 passed、1 skipped（1990）；包含 CLI 真进程、Core 执行和 Web API/client。既有 opt-in DSH live contract 未启用，不计作通过 |
| 构建 / 类型 | v0.23.0 最终全包 `pnpm build`、`pnpm typecheck` 均通过 |
| Chromium 全套 | `CI=1 pnpm --filter @tekon/web exec playwright test --retries=0`：99/99；含本轮 21 条新旅程及既有全功能、真实认证、审批、交付、冷启动、恢复和四宽度几何检查 |
| 生产依赖漏洞审计 | `pnpm audit --prod`：No known vulnerabilities found；不等于整个工具链或 DSH 安全认证 |
| UI 目视 / 归档 | 320/390/700/1440px 的 16 张新 PNG 已归档；实际页面未检出新控件越界、重叠、文案横裁或错误状态；字体补齐后 14 项检查预览/恢复/响应式回归另行通过 |
| 提交 / 远端检查 | 本地门已通过；提交后必须核对包含本文的最终 PR Head 的 Core/CI。精确提交 SHA 与远端结果以 PR 外部检查记录为准，不沿用 §9 历史 CI |

截图中的空态、缺命令、跳过、安全例外和历史恢复组合通过受控 RPC 投影进入真实页面，用于验证布局和交互，不冒充真实模型交付。实际绑定/目录故障/重放分别由 Core、HTTP/CLI 和既有恢复 e2e 验证。首次采图中固定栏因页面滚动出现在长图中部，已在截图前回顶；宿主缺少 emoji 字体导致既有装饰图标缺字，已在单次浏览器进程中临时加载 `fonts-noto-color-emoji 2.042-0+deb12u1` 后重拍，不修改系统字体、产品代码或 CI 环境。归档仅包含新图，R23 历史截图未改。

| 宽度 | 默认入口检查 | 高级入口检查 | Session 恢复/历史 | Run 恢复/历史 |
| --- | --- | --- | --- | --- |
| 320px | [PNG](assets/r24-v0.23.0/r24-320-simple-bindings.png) | [PNG](assets/r24-v0.23.0/r24-320-advanced-bindings.png) | [PNG](assets/r24-v0.23.0/r24-320-session-recovery-binding.png) | [PNG](assets/r24-v0.23.0/r24-320-run-recovery-binding.png) |
| 390px | [PNG](assets/r24-v0.23.0/r24-390-simple-bindings.png) | [PNG](assets/r24-v0.23.0/r24-390-advanced-bindings.png) | [PNG](assets/r24-v0.23.0/r24-390-session-recovery-binding.png) | [PNG](assets/r24-v0.23.0/r24-390-run-recovery-binding.png) |
| 700px | [PNG](assets/r24-v0.23.0/r24-700-simple-bindings.png) | [PNG](assets/r24-v0.23.0/r24-700-advanced-bindings.png) | [PNG](assets/r24-v0.23.0/r24-700-session-recovery-binding.png) | [PNG](assets/r24-v0.23.0/r24-700-run-recovery-binding.png) |
| 1440px | [PNG](assets/r24-v0.23.0/r24-1440-simple-bindings.png) | [PNG](assets/r24-v0.23.0/r24-1440-advanced-bindings.png) | [PNG](assets/r24-v0.23.0/r24-1440-session-recovery-binding.png) | [PNG](assets/r24-v0.23.0/r24-1440-run-recovery-binding.png) |

README、CHANGELOG、用户手册 MD/HTML、current 与方案/报告同步到本轮合同，四包版本为 0.23.0。既有产品/架构历史文档不重写；新实现和验收细节归本方案与报告。AGENTS、安装/更新脚本未改，因为仓库规则、安装和发布流程不变；本轮无需安装脚本变更专属 smoketest。

### 11.4 保留的限制

本轮关闭目标是有效检查调用和观察一致性，不是冻结 package script 正文、测试代码、PATH/依赖、Git/base、Provider 或宿主环境。持久摘要与 SQL/Audit 校验不防御拥有全库写权限者同时改写版本、摘要、节点和全部历史。安全 Gate 继续执行内置扫描，N/A 不能绕过它。

DSH 上游同步仍为 §10.1 的固定 SHA，tested pin 保持 `0.1.2-alpha.3`。真实 DSH L2/L3、多轮 ACP 接入、完整只读历史导出、全域副作用排他、Windows/macOS、生产规模故障和真实辅助技术专项仍未新增验收；既有取消、失主和关停测试通过也不能证明所有进程已静止。后续按原报告顺序推进，不以本轮功能通过代替这些里程碑。
