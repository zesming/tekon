# Tekon 第二十五轮复审：有效命令绑定与受理回执

**日期：2026-09-05 · 产品版本：0.23.0 · [PR #11](https://github.com/zesming/tekon/pull/11)**

| 核验对象 | 快照与证据 |
| --- | --- |
| 用户远端基线 | `8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0` |
| 上轮实际交付 | `0a6edc95363965daad081ab23ddf254ce2feaa65` |
| 本轮行为修复 | `c4f6939c6228585443d0498e92cd1a6d36c75007`，原 PR 分支非强制快进 |
| 基线检查 | [Core #441](https://github.com/zesming/tekon/actions/runs/33958129845)、[CI #350](https://github.com/zesming/tekon/actions/runs/33958129847) 均成功 |
| 修复提交检查 | 见本报告末尾“验证记录”；最终文档 Head 由 PR 的对应 Checks 单独证明 |
| DSH | Tekon tested pin 保持 `0.1.2-alpha.3`；本轮官方发布观察基线为 `0.1.3-alpha.1` |

## 1. 结论与范围

**上一轮有效仓库命令绑定问题已关闭；本轮发现并修复一类 P2：已获得服务端受理回执后，本地账本、页面跳转或迟到 POST 错误仍可能把界面重新归类为“受理未知”。** 修复前同一组定向测试为 6 失败、3 通过，修复后 9/9。没有证据将其描述成服务端事务回滚、鉴权绕过或新的重复执行漏洞。

就本轮审阅的受控交付整改和回归路径，修复后未再发现必须阻断该增量的新问题。**这不是所有场景的正确性证明，也不是未经真实 Provider、跨平台及负载验证就宣布生产就绪。** 持续协作、导出和运行时演进应继续按各自范围验收，不作为每次补丁无限扩张的前置条件。

本次从远端 Head 和变更清单重新出发，沿产品入口、预览、计划捕获、受理、物化 Gate、执行/恢复、前端请求账本、查询与事件流检查关键调用链。覆盖全仓结构与高风险边界，不声称逐行证明全部文件。主要依据是指定 SHA 的代码、测试、README/current、GitHub Actions 和官方资料；下文区分代码事实、执行复现与建议。

环境限制：容器 DNS 不可用，不能 clone/安装全仓依赖；本地定向执行使用经 Git blob SHA 核对的真实 Controller/Ledger 源码及同一份测试断言，未调用的 React/RPC/cache 导入用隔离替身满足模块加载。没有本地完整 `pnpm test`、新的 Tekon 页面截图/读屏、Windows、真实 DSH L2/L3 或生产故障演练。本运行时没有独立 subagent，已做第二遍保守自检。HTML 报告排版验证不等于应用视觉验收。

## 2. 对 v0.23.0 整改的逐项复核

### 2.1 R24-02：有效命令与适用性绑定——关闭此具体切片

[repo-command-binding.ts](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/core/src/workflow/repo-command-binding.ts) 只捕获真正进入仓库解析分支的 commandRef，且在同一次读取中得到来源与决定。每项保存 resolved 命令的 tool/args、not-applicable 原因或 missing 事实；没有引用时不读取配置文件。

[RunPlan v3](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/core/src/workflow/run-plan.ts) 将这些记录纳入摘要，严格校验额外字段、重复/缺失引用和来源组合。[ExecutionPlan](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/core/src/workflow/execution-plan.ts) 先生成稳定 Gate 身份，再物化命令并删除 commandRef：新 v3 执行不再从当前 profile 重新解析。恢复和合法 rework/repair 沿用已确认的执行事实。

[真实 Gate 回归测试](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/core/__tests__/workflow/repo-command-binding.e2e.test.ts) 包含确认后修改命令、改成不适用、损坏/删除 profile、排队窗口变化、持久 Gate 篡改、repair 和 rework。测试既有实际 npm 子进程，也有为特定审阅结果注入的 Gate/Agent 替身；不能把后者称为真实模型验证，但也不是只检查一个 mock 是否被调用。

**边界：**绑定的是命令描述符和解析决定，不是 package scripts 正文、测试文件、PATH 二进制、依赖、Git/base 或宿主环境。README 已明确说明这一点。本轮不把已披露的范围重新包装为“命令绑定仍未完成”，也不要求为修此切片哈希整个仓库。

### 2.2 历史兼容与展示——保留、验证，不静默升级

旧 v1、v2 和无快照记录保留原恢复语义；v3 自洽快照、历史未绑定、未知版本和无效记录分别展示。分类函数明确不是替代执行前节点/审计校验的授权机制。新运行不能通过伪装成旧版本获得自动放行，这个分层合理。

[逐项预览](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/components/runs/PlanCommandBindings.tsx) 给出执行、跳过、缺失、内置安全扫描和非命令 Gate 的不同语义，不把“解析成功”一概等同于执行命令。[比较签名](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/server/api/plan-preview.ts) 使用每个 Web 根实例独立的 HMAC 密钥，只服务脱敏变化提示，不持久化成运行授权。服务重启导致比较不可用，而不是伪造“未变化”，是正确降级。

### 2.3 R24-01 与观察链路——继续成立

缓存失效的旧响应不能重新发布为新鲜状态；事件订阅关闭后限制迟到回调，页面切换同时限制历史页结果；Workspace 首次连接和重连主动触发读取，审批事件使相关 Gate 查询失效。当前实现见 [use-session-stream](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/hooks/use-session-stream.ts)、[use-workspace-summary-stream](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/hooks/use-workspace-summary-stream.ts) 和 [session-stream](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/lib/session-stream.ts)。

这些约束与 React 官方关于异步响应乱序及 effect cleanup 的建议一致，但“回调不再影响页面”与“底层进程或网络已结束”仍是两项验收。[React 官方说明](https://react.dev/reference/react/useEffect#fetching-data-with-effects)

### 2.4 受理事务、身份与目录恢复——不再重复报缺失

既有同库受理、requestId 重放、冲突检查、目录后置准备、未就绪禁止执行及原赢家身份保留均继续成立。[Engine](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/core/src/workflow/engine.ts) 在重放时先查原记录；新受理才捕获配置。目录与外部命令不被塞入长 SQLite 写事务，这个分界应该保留。

SQLite 的 immediate transaction 可以协调同库竞争写入，但不自动包含文件、Provider 或 Git 副作用；“受理一次”不等于“任意外部操作恰好执行一次”。这是保证范围，不是否定已经实现的原子受理。[SQLite 官方事务说明](https://www.sqlite.org/lang_transaction.html)

## 3. R25-01 / P2：服务端确认不得被本地后处理降级

### 3.1 原实现与影响

基线 [use-run-admission.ts](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/hooks/use-run-admission.ts) 将发起 RPC、本地账本更新与跳转放在同一 catch 边界。原有 acceptedRecords 已处理部分成功响应竞态，但没有覆盖本地失败和迟到错误：

| 可执行顺序 | 原结果 | 为什么不准确 |
| --- | --- | --- |
| POST 返回 accepted → 删除本地记录失败 | 同时出现已受理记录和“受理状态待确认”错误 | 本地失败不能推翻已确认的服务端身份 |
| POST 返回 recovery-required → 更新账本失败 | 更新内存身份之前抛错，Run/Session 观察入口丢失 | 目录未就绪仍是已经受理，不是未知创建结果 |
| POST 返回 accepted → 跳转回调抛错 | 被解释为未知受理 | 跳转与数据库受理不是同一事务 |
| 查询已确认 accepted → 原 POST 随后报网络错误 | accepted 记录保留，但全局 outcome 再次变成 unknown | 成功查询是比另一响应失败更强的事实 |
| 原 POST 未知 → 查询返回身份 → 本地账本写入失败 | 错误沿用未知前缀，或直接丢弃本地失败提示 | 需要同时保留已受理事实与本地操作失败的说明 |

[AdmissionLedger](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/packages/web/src/client/lib/admission-ledger.ts) 的通用异常还包含“已阻止创建运行”。它适合发送前失败，却不适合已收到服务端回执后的失败。风险主要是误导用户、丢失当前页观察入口以及诱导不必要的新建；未复现服务端幂等失效。

### 3.2 本轮修复

1. 校验 requestId 后，先把回执身份和 filesState 写入内存，再进行浏览器账本 I/O。accepted 与 recovery-required 使用相同顺序。
2. 同 scope、requestId、fingerprint 已有服务端确认时，迟到 POST 错误不能将 outcome 降为 unknown 或 not-created。
3. 本地记录更新或跳转失败改成固定、无原始异常细节的提示：“请求已受理，但浏览器请求记录更新或页面跳转未完成。请通过下方入口观察原运行，不要重复新建。”原观察入口保留，不额外发起 Run。
4. 查询回执后的本地失败采取同样规则；目录就绪与否仍保持各自含义，不把 recovery-required 写成任务执行成功。
5. 发送前无法保存原请求仍阻止 POST；没有回执的网络错误仍是未知；其他 requestId 的响应仍不能被信任。

[修复源码](https://github.com/zesming/tekon/blob/c4f6939c6228585443d0498e92cd1a6d36c75007/packages/web/src/client/hooks/use-run-admission.ts) · [新增九项测试](https://github.com/zesming/tekon/blob/c4f6939c6228585443d0498e92cd1a6d36c75007/packages/web/__tests__/client/run-admission-receipt.test.ts)

### 3.3 验证与保留的限制

同一份测试先于业务修改编写。它使用真实 Controller/Ledger、可控异步响应和可失败的 Storage 实现，分别覆盖两种 POST 回执、本地跳转、并发查询后 POST 失败、两种查询回执，以及发送前存储失败、纯网络失败、响应身份不符三条反例。

**修改前 6 失败/3 通过，修改后 9 通过。** 本地测试不是浏览器存储权限实测，也不是新服务端事务测试；远端 Vitest、类型检查和全套 Chromium 作为集成回归单独核对。没有扩大本地持久化内容，仍不将需求正文或凭据写入账本。

仍有限制：存储彻底不可读时，旧请求恢复需要现有服务端查询路径；本补丁不修复损坏的 sessionStorage、不自动清空账本、不保证浏览器崩溃前每一条 UI 提示已经持久化。

## 4. 产品逻辑与 UI/UX

### 4.1 当前定位应按真实价值验收

[README](https://github.com/zesming/tekon/blob/8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0/README.md) 将产品定义为本地 Agent workflow 和受控研发工作台：需求、计划、隔离执行、检查、审阅证据、人工批准、PR 准备。这与当前实现相符。它不是“仅供 Agent 自举”；工程用户已能发起、确认、查询、重试和监督交付。

默认发起完整受控交付与轻量多轮协作是两种不同产品场景。README 明确不提供会话内追问/转向及完整模型增量流。后者应通过独立场景验证，而不是每轮都作为否定已完成补丁的固定理由。

### 4.2 主路径逐步判断（源码与自动化合同，不冒充新视觉走查）

| 步骤 | 当前有效设计 | 后续验收重点 |
| --- | --- | --- |
| 发起与预览 | 默认入口简单，高级参数另置；缺计划/凭据不启动 | 首次安装者能否理解 Provider 就绪与工作流选择 |
| 核对检查 | 显示来源、执行/跳过/缺失、安全扫描；刷新后显示逐项差异 | 技术名词密度与长检查清单的信息层级，需真实用户/截图评估 |
| 提交 | 共享 Controller、本地原请求身份和服务端幂等 | 本轮已补回执后本地失败；不要再生成重复提交状态机 |
| 未知或目录恢复 | 查询/观察原请求；另建必须明确选择 | 回执、目录准备、任务状态分别显示，不把受理等同执行 |
| 持续观察 | 重连刷新、跨入口审批、迟到结果限制 | 高频更新、弱网与真实长会话响应时延，不能仅以测试数量代替基准 |
| 导出与结束 | 暂停裸物理 clean，避免丢证据 | 先完成完整只读证据导出，再定义清理/保留策略 |

上一轮恢复文案已经改为“已受理，等待目录就绪/恢复”，本轮不重复列为待办。新 P2 是回执后异常分类，不是这些文案未整改。

### 4.3 未验证能力

本轮没有新的应用截图、真实设备和读屏资料，不能判定字号、对比度、焦点恢复、多浏览器或缩放全部通过。仓库新归档截图属于用户整改证据，不被重新标记为 reviewer 独立截图。HTML 报告使用清晰目录、窄屏换行和可横向阅读的表格，仅证明这份交付物的可读性。

## 5. 整体框架、数据与代码实现

### 5.1 真实架构：Tekon 主导，DSH 是可选外部 Provider

Workflow、RunPlan、Gate、Audit、Session 和 Job 仍由 Tekon 自有框架编排；DSH Headless 是外部子进程桥接。不能把上游 SessionHandle、存储锁或恢复能力直接算成 Tekon 已获得的全局保证。

### 5.2 已经合理的复杂度

v1/v2/v3 兼容是已有持久数据带来的责任；命令物化、派生节点验证、同库受理与文件后置恢复有具体失败模式依据。应保留这些边界，而不是为缩短文件直接合并掉。共享提交 Controller 也确实消除了两处发起入口已发生过的漂移。

### 5.3 后续应证明的执行边界

SQLite admission 不覆盖后续命令；节点执行、取消和重启恢复仍需选定真实 Provider 做故障注入。唯一执行所有权是一项需求，repo lock、单进程服务或 daemon 是方案，不能仅凭没有某个架构名称判为 P0。事件的开场前缀原子化与后续 best-effort 展示投影也需分开：后者可以服务观察，但不能未经验收就承担完整模型历史和消息消费事实。

现有 README 还披露自动化只在长驻进程内触发、历史交付审批记录未绑定内容指纹等限制。它们应按具体使用场景排期；本次未发现这些限制被新版命令绑定意外放大，也没有对其重新做完整攻击或生产复现。

### 5.4 维护性

本轮修复只调整共享控制器的回执/本地失败分界，没有新增全局注册表、浏览器事务框架或服务端状态表。建议继续让三类事实分别拥有清晰来源：服务端回执决定是否已受理，filesState 决定目录准备情况，浏览器错误决定当前页面后续操作是否完成。不要用单个 catch 或单个“失败”状态折叠它们。

全量列表重复解析快照、高频 SSE 失效与连续网络请求的成本值得测量，但本轮没有性能基准，因此不据源码行数直接报性能事故，也不立即引入新的缓存或调度平台。

## 6. DeepSeek Harness 与官方资料对照

本轮从 GitHub Releases 接口重新读取的最新发布仍为 [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，发布时间 2026-09-04 11:34:32 UTC；Tekon 不因上游发布变化自动升级 pin。

[官方 Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/bundle/headless/README.md) 的边界是一次任务、最终回答后退出，没有交互式 follow-up；它适合当前一次性 Goal。完整接入是实际版本、能力、凭据、取消与退出测试，不只是 help/config 关键词匹配。

[官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/acp/acp/README.md) 提供持久 Session、标准语义更新、prompt cancel、close 与 restart resume，但不提供原始 Provider deltas、旧更新重放、完整 transcript replay 或 fork。它是持续协作候选协议，不是接上即可获得完整 UI 历史产品。

[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/SAFETY.md) 仍声明实验性且未经安全审计，sandbox/approval 不是唯一隔离保证。Tekon 应继续明确宿主权限、凭据与代理来源，而不是恢复整份环境继承以换取安装方便。此次不升级 DSH、不宣称新的真实二进制或带 API key 模型调用验证。

**建议：**先选择一个真实 Provider，跑通一次执行、用户取消、确认退出、进程重启及后续恢复；再依据是否需要多轮选用 ACP。不要把上游每个新版本或每项功能都变成 Tekon 当前 PR 的必做重构。

## 7. 是否存在过度实现或过度设计

本轮没有发现应当删除的 v3 命令绑定主机制。93 行左右的绑定模块、局部 HMAC 比较签名、严格白名单预览都对应明确需求；不能仅因多了一个类型或文件就评价为过度设计。

更值得避免的是：为尚未量化的性能问题建设平台；为每个可观察状态增加一套全局事实源；把 HTML、人审报告或有意义的负向测试按形式判定为冗余；不断修改已经关闭的历史结论而不区分版本。

当前 PR 体量较大，后续最好按可独立验收的命令绑定、Provider 生命周期、导出等切片推进。是否 squash 由仓库合并策略决定；**squash 不会自动消除行为耦合、迁移或回滚风险。** 本次遵照要求仍提交同一 PR，不创建额外路线图平台、无新增泛化框架或无关 Issue 修改。

## 8. 验证记录与交付决策

### 8.1 本地

- 真实源码 Git blob：Controller `391a1f35dbf110421e3c2503b1ad8db1ce170635`；Ledger `32f247ed45bfed1eb3f28e8af15f143aadeece72`。复制到本地后逐字节核对。
- 同份新增测试：修改前 6 失败/3 通过；修复后 9 通过。三条保留反例证明没有将“没有确认”误判为“已受理”。
- 两份变更 TypeScript 转译语法检查通过；它不等于完整类型检查。
- 完整本地 pnpm 测试因依赖不可安装未执行。最终集成结果必须使用对应远端提交，而不是复用基线的绿色。

### 8.2 远端

代码修复提交的 [Core #442](https://github.com/zesming/tekon/actions/runs/33959238116) 与 [CI #351](https://github.com/zesming/tekon/actions/runs/33959238073) 均为 **completed/success**。CI 的 9 个 Job 全部成功：Root build/typecheck、生产依赖审计、Node 20.19.0 / 22.12.0 / 22.19.0 / 24.x、CLI、Web、Chromium。

[Web Job 日志](https://github.com/zesming/tekon/actions/runs/33959238073/job/101288120741) 确认新增 `run-admission-receipt.test.ts` 的 9 项进入真实 Vitest，Web 总计 **55 个文件、531 项通过**。PR 事件实际检出代码 Head 与当前 main 的合成 merge commit `61726d57735660e6d245c6a58979a61b359cc28c`，日志明确对应本次 `c4f6939…`，不是旧分支测试。

报告与索引属于后续文档提交；它们自己的 Head 检查由 PR 描述单独列出，不制造“报告内包含自身 SHA”的循环提交。

### 8.3 版本与文档

这是一项尚未合并的 v0.23.0 缺陷修正，不另行发布版本，不改 Schema、CLI、安装器、Provider pin 或现有操作流程。README/手册已经说明原请求查询和观察原运行，本次无须重复改写；新增本地失败语义在此报告归档。AGENTS 不需要变化。HTML 与 Markdown 内容同步，current 两种格式均更新。

### 8.4 后续验收顺序

本轮已修 R25-01，不新增未修复的增量 P1。下一阶段按实际价值选择：真实 Provider 的执行/取消/退出/恢复证据；完整只读历史导出；再做持久协作及必要的执行所有权演进。每项有独立测试和失败边界，不将所有长期能力绑定成一个“全部重做才能通过”的门槛。

本轮未执行 merge、release、deploy、强推、物理数据清理或仓库规则修改。
