# 第二十五轮整改方案：已确认回执不因本地操作丢失

日期：2026-09-05。基线：`4bb7c260da2f8557f23beab42e01baca65f3ef2a`。对应 [PR #11](https://github.com/zesming/tekon/pull/11) 与 [第 25 轮报告](../../reviews/2026-09-05-tekon-product-runtime-harness-twenty-fifth-review.html)。拟提交版本 `0.23.1`：修复已承诺行为，不新增用户能力、命令、协议、目录格式或手册章节，按 PATCH 管理。

状态：方案经两名最高思考等级独立 reviewer 循环评审后实施；Controller 及测试经三轮代码复查放行，组件和浏览器测试另行独立审阅。全功能与稳定截图本地验收通过，结果及最终完成度复查回填第 25 轮报告 §10；原报告 §1–8 保留历史时点，不再增加一份平行验收报告。Git 最终交付和远端 Head 检查另以 PR #11 记录为准。

## 1. 事实、目标与范围

| 事项 | 整改前事实 | 验收目标 |
| --- | --- | --- |
| 作者的 R25-01 修复 | 原 9 项回执测试在完整本地依赖中通过；Controller 先保存回执再做本地 I/O，避免一次性本地失败误报未知 | 保留修复，补真实页面、Storage 与导航证据 |
| 恢复回执丢失 | 真实 Controller/Ledger 探针：旧 not-found 覆盖 recovery；原样重试失败重新 unknown；同 scope 重读丢 Run/Session/filesState | 已确认身份在后续合并、读取和失败中保持，恢复请求仍可继续重试 |
| accepted 与旧账本 | 删除账本失败后磁盘仍 unknown；提交另一任务或重读账本可能覆盖内存回执 | 旧账本不比已经收到的服务端回执更权威 |
| 异步导航 | 实际 Data Router 的 navigate 返回 Promise；Controller、hook、SessionComposer 都未完整等待，且先清空输入 | 异步拒绝落入已受理的本地失败分支，不产生未处理拒绝；失败保留原需求与观察入口 |
| 上游与执行框架 | DSH fetch 后 HEAD/origin/master 仍为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`；v3、历史恢复及 Job 防护未发现本次增量回归 | 不重做 R24、不升级 tested pin，不用本轮通过替代真实 Provider/ACP 验收 |

本轮只修共享 Controller 的已确认回执合并规则及真实异步后处理。服务端受理、幂等、RunPlan、Gate、RPC Schema、四字段本地账本和认证来源保持不变。不是引入浏览器事务系统，也不把所有长期规划纳入本补丁。

## 2. 受理事实与目录状态的合并合同

### 2.1 复用控制器内的已确认记录

将现有只存 accepted 的私有 Map 收敛为已确认回执集合，包含 accepted 和 recovery-required。生命周期仍是该 Controller，不新增全局注册表或持久存储。

回执只能来自校验 requestId 后的 POST/GET 成功结果；使用时必须同时核对 scope、requestId、fingerprint。不同身份不得借用旧回执。若同 scope/requestId 的账本与已确认 fingerprint 冲突，不把旧回执贴给新意图，也不悄悄发送新请求；保留原已确认身份并给固定的本地冲突指引。认证或仓库 scope 切换仍同步隔离旧页面结果。

收到 intent 返回的新 scope 后，必须先切断旧 scope 的显示、active/current 与查询归属，再读取新账本；不能先读新账本、失败后仍留下旧仓库的观察入口。新账本读取失败时保留新 scope 的读取错误、scopeReady=false，旧 scope 的请求不可继续查询。仅同 scope 重读才合并其已确认回执。

内存回执保留 Run/Session/filesState；磁盘仍只保存 scope、requestId、fingerprint、state。不持久化需求、凭据、Run/Session 路由或原始本地异常。

### 2.2 所有合并路径使用同一优先级

`updateRecord`、`mergeRecords`、`loadScope` 和错误分类使用同一份已确认记录，不能分别从易被覆盖的 snapshot 或裸 ledger 推断是否受理。

| 已知事实 | 新输入 | 允许结果 |
| --- | --- | --- |
| 无回执 | 发送前存储失败 | 不发 POST；本次未创建 |
| 无回执、POST 未发出 | scope/intent 网络失败 | 不发 POST；按读取失败或未创建处理，不制造受理未知 |
| 无回执、POST 已发出 | 网络失败或 not-found | 仍待确认；保留原 requestId，不能说已受理 |
| recovery-required | unknown、not-found、裸账本或网络错误 | 保留已受理身份、Run/Session 与已知目录状态；不降级未知 |
| recovery-required | 同身份新的 recovery-required 回执 | 允许更新 pending/recovery_required 等非终态目录信息 |
| recovery-required | 同身份 accepted/ready 回执 | 升级为就绪，清理原账本并按成功路径后处理 |
| accepted | 旧未知/旧恢复回执/账本/本地失败 | 保留 accepted；不重新发送已完成受理的请求 |
| 任意已确认回执 | 不同 requestId/fingerprint/scope | 不借用身份；维持现有隔离或明确冲突 |

旧 GET 返回时，如同一身份在该 GET 发出后已收到更新的 POST 回执，旧非 ready 结果不得回退目录状态；匹配身份的 ready 回执可推进完成。可用 Controller 内的回执对象/局部代数判断此观察顺序，不新增服务端 revision 协议。不同查询之间仍保留已有单次 checking 限制。

同作用域重新读取账本时，合并已确认回执，不直接替换成四字段记录。磁盘清理失败留下的 accepted 请求，即使与另一条 unknown 请求共存，也保留各自事实与观察入口；不要求所有记录拥有相同状态。

错误展示也需保留请求归属：查询已确认 A 的开始或成功，不清除当前未知 B 的 error/outcome。可用 Controller 内的请求身份关联当前错误，不增加持久字段或复制一套提交状态机；只有同一请求的新证据才能纠正对应“未知/未创建”分类。新意图主动开始时仍可按现有交互清除上一操作提示。

### 2.3 恢复重试不能被单调性保护锁死

仅 accepted 可以短路重发。recovery-required 仍允许按原内容和原 requestId 发起恢复重试；重试前本地账本写入继续保留其已知受理状态，进行中不移除 Run/Session。若发送前本地存储仍不可用，本次不发请求，但不能把原运行说成未创建。失败后继续可查询/观察，成功后允许升级 ready。

已知恢复请求的首次 ledger.list 失败可能发生在新的 submittedRecord 赋值之前；此时也应从当前原请求与已确认集合取得事实，显示已受理的本地存储故障、保持零 POST，不能只修 upsert 之后的异常。用户已经编辑为另一意图时则不能借用原请求确认。

发送后用户编辑或切换上下文的既有 ownership 规则保持：旧操作不导航新页面、不将旧错误塞入新意图；已经确认的记录仅在匹配 scope 内合并。未收到可用回执的旧请求仍保留为待确认，不靠解析错误文本虚构服务端确认。

## 3. 异步后处理与用户提示

Controller 的 `Options.onAccepted` 与 hook 回调允许 `void | Promise<void>`；hook 必须返回实际回调的结果，`submit` 等待它。先保存已确认身份，再执行 ledger I/O 与回调；同步 throw、异步 rejection 都按本地后处理失败处理，不能覆盖原受理事实。

默认入口回调只等待 `navigate(...)`，删除主动清空需求的操作，不在 await 后写表单。当前入口仅挂载在首页 SessionsPage，目标 SessionDetailPage 为独立路由；成功离开时组件卸载，返回首页自然得到新表单。若导航失败、取消或用户等待期间编辑，保留当前输入与原请求观察入口，不需新增组件清理代数。高级入口没有导航，不人为增加跳转；既有同步成功提示和表单收起保持。

等待回调期间保留同一意图的提交锁，无论回调成功或拒绝都正确释放；用户编辑或明确新建后的既有新意图规则不变。调用回调前必须检查当前 owner，token/scope 切换或卸载后尚未开始的旧回调不得启动；旧 rejection 被消费但不发布到新意图。已经交给 Router 的导航不承诺能由 await 撤回。默认入口没有 await 后表单操作，因此旧 continuation 不能清空后来输入；不通过全局捕获隐藏与本次操作无关的页面错误。

提示区分三类事实：

- 服务端回执决定已受理与否；目录准备仍区分等待就绪、需要恢复和细分状态待确认。
- 本地存储/导航失败只提示“请求已受理，但浏览器请求记录更新或页面跳转未完成”，保留原观察链接，不建议重复新建。
- 原回执已存在但重试/查询未获得更新时，不伪造本地存储或导航故障；保留已知状态与查询操作。已知身份也不能掩盖另一未知请求的真实错误。

不新增受理状态枚举，也不将无法修复的 sessionStorage 自动清空。成功导航后的页面仍由服务端快照和 SSE 观察，不把回执当任务执行成功。

## 4. 测试先行与真实浏览器矩阵

实施前先新增/更新确定性单测并取得红测。原作者 9 项测试不删、不改成宽松断言。按下面的分层补证，不将所有组合机械复制到每种宽度。

| 层面 | 必须验证 |
| --- | --- |
| Controller 合并 | recovery 被旧 not-found、重试在途/失败、同 scope 重读保护；accepted 删除失败后与另一任务合并仍保留；不同身份不可借用回执；查询 A 不清除未知 B 的 error/outcome |
| 状态推进 | recovery→recovery 目录更新、recovery→accepted 成功，accepted 不被旧结果回退；不得因 Map 保护永远拒绝恢复重试 |
| 本地故障 | POST/GET 后 getItem/setItem/removeItem 失败仍保留回执；多条账本记录决定 accepted 清理走 setItem 的情况；发送前存储失败继续零 POST；已知恢复请求在 submittedRecord 前的首次 list 失败也保持确认 |
| 异步回调 | 同步成功/throw、Promise resolve/reject、同意图等待期间禁止重复提交、结束解锁；实际 React 中 deferred navigate 后编辑（含 A→B→A）/明确新建/token 切换/卸载再 resolve/reject，不清空新输入或发布旧错误 |
| 默认入口真实导航 | 对首次目标 Session 路径的 History.pushState 注入一次 DataCloneError，验证实际 Data Router Promise 拒绝；保留原需求/警告/观察入口，无未处理 rejection，恢复后链接能进入原会话；成功离开后返回首页，验证新表单为空 |
| 两入口真实 I/O | 真实 HTTP 接受后精确注入 admission key 的 Storage 故障；真实查询确认与迟到 POST 错误；真实目录阻断后的 recovery 重试失败/成功；旧 not-found 晚于 recovery 回执 |
| 负向和隔离 | 无回执的已派发网络错误仍 unknown、错 requestId 不可信、scope/intent 派发前网络错及存储不可用零 POST、token/scope/显式新建隔离；新 scope 账本读取失败不留下旧 scope 的记录/查询归属；另一旧 unknown 与已受理共存 |
| UI | 320/390/700/1440px × 两入口 × accepted 或 recovery 加本地警告；长 requestId、观察/查询入口键盘可达，无文字横裁、越界或控件重叠；稳定截图并逐张目视 |

浏览器使用真实生产页面、HTTP 与 SQLite。`route.fetch()` 后延迟回传并注入本地 Storage 故障可以模拟回执后的失败；只匹配 sessionStorage 的 admission key，不能破坏认证存储。真实目录失败只作用于临时 fixture，恢复后原 ID 可继续；测试结束必须还原或清理。

真实导航故障使用 DataCloneError，是因为当前 Router 对它 rethrow；普通 Error 会走整页导航回退，不能作为同一证据。测试中的故障注入不代表普通导航必然失败。只检查按钮存在或 href 不够，至少验证一次真实点击到原 Run/Session。用测试前后总记录增量排除换 ID 另建，而非只数某一个 requestId。

## 5. 所有权、评审与执行顺序

1. 主代理与独立代理完成源码/探针调查，追加报告批注；本方案经最高思考等级 reviewer 复查，必须项关闭后才改业务。
2. Controller owner：共享 hook/Controller 合并、回调等待、对应单测；测试先行，不改 Core/server/CLI/页面或正式文档。
3. Browser owner：新 R25 e2e 与专用 helper，覆盖真实 Storage/HTTP/SQLite/导航；不改业务，不自行运行浏览器或 build。
4. 主代理：SessionComposer 的异步导航收尾、必要 React 接线测试、文档与版本；拥有唯一 build、全量 Vitest、Playwright 和最终采图。其他 owner 只运行声明过的互不重叠定向 unit lane。
5. 业务与测试由未实施对应改动的最高等级 reviewer 审阅；必须项修后启动新一轮复查。真实全套 e2e、四宽度图与原报告逐项完成度另行放行。
6. 提交前 `pnpm test --run` 全绿；全包 build/typecheck、CLI e2e、Web 全功能 Chromium、生产依赖漏洞审计均检查。保留现有 DSH live opt-in 跳过，不擅自使用真实模型凭据。

## 6. 文档与交付边界

报告追加本轮视角、根因、确定性复现、浏览器证据及最终结论；旧 §1–8 不重写。明确 R24 实施交付为 `8a7bb3f`，`0a6edc9` 是那轮整改前基线，避免版本时点混用。收窄“伪装旧版本不能放行”的描述：新受理强制 v3，已有 admission 的无快照/v1 降级路径拒绝；不宣称抵御全库写权限者协同篡改全部事实。

同步 README、CHANGELOG、用户手册已有受理说明与 HTML、current、方案/报告 MD/HTML；四包统一 `0.23.1`。不新增手册章节或维护平台。AGENTS 与安装/更新脚本若没有流程变化则不改，并说明理由。R25 新图进入独立可提交目录，旧 R23/R24 图不覆盖。

最高等级完成度复查通过后，非强制推送原 PR 分支，核对包含本轮提交的最终 Head Core/CI；不合入、发布、部署或改仓库规则。清理本轮临时 fixture、trace 与采图辅助文件，保留正式文档/图和用户历史数据。

DSH tested pin 仍为 `0.1.2-alpha.3`；真实 Provider 执行—取消—确认退出—重启恢复、完整只读导出、多轮 ACP 及全域副作用排他仍有独立验收边界。本轮不以新增测试数量替代性能、跨平台、真实设备或辅助技术证明。

## 7. 资料内容与判断依据

- [React Effect](https://react.dev/reference/react/useEffect#fetching-data-with-effects)：异步响应可能乱序，cleanup 需要隔离旧结果；本轮据此保留现有 owner 隔离，并用本项目 Controller 与浏览器旅程验证。
- [React Router useNavigate](https://reactrouter.com/api/hooks/useNavigate)：Data/Framework 模式可返回 Promise；本项目 `createBrowserRouter` 与锁定安装源码进一步证实调用链，所以需要等待异步后处理，不只捕获同步 throw。
- [SQLite 事务](https://www.sqlite.org/lang_transaction.html)：同库事务保证不覆盖浏览器 I/O；据此区分服务端回执和本地后处理，不因后者失败改写前者事实。
- [DSH Headless](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/bundle/headless/README.md)、[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/acp/acp/README.md)、[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md)：单次 Headless、持久语义消息与安全限制经固定 SHA 复核；不因上游能力存在而宣称 Tekon 已接入，也不自动升 pin。
