# Tekon 第二十五轮复审：有效命令绑定与受理回执

**日期：2026-09-05 · 产品版本：0.23.0 · [PR #11](https://github.com/zesming/tekon/pull/11)**

> 时点说明：§1–8 保留报告作者在 `c4f6939` 修复后的判断；§9 起记录接续代理同步至 `4bb7c26` 后的独立复核与补充整改。原文中的“未发现增量问题”不是后续完整验证的结论。当前 v0.23.1 实施与验收状态见 §10。

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

## 9. 接续独立复核与整改裁决（2026-09-05）

### 9.1 同步与独立验证

主代理从干净工作区的 `8a7bb3fccb9d7a63eddba61b41ac30e2b4849bb0` 快进到 `4bb7c260da2f8557f23beab42e01baca65f3ef2a`，保留作者 `c4f6939` 的修复与 9 项测试。R24 实施交付是 `8a7bb3f`，`0a6edc9` 是该轮整改前基线；这里澄清首表“上轮实际交付”的版本指向，不重写历史正文。

DSH 已实际 `git fetch origin --tags`，HEAD 与 origin/master 仍为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，标签 `dsh-v0.1.3-alpha.1`，工作区干净。tested pin 不变。最高思考等级独立代理分别调查回执/账本、产品/UI 接线和整体执行框架/DSH，以下不是把主代理自检换个名称。

本地完整依赖环境中，作者 9 项回执测试全部通过；初步定向 3 文件 43 项通过；全包 build/typecheck 通过；同步基线全量为 179 文件、1998 passed、1 项既有 opt-in DSH live contract skipped。这个基线说明已覆盖合同未回归，不能证明尚未覆盖的组合时序正确。

### 9.2 原修复成立，但已确认身份仍会被后续读取覆盖

独立 review 与主代理发现同一根因：私有 acceptedRecords 只保护目录 ready 的 accepted，且 `mergeRecords`、`loadScope` 仍会直接使用四字段账本替换完整回执。主代理用真实 Controller/Ledger、内存 Storage 和确定性异步门执行探针，没有修改业务：

| 探针时序 | 变更前已观察到的事实 | 当前实际结果 |
| --- | --- | --- |
| GET 开始 → POST 回 recovery-required → 旧 GET 返回 not-found | recovery-required、Run/Session、recovery_required | 被改为 unknown，Run/Session 和目录细分消失 |
| POST 回 recovery-required → 原内容重试 → 网络失败 | 已确认的同一 Run/Session | 重试写入 unknown，最终 outcome=unknown，观察入口所需身份消失 |
| POST 回 recovery-required → 同 scope loadScope | 已确认 Run/Session/filesState | 仅余账本中的 recovery-required，无 Run/Session/filesState |

三个探针均使用固定 `r25-probe-request`、`run-confirmed`、`session-confirmed`；这些是内存时序标识，不是真实服务端 Run 或模型产物。源码层另确认 accepted 的同类路径：删除旧账本失败后，提交另一任务会用磁盘 unknown 覆盖已知 accepted；再次查询又可能因 Map 已知而直接返回，无法补回观察入口。

因此接受 R25-01 的原修复，但补充判定仍有 P2：已确认身份的保护需要覆盖所有合并路径，而不只 catch 中的一次性本地后处理失败。没有证据把这些页面问题升级成服务端事务回滚或幂等失效。

方案独立审阅还指出作用域切换的错误路径：loadScope 目前先读取新 scope 账本，再撤销旧 scope；若新账本不可读，旧仓库记录和查询归属仍可能留在页面。修订先切断旧作用域再读取新账本，并补派发前 scope/intent 网络失败零 POST、恢复重试首次 list 失败，以及查询 A 不清除未知 B 错误的定向断言。该补充仍属于同一共享合并边界，尚不冒称已通过实现验证。

### 9.3 真实导航还有 Promise 边界

源码事实：项目使用 `createBrowserRouter`；当前 lockfile 和安装包的 React Router 7.18.3 的 Data Router navigate 返回 Promise。默认入口在调用 navigate 前清空输入，且 Controller、hook wrapper、组件均未完整等待返回值。原 9 项测试覆盖同步 throw，没有验证真实异步拒绝。

据 [React Router useNavigate 合同](https://reactrouter.com/api/hooks/useNavigate) 及本地安装源码，建议让后处理支持 `void | Promise<void>` 并等待，导航失败保留需求、已确认身份与固定本地失败提示；浏览器以一次目标 Session 导航的 DataCloneError 注入验证。此处尚是源码确认路径，必须先取得真实页面红测，不能把普通导航一概说成失败。

方案首轮两名独立 reviewer 均指出，简单改成“await 导航后清空”仍可能由旧 continuation 清掉等待期间的新输入。修订采用更小方案：默认入口不主动清空，正常成功路由切换时由组件卸载重置；回调调用前校验 owner，旧拒绝不发布到新上下文，不承诺撤回已经开始的 Router 导航。补 deferred 导航后编辑/换凭据/新建/卸载的 React 回归及成功返回首页的真实路由断言，再行复查。

### 9.4 采用最小共享合并，不重做执行内核

具体实施合同见 [第 25 轮整改方案](../superpowers/plans/2026-09-05-twenty-fifth-review-remediation-plan.html)：复用 Controller 内 Map 保存两类已确认回执；scope/requestId/fingerprint 同一身份才能合并；未知、not-found 和裸账本不能覆盖确认。只有 accepted 短路重发，recovery 仍能原 ID 重试并升级；目录非终态信息仍可更新。捕获异步后处理错误，不新增 RPC、持久字段、全局状态机或清空账本。拟版本 0.23.1，按既有承诺修复的 PATCH 计。

整体执行与 DSH 独立复核未发现此次增量破坏 v3 物化、旧版恢复、Job owner/取消防护或上游限制。补充 §2.2 的准确边界：新受理强制 v3；已有 admission 的无快照/v1 降级路径会被拒绝，合法 v2 兼容仍保留；这不等于防御全库写权限者同时重写快照、摘要、节点及历史。无需为此新增签名平台。

DSH Headless reasoning 向 stderr 输出且首 token 前无心跳，是将来升级 pin 时应验收的输出量/留存与时延边界，不是本次恢复整份环境继承或重做 Provider 的理由。依据：[固定 Headless 源稿](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/bundle/headless/README.md)、[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/acp/acp/README.md)、[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md)。

以上记录实施前的调查和裁决；方案已完成最高等级循环评审，实施与验收接续记录在 §10。真实 Provider 生命周期、完整只读导出和 ACP 继续按原报告后续顺序推进，不以这些长期目标阻塞可独立验收的本轮修复，也不把它们说成已完成。

## 10. v0.23.1 接续实施与验收

### 10.1 已落实的修复与独立审阅

共享 Controller 使用私有 confirmedRecords 保存 accepted 与 recovery-required 的完整回执；按 scope、requestId、fingerprint 和已有 Run/Session 身份合并。旧账本、未知查询与迟到失败不再覆盖已确认身份；恢复仍可原 ID 重试并升级 ready。scope 先隔离再读新账本，避免读取失败留下旧仓库入口。

Controller 等待 onAccepted，hook 返回真实回调结果，SessionComposer 等待实际 Router 导航且不主动清空输入。成功离开首页自然卸载表单；导航失败保留原需求和观察入口，旧 continuation 不清空后来编辑的内容。服务端协议、Core、CLI、四字段账本及 DSH tested pin 未改。

两名最高思考等级独立 reviewer 先审方案，修正导航清理归属和作用域失败隔离后放行。Controller 代码与测试三轮复查中，两次发现多请求错误归属 P2：派发前失败未绑定原请求；忽略 A 的迟到错误时又改写了 B 的错误归属。两者均先补红测再修复，最终仅在实际发布错误时绑定 owner，第三轮明确未检出必须修复项。组件、生产浏览器与 React 测试由另一名未实施对应代码的 reviewer 审阅。

### 10.2 红测、通过记录与证据边界

| 验证 | 已取得结果 | 证明范围 |
| --- | --- | --- |
| Controller 新测试先行 | 初轮 15 失败 / 14 通过；后续 scope 与三条错误归属测试各取得有效红测 | 确认缺口来自具体合并/归属时序，不以测试数量代替行为证据 |
| Controller 最终定向 | 新 36 + 作者 9 + 原控制器 27 = 72/72 | 合并、恢复、派发前后故障、身份隔离与异步回调 |
| 旧构建真实浏览器 | 显式 mock 夹具修正后，accepted 清理失败再新建、真实 Data Router 拒绝两项均在功能断言失败 | 不计入此前 preview 字段缺失或同文档导航导致的夹具失败 |
| 真实 React 导航 | 专项 10/10；与 R24 联合执行 17/17，其中 React 10 项全部通过 | 等待 resolve/reject × 未编辑、A→B→A、明确新建、token 切换、卸载；组件最初两项红测确认输入被过早清空 |
| 生产页面 R25 定向 | 39/39，禁用自动重试 | 两入口 22 项 I/O、1 项真实导航、16 项四宽度交互 |
| 完整 Chromium | 两片串行 84/84 + 64/64 = 148/148，零重试、零跳过 | 全部已登记浏览器旅程，包含本轮 49 项；不是把定向测试累加成完整覆盖 |
| 全仓 Vitest | 180 files、2034 passed、1 skipped | Core/CLI/Web；skip 为既有 opt-in DSH live contract，不算通过 |
| CLI 独立真进程 e2e | 6 files、22/22 | 全部已登记 CLI e2e，与全仓测试重叠，不重复累加为新覆盖 |
| 构建与静态类型 | 全包 pnpm build、pnpm typecheck 通过 | 四包版本 0.23.1，CLI 构建与 Web 生产构建 |
| 生产依赖审计 | 无已知生产依赖漏洞 | 当前锁文件与审计时点，不保证未来无新公告 |

39 项生产页面测试使用真实 HTTP、SQLite 与文件系统；默认入口在测试传输层将 plan、intent、run 三处统一改为 mock，高级入口实际选择 mock。断言核对持久 Provider、计划摘要、Run/Session/受理表总增量各一及初始执行 Job 唯一性；readiness-evaluate 派生 Job 不算重复受理。10 项 React 测试使用 Vite 加载真实组件与同一个 Router 实例，回执为受控 DTO，不计作真实服务端受理证据。

运行期间用进程级 PATH 防护阻止调用本机 codex、claude、dsh；已有显式 fake Provider 仍按测试自己的 PATH 使用。本轮不提供真实模型执行、取消、退出或重启恢复证据，也不启用现有 DSH live opt-in。

完整 Chromium 首轮在 124/148 附近以 SIGTERM（143）退出，没有全套终态结果；其中 React 第一项因尚在 about:blank 就读 sessionStorage 而失败。修正为测试自身显式打开真实 origin 并确认凭据，不依赖共享模块顶层钩子的跨文件注册。组合复验还暴露 R24 初始化依赖同路径导航的问题：新增 Session 后的 goto 只补 token，没有重新加载文档、列表或 SSE 观察器。仅在 setup 补 reload，保留场景内 SPA 重挂载的缓存竞争断言；17 项组合复验全绿，两处夹具修正均经独立 review 放行。最终完整 Chromium 分两片串行取得上述全绿结果，不将首轮中断记成通过，也不臆断 SIGTERM 原因。

### 10.3 四宽度与文档验收

新截图独立归档在 `assets/r25-v0.23.1/`，不覆盖 R23/R24。主代理与独立代理实际打开初轮全部 16 张后，拒收其中仍有列表加载动画的过渡图。采图条件现已补齐：真实 Job、相关事件序号、Run/Session/目录状态连续稳定至少 750ms，覆盖服务端 500ms 评估延迟窗口；随后点击真实刷新按钮，核对 HTTP 与 DOM 的目标身份及状态，无加载动画后采图。恢复请求以目录未就绪、初始 Job queued 且零角色执行为稳定态，不要求它执行到终态。此条件通过完整浏览器第二片；最终归档专跑再次 16/16，零重试。

| 宽度 | 默认入口：已受理 / 等待恢复 | 高级入口：已受理 / 等待恢复 |
| --- | --- | --- |
| 320px | [已受理](assets/r25-v0.23.1/r25-320-simple-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-320-simple-recovery-required-local-warning.png) | [已受理](assets/r25-v0.23.1/r25-320-advanced-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-320-advanced-recovery-required-local-warning.png) |
| 390px | [已受理](assets/r25-v0.23.1/r25-390-simple-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-390-simple-recovery-required-local-warning.png) | [已受理](assets/r25-v0.23.1/r25-390-advanced-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-390-advanced-recovery-required-local-warning.png) |
| 700px | [已受理](assets/r25-v0.23.1/r25-700-simple-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-700-simple-recovery-required-local-warning.png) | [已受理](assets/r25-v0.23.1/r25-700-advanced-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-700-advanced-recovery-required-local-warning.png) |
| 1440px | [已受理](assets/r25-v0.23.1/r25-1440-simple-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-1440-simple-recovery-required-local-warning.png) | [已受理](assets/r25-v0.23.1/r25-1440-advanced-accepted-local-warning.png) / [等待恢复](assets/r25-v0.23.1/r25-1440-advanced-recovery-required-local-warning.png) |

[可复核状态摘要](assets/r25-v0.23.1/evidence.json) 保存每张图的 SHA-256、Request/Run/Session ID、Job/目录状态、稳定窗口及采图前后几何结果。16 种场景均保留另一条 128 字符 unknown 请求，原观察与查询入口可经 Tab 到达并实际打开原会话；回执文字及控件无横裁、越界或重叠。默认入口最终列表显示已完成的 mock 会话或等待恢复；高级列表保留对应行。高级列表的 Running 汇总沿用持久 run.status，不能据此推断目录未就绪的任务已经执行，应以行内恢复徽标及“任务尚未执行”说明为准。

主代理及未参与 UI/浏览器测试实现的独立代理均重新实际打开最终 16/16 张，前轮加载动画必须项关闭，复查未检出新的必须修复视觉问题。这些是临时 fixture 的 mock 受理/恢复证据：accepted 的合成流程完成不是真实任务交付，recovery 的角色执行数必须为零。本轮没有新增真实 Provider 风险 Gate 结果或交付 eval 分数。静态截图不证明真实设备、辅助技术或表格横向滚动的全部交互；键盘证据来自对应 e2e，不能仅从截图推出。宿主缺少 emoji 字体，采图使用临时进程级 Noto Color Emoji 配置，不改系统字体或业务样式。

README、CHANGELOG、用户手册 MD/HTML 已同步当前页回执保护、导航失败及刷新后的操作分流。文档独立审阅曾指出“刷新后按 Request ID 查询”遗漏账本已清理的情况，现已修正：仍有记录则查询，记录已移除则从受控交付列表打开已有会话；复查未检出必须项。未改安装/更新脚本与 AGENTS，因为安装流程、命令合同及仓库协作规则均未变化。

### 10.4 交付条件

最高思考等级独立完成度复查未检出必须修复项，本轮本地整改放行。Git 推送与远端检查仍是交付步骤，不用本地通过替代最终 Head 的 Core/CI。包含全部源码、测试、文档与图片的最终提交及检查链接记录在 PR #11，避免文档写入自身 SHA 后再次产生新 Head 的循环。不得合入、发布、部署或强推。
