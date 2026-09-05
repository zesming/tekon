# 第二十三轮整改执行方案：计划绑定与可靠启动

日期：2026-09-05。基线：`6d276527f48874b46c06eb5b2e68a1757f077e01`。目标版本：`0.22.0`（新增请求身份、受理状态和恢复行为，按 MINOR 计）。关联 [PR #11](https://github.com/zesming/tekon/pull/11)、[第 23 轮报告](../../reviews/2026-09-05-tekon-product-runtime-harness-twenty-third-review.html)。

状态：方案经两轮独立技术复查通过，两位 reviewer 均明确 `hasMustFix: false`；文档审阅无阻断项。四个工作包已实施，代码/测试必须修复项经循环复查关闭，全仓测试、浏览器全套及四宽度截图目视验收通过。最新事实集中回填第 23 轮报告 §11；最终提交与远端 Checks 以 PR #11 当前 Head 为准。本文保留实施合同，不复制平行验收报告。

## 1. 目标与逐项裁决

本轮关闭可复现的计划和启动缺陷，并修复直接影响这条用户旅程的前端与审计问题。验收针对以下切片，不把它等同于持续协作产品或整仓无条件通过。

| 报告项 | 本轮决定 | 验收依据 |
| --- | --- | --- |
| R23-01 非 dynamic dry-run | 保留已修复代码，补齐手册合同 | 重建后真实 CLI workflow/goal 拒绝且零初始化；dynamic 预览仍可用 |
| R23-02 凭据缓存 | 保留删除廉价文件缓存的方案 | 文件轮换、删除、损坏回归；Provider 不阻塞凭据检查 |
| R23-03 请求归属及残余迟到写入 | 保留 finally 归属修复；补共享缓存发布权 | 旧成功/失败不能覆盖新请求；共享消费者卸载不影响其他订阅者 |
| R23-04 执行计划未绑定 | RunPlan v2 绑定完整模板、mode，校验来源与恢复 | 模板字段变更、混源 snapshot、持久节点篡改均拒绝；兼容历史 |
| R23-05 启动不原子/不幂等 | 单 SQLite 事务受理、持久 requestId、后置目录恢复 | 真实 DB 失败注入、跨进程重复请求、丢响应与重启恢复 |
| Provider 状态与 TTL（报告 §5） | 独立显示检查中/失败/时间/重试；按服务端过期时间刷新 | 慢响应、500、重试、凭据切换；不把凭据有效当作 Provider 可用 |
| 两个发起入口（报告 §5） | 共享提交身份、重试与计划过期处理 | 简单入口/高级表单保留各自视觉与输入；相同重试合同 |
| 运行依赖审计（报告 §8） | tsx、Vite、React Vite plugin 归入 Web dependencies | 生产依赖图覆盖真实启动链，audit fail-closed 和启动 smoke 通过 |
| DSH 同步（报告 §7） | 本地 DSH checkout 已同步至上游 `d347e703`；Tekon tested pin 保持 `0.1.2-alpha.3` | 上游版本与本地 SHA；不外推真实模型或新版本兼容 |

不在本轮实现 ACP 持久协作、daemon、全域 outbox、OS 级进程隔离、export/retention/purge、通用 Provider capability service 或 Project 身份合并。它们是报告明确的后续架构主线，分别保留 #13–#19、#28/#29/#32。#20 仍有 demand/base/Provider/权限证据全绑定的开放范围；本轮不关闭整个 #20。物理清理继续停用。不得因这些边界把“本轮切片完成”写成“所有长期能力完成”。

## 2. 产品与交互合同

### 2.1 预览必须对应同一份可执行模板

Workflow 与 Goal 均展示 v2 预览。Goal 统一使用内置 goal 模板，项目同名 override 不参与预览或执行。Web workflow 继续要求 planDigest；新 UI 的 Goal 也携带 digest。兼容旧 Goal API 不传 digest 的调用：服务端自行生成 v2，但它不代表用户确认过预览；传了 digest 就必须校验，不能忽略错值。

计划过期返回稳定 `PLAN_DIGEST_MISMATCH`，界面显示“计划已变化，请刷新预览后重试”并提供刷新。刷新后须重新提交，不自动接受新计划。dynamic 仍只支持 dry-run，不开放动态执行。

### 2.2 请求身份与受理结果

一个提交意图对应一个 requestId（幂等请求标识），不能用前端 latch 代替服务端去重。requestId 限定为 8–128 个 ASCII 字母、数字、下划线或连字符，默认使用随机 UUID；非法值在初始化前拒绝。CLI 新增 `--request-id`；省略时生成，并在启动前向 stderr 输出供恢复，stdout 继续保留结果输出合同。错误中再次带 requestId。显式创建另一运行应使用新 requestId。

Web 两个入口共用提交 hook：提交时生成 requestId；重复点击、超时、断连、同内容重试沿用。sessionStorage 只保存“稳定作用域指纹 + 信封指纹 + requestId/受理状态”，不保存 token 或需求正文。新增需认证的只读 `project.admissionIntent`：无提交内容时返回由仓库物理身份及凭据指纹组合的稳定 scope；有提交内容时复用服务端规范化信封，另返回信封 hash 与随机生成的建议 requestId。它不受理 Run、不写运行状态、不执行 Provider preflight，也不读取模板/需求卡正文。浏览器不依赖 WebCrypto 的安全上下文限制或自行实现另一套 hash；真正提交仍独立鉴权并重新计算信封。

持久账本不能复用当前仅在进程内递增的 authScope 编号；同 origin 切换仓库、凭据轮换不会误取其他账本，同仓库同凭据刷新仍能恢复。hook 挂载后取得稳定 scope，展示该 scope 仍待确认的 requestId 及查询/观察操作，不要求用户重输旧正文或拿当前模板重建旧意图；明确新建前不能悄悄遗忘待确认请求。sessionStorage 不可用时在发出 Run 请求前报错，不静默退化为易重复提交的内存账本。

提交开始同步捕获不可变 payload、认证 scope 和意图代数，并持有 latch。hash 完成、写入账本、RPC 发出前再次校验代数；发出前输入/凭据已变化则丢弃旧准备。发出后保留原 requestId 的待确认记录，迟到响应不能清空新输入或导航到新 scope。用户修改有效字段或明确开始新任务时生成新 requestId；计划过期刷新后重新点击提交，不自动重发。测试覆盖延迟 hash 期间编辑/切换凭据、同凭据刷新和同 origin 更换仓库。

| 对外状态 | 含义 | 用户下一步 |
| --- | --- | --- |
| 本次未创建 | 本次校验失败或事务确定回滚；相同 requestId 的其他在途调用仍可能受理成功 | 修正输入；同内容重试仍沿用 requestId |
| 已受理 | 持久化完整，返回 requestId/runId/sessionId/jobId | 观察同一 Session；重试返回同一身份 |
| 创建失败需恢复 | DB 已受理但目录未就绪，带相同 ID 和脱敏原因 | 修复目录问题后按同 requestId 重试；Job 不执行 |
| 受理状态待确认 | 网络/数据库不可读，无法判断提交结果 | 查询 requestId 或原 requestId 重试，不能提示盲目新建 |

新增需认证且限定当前仓库的 `project.admission` 查询；未找到只表示当前无记录，原 POST 仍可能在 preflight 或等待事务，必须保留原 requestId，不能据此自动换号。成功响应增加 requestId、replayed、admissionState。目录失败返回结构化“需恢复”结果而不是丢掉 ID 的普通 500。Run/Session 列表和详情需明确显示未就绪 admission，不把它装成已执行的 active Run。

### 2.3 Provider 状态

连接详情将凭据与 Provider 分列。Provider 状态为检查中、可用、不可用、检查失败；保留上次检查时间和重试按钮。失败可保留旧检查时间，但不能把旧 available 当作当前检查成功。错误只展示固定脱敏说明与现有 preflight 指引，不返回底层路径、token 或环境。

服务端返回过期时间，客户端按该时间安排刷新，避免双 60 秒周期叠加。显式重试可跳过已完成缓存，但仍复用当前同 key 探测；认证在缓存前校验。不引入通用健康设置平台。

## 3. RunPlan v2 设计

### 3.1 唯一规范化内容

新增 `digestVersion: 2`、`mode: workflow|goal`、完整规范化 `template`，保留展示摘要。模板包含 id/name/version/retryPolicy、phase 字段和顺序、node 输入输出/依赖/role、全部 gate 字段（含 commandRef、command.args/env、gateKey、retry/autoFix 等）。本次把已有字段纳入绑定，不新增并行调度语义。

完整 RunPlan 仅供内部持久化与校验。公开 `workflow.plan` 保留现有认证合同，但返回显式白名单构造的 `RunPlanPreview`：展示摘要、mode、digestVersion、内部完整计划计算出的 digest。禁止返回 template、原始 command.args/env 或完整 snapshot，禁止先删几个秘密字段再透传其余对象。客户端不对预览重算 digest；同步 RPC schema、context 类型与测试。真实 HTTP 无凭据/有凭据预览都不得包含模板中的秘密哨兵值，改变哨兵值仍须改变 digest。校验错误只输出代码/字段路径，不回显模板内容。

普通 canonical JSON 排序对象键、忽略 undefined，但保留嵌套名为 digest 的键，修复报告 §10.1 复核发现的嵌套 digest 丢弃问题。计算 RunPlan digest 时只排除顶层 digest。冻结旧 v1 递归排除算法供历史核验；新增固定历史向量和 `command.env.digest` 回归。

Engine 在首个异步边界之前深拷贝并规范化模板，构造执行事实。使用规范化结构的校验器，不把 `WorkflowTemplate` 重新交给原始 YAML parser（两者的 from/fromNodeId 等字段不同），不静默丢弃执行字段。`buildPreparedRun(input)` 是同步纯准备接口，不写目录、DB、Audit 或 Bus。准备对象含 repo/dataDir、需求来源、完整模板、canonicalPlan/snapshot/digest、kind、dirty 策略、Provider snapshot。最终执行计划只从此对象中的模板派生。

对 input/options 中每一份 canonicalPlan、planDigest、planSnapshot 都校验，不能用优先级吞掉冲突值。校验模式、模板来源、自洽摘要及重新投影的展示字段；snapshot 解析后必须与确认计划一致。持久化由 Core 重新序列化，不保存未校验的调用方原文。新 prepare 拒绝旧格式确认信息和未知版本，要求重新预览。

### 3.2 执行与恢复校验

executePreparedRun/resumeRun 共用只读校验，先于状态 CAS、resumed Audit、Worktree 和 Provider 执行。v2 snapshot/digest 必须自洽，持久化原始 phases/nodes 的 ID、顺序和可执行字段必须与 snapshot 派生结果一致；运行状态、时间戳和产物不参与比较。当前磁盘模板变化不影响已经受理的 Run。

合法 rework 会增加节点，不能简单要求全表等于初始模板，也不能放行所有 `_rework_` 名称。先验证 Audit hash chain，再按创建前 `gate.rework.needs-revision` 与 `gate.rework.attempt` 审计顺序，结合关联 GateResult 派生允许的额外节点：review/target 必须是基础节点或此前已证明的派生节点；结果必须属于同 Run 的 review 节点、类型为 independent-review、分类为 changes-requested，gateKey 精确匹配已证明 gate，attempt 为正整数且不超过允许次数。禁止悬空、跨 Run 和循环自证。

提取共享纯派生函数，创建和验证均按已证明 target 定义生成 `${targetNodeId}_rework_${attempt}`，复制 role/phaseId/inputs/outputs/gates，dependencies 为 `[reviewNodeId]`，order 为既有动态节点偏移。检查全部 DB 节点，包括无法分组的孤立节点；额外节点须逐字段匹配。基础节点按模板顺序，v2 额外节点按授权事件顺序追加至目标 phase，返回本次已验证的执行计划，不校验后再次无约束重读。未写 completed、或有授权意图但尚未创建节点是合法窗口；不据此补建节点。完整性检查允许合法 pending/running/interrupted 状态，但不将其外推为已验证任意中断的产物归属和重审闭环。测试须覆盖实际返工完成后暂停恢复、合法未完成节点的完整性检查、嵌套派生与伪造节点拒绝。无密钥 Audit 链是来源一致性证据，不防御持有全库写权限并重写整条链的人。

autoFix 的 repair 是另一类合法记录。GateRunner 在修改 source 状态/lease 和 createNode 前先持久化 `gate.repair.intent`（source、repair ID、gateResultId、gateType/gateKey、fixerRole、attempt/maxAttempts）；保留创建后的 `gate.repair.created` 供现有 eval 计数。校验 intent、同 Run/source 的未通过 GateResult、精确 gateKey、已证明 gate 的 autoFix/maxRetries 与次数，再派生 `repair_<gateResultId>`：role=source.role，无 phaseId，order=0，输入/输出/gates 为空，依赖仅 source。未创建节点的 intent 是合法窗口；created 前中断仍有 intent，不以 created-only 放行新 v2。未知孤立节点拒绝。

“来源合法”与“可以调度”分开：repair 不进入 Workflow 调度；现有 heuristic 可能选中 repair 作为 rework target，因此授权图允许原始节点、repair 和 rework 递归派生。无 phase 的合法派生节点只保留记录，有 phase 的 rework 才进入已证明 phase。此次不改 target heuristic 业务行为，不把记录合法性等同于完成任意断点恢复。

历史策略：无 admission 且无 snapshot/digest 的旧 Run 继续沿旧恢复路径，标记为未绑定历史计划；无版本 v1 使用冻结算法核验已存摘要，但不声称验证完整模板。新 admission 的 snapshot/digest 即使同时丢失，也必须拒绝而非 legacy 降级；v2 缺损、非法 JSON、未知版本同样 fail-closed。历史 repair/rework 不要求补 intent。不批量重算历史摘要，不用新模板替换旧节点。commandRef 的引用名参与绑定，但其解析的 repo-profile 命令、Provider/base 等可变环境尚未全部固化，仍属 #20 开放边界。

## 4. 原子与幂等 admission

### 4.1 单事务与完整写集

在共享 db/writeQueue 上提供专用 AdmissionStore。可由 repositories 暴露 store，避免各调用方重新创建连接。commit 只占一次 queue task，内部用同步 `db.transaction(...).immediate()`；不 await、调用异步 repository、发 Bus、执行 Git 或启动 Provider。复用/抽取内部同步 SQL 和 Audit hash helper，避免队列重入自死锁。常规 Audit.append（包括不显式传 db/writeQueue 的旧构造路径）也要在 BEGIN IMMEDIATE 内完成链头读取、单调时间分配和插入；仅进程内排队会让跨进程链头分叉，随后误伤 v2 恢复。admission 已持有事务时直接调用 helper，不重入队列。真实双进程向同 Run 并发追加后须无丢失且 verify.valid=true；不扩张为全域 outbox。

同一事务写 Demand、Project、WorkflowInstance、Provider snapshot、phases/nodes、`run.started` 及必需治理 Audit、Workspace 锁内 get-or-create、Session、三个 opening events、一个 queued Job、run_admissions。直接 Core prepare 无 Session 时可省略 Session/Job，但其领域写入也走同一个原子 store；不能保留非原子 fallback。Session 路径必须有完整 Provider snapshot。

直接 Core startRun 仅由 created 且目录 ready 的事务赢家调用 executePreparedRun；replayed 只返回既有运行当前状态，不自动 execute/resume。无 Session/Job 的直接 Core 在提交后崩溃，须显式受控恢复，不以重复 startRun 当作恢复。测试覆盖同 requestId 顺序/并发调用，Adapter 执行次数为一。

将 `onPrepared` 改为 `admissionAudits: {type,payload}[]`，迁移所有调用点和测试。任意异步回调不能作为事务内治理证据，也不能偷偷移到提交后。opening events 在事务内直接写一次，不经 dual-write 重复生成。Bus 只在 commit 后发布；发布失败不改变已受理结果，观察者可从持久事件补读。

新增表 `run_admissions`：request_id 主键、envelope_version/hash、唯一 run_id、可空且成对存在的 session_id/job_id、经校验的相对 data_dir、files_state（pending/ready/recovery_required）、脱敏 last_error、时间戳。各 ID 均以外键关联现有表；仓库根来自同事务 Project，runDir 由该根/data_dir/runs/runId 派生。恢复只依赖首次持久化路径，不用重试时的 options 猜目录。requestId 在当前仓库 DB 内唯一，不自动过期或清除。迁移是新增表，不推断旧 Run 的 requestId、不批量修补历史半成品。

### 4.2 信封与重放顺序

版本化信封 hash 绑定原始规范化提交意图：仓库物理作用域、需求文本或文件引用、mode/template/profile、Provider 选择、超时、dirty 策略、联网确认、客户端 planDigest。排除 token、requestId、时间戳；不把变化中的已解析文件正文或当前默认 Provider 混入重试指纹。首次受理的解析结果另存执行快照。缺省值按稳定 API 语义规范化。

文件引用按规范化引用身份入信封；调用方显式内联 workflowSpec、canonicalPlan/snapshot、显式 Provider/config/base/dataDir 等影响执行的 Core options 则按内容入信封，不能因没传 digest 而漏掉。排除不可序列化 runtime 句柄（Adapter、repository、Bus 等），但调用方提供的执行配置不得用句柄排除规则掩盖。直接 Core 同 requestId 只改内联 command/input/options 也必须报冲突。

入口顺序：认证/scope/语法 → 规范化信封与 requestId 查询 → 已受理则直接返回/恢复 → 未受理才读需求卡/模板、检查 clean-base、执行 Provider preflight → buildPreparedRun → 事务锁内再次查重并提交。同 requestId 同信封返回原 run/session/job；同 requestId 不同信封报 `REQUEST_ID_CONFLICT`。跨进程唯一性来自 SQLite 锁内复查与唯一约束，不来自进程内缓存。初查未命中后，环境校验失败时应再次按 requestId 查找；若另一进程已受理则返回赢家结果，否则只陈述本次失败，不能承诺其他在途调用永不受理。所有结果都保留 requestId。

SessionService 也必须在 createEngine/preflight 之前查重；直接 Core prepare 同样支持 requestId，默认内部生成。CLI/Web 不得因已受理之后仓库变脏、模板/需求文件变化或 Provider 暂不可用而误拒绝重放。

### 4.3 文件就绪、恢复与 Job 认领

当前文件准备仅为 `runs/runId` 空目录。先提交 files_state=pending，再幂等 mkdir、确认目录真实处于预期路径且非错误类型，CAS 为 ready；失败记录 recovery_required，保留全部 ID。检查目标路径和符号链接边界，不能跟随越出受控目录的链接进行写入。DB 状态更新失败可在重试时检查已有目录再补齐，不删除目录或重新创建 Run。

Job claimNext 按 Job→Session→Run→admission 排除全部未 ready 的新 Run，不只过滤初始 jobId；无 admission 的旧 Job 保持兼容。低层 Engine execute/resume 也须检查 admission 就绪，不能绕过 runner。目录恢复只改 files_state，不重置已取消/终态 workflow/job，不重复 Audit、opening events 或 enqueue。ready 不可被迟到失败降级。

恢复入口为同 requestId 重试，以及 CLI/Web composition 启动时的 pending/recovery_required 扫描；所有组合根先迁移，再扫描，最后启动 runner。SessionService.resumeRun 在 stale Job cleanup 之前检查/恢复 admission；底层 stale cleanup 排除未 ready Job，不能把初始 jobId 替换掉。CLI 未恢复成功立即返回需恢复状态，不无限等待 queued Job。Web 利用现有轮询，无需提交时额外 enqueue。

崩溃保证限于 SQLite 事务和本地目录恢复；不声称 Git/普通文件/外部命令都在一个事务内，也不声称解决全部跨进程执行 owner 或物理断电问题。

## 5. 前端请求生命周期与运行依赖

QueryCache 对每个缓存 key 管理请求身份和 epoch（递增代数，用于判定发布权）；仅当前 owner 可以写共享数据和错误、通知订阅者。发起者与加入者更新本地状态时同样核验该身份，不能绕过共享缓存隔离。清 scope/清登记撤销旧请求发布权，旧 resolve/reject 只能结算自身 Promise。新请求完成清登记后也不能让旧请求重新获得发布权。

移除当前未连入 fetcher 的组件 AbortController；本次只撤销旧请求的写入权，不实现物理取消网络请求，注释与文档不得声称已取消。单个组件卸载不能取消其他消费者共用的请求。保留 R23-03 的 owner-only finally。AuthProvider 在 setToken 同步切换阶段、新 scope query Effect 开始前撤销旧 scope 请求；不能保留父 passive Effect 清除全部登记的旧实现，否则子 Effect 刚发出的新凭据请求也失去发布权且可能永远 loading。真实 AuthProvider A→B 验证 B 无需等待轮询即可完成，同时旧结果不可见。

将 Web 的 tsx、vite、@vitejs/plugin-react 从 devDependencies 移至 dependencies，同步 lockfile；它们均被现有 `tekon ui` 正常启动链加载。保留 `pnpm audit --prod` 的 fail-closed 和一次有限传输重试逻辑；不为了审计重构服务器打包，不宣称新发现具体漏洞。

## 6. 实施顺序与协作所有权

1. 最高等级 subagent 对本方案做技术 review，另做文档可读性 review；必须修复项改完再复查，明确无必须修复项后实施。
2. 先写失败测试，再实现 RunPlan 纯准备/绑定；admission store/schema/事务测试可独立并行开发，但 engine 接口由同一 owner 修改，按已约定 PreparedRun 接口集成。
3. 后端 admission 接口稳定后迁移 SessionService、CLI/Web 组合根与路由；前端 owner 同步共享提交 hook、状态和 e2e。禁止并行修改同一文件。
4. 主代理维护文档、版本、依赖审计集合，负责整合和唯一全量测试运行；workers 只跑其定向 lane，运行前报告范围。
5. 独立 code/test reviewer 与实现者分离，循环至无必须修复项；再执行全量验证和完成度审阅。

## 7. 验收矩阵与交付门

| 层面 | 必须验证 |
| --- | --- |
| 计划 | 完整模板字段/mode/env.digest 反向测试；等价规范化；所有混源 input/options/snapshot；首个 await 外部 mutation；拒绝前零副作用 |
| 恢复 | v2 DB 字段损坏/缺节点/未知额外节点；合法 rework/repair 来源与调度分类；真实返工/autoFix 后暂停恢复；intent/节点/created 边界故障；v1/无快照历史；新 admission 丢失两份计划字段仍拒绝 |
| 原子性 | 真实 SQLite 对各写表、必需 Audit、三个 opening events、Job 注入失败；所有新增行回滚、无目录/Bus |
| 幂等性 | 顺序/两个独立进程同 requestId 同内容；不同内联内容/options 冲突；一套身份、Audit、opening events 前缀与初始 Job；直接 Core 重放不执行 |
| 崩溃/文件 | 事务中退出、commit 后 mkdir 前退出、mkdir 后 ready 前退出；重启恢复同 ID；文件失败/类型错误/链接越界；ready 单调 |
| 调度 | pending 零执行；取消不复活；resume/stale cleanup 不替换未就绪初始 Job；直接 Engine 不绕过；Bus 失败不导致重建 |
| 入口 | 已受理后环境变化仍可重放；CLI --request-id 真进程；HTTP 查询未找到仍保留原请求身份；Web 丢响应/双击/同凭据刷新/换仓库；公开预览无模板秘密 |
| 前端 | A→B→A、旧成功/失败、同缓存 key 两消费者/一个卸载；真实 AuthProvider 新请求不被清除；延迟 hash 编辑/换凭据不误提交；Provider 延迟/500/重试；过期计划刷新 |
| Audit | 双进程同 Run 并发追加链不分叉；默认和显式 db/writeQueue 两种构造均覆盖 |
| 全量 | `pnpm test`、全包 typecheck/build、CLI e2e、Web Playwright 全套、生产 Audit；一种测试/构建同时只有一个 active run |
| UI | 稳定状态截图目视，320/390/700/1440px：TopBar、简单/高级发起、需恢复状态、Session；无横溢/遮挡/错位，交互可达 |

交付前检查文件存在、关键内容非空、无占位符、Markdown/HTML 同步、链接和章节可读。同步 README、CHANGELOG、主用户手册 MD/HTML、当前评审入口及相关正式技术 HTML；AGENTS 只在规则改变时修改，本轮预期无需改；安装/更新脚本未改则不触发其全流程 smoketest。

最终报告区分已测事实、判断和未测范围，记录真实命令、Run/风险 Gate/eval 摘要（如执行了正式 Tekon 验收 Run）及已公开 CI 链接。提交前必须 `pnpm test` 全绿，根/Core/CLI/Web 版本 lockstep，集中提交并推送原 PR，监控最终 Head checks；不合入、不发布、不部署。临时构建/浏览器产物只清理本轮明确归属的目标，不清除历史运行数据。

## 8. 资料与判断依据

- [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)：资料解释数据库事务的提交原子性；据此选择同步事务，但不把文件/Git 纳入同一保证。
- [React useEffect](https://react.dev/reference/react/useEffect)：资料区分 Effect 清理和异步结果过期；据此将共享缓存发布权与组件生命期分开。
- [DSH 0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)、[固定版本 CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/apps/cli/reference/README.md)：上游已有 Session 生命周期/锁和 headless quiescence/flush 机制；Tekon 当前仍是 one-shot Adapter，不能据此声称持久协作已实现。tested pin 保持 `0.1.2-alpha.3`。
- 本地基线证据：`workflow/run-plan.ts`、`workflow/engine.ts`、`session/session-service.ts`、`db/write-queue.ts`、`client/hooks/use-query.ts`、`client/layouts/TopBar.tsx`、`cli/commands/ui.ts`；详细固定 SHA 链接与独立复现见第 23 轮报告批注。
