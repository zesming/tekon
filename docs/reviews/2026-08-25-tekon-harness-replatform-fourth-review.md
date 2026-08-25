# Tekon Harness Replatform 第四轮全面复审

> 复审日期：2026-08-25  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 实施方增量基线：`d61907ea994b3a75580882d0016125efcba63c43`  
> 本轮评审修改：`414aed9df3a7448a8512ec229bf78b7635802315`、`7c569c1df7909d369c7fdfcb1436d713c073abe7` 以及本报告提交  
> 复审维度：产品逻辑、信息架构、UI 实现、UX 交互、Agent Runtime、Session/Event/Job 架构、并发恢复、代码正确性、安全与治理边界、测试可信度。  
> 视觉评审边界：本轮检查了 React/CSS、RPC、数据流和现有 Playwright 路径，但没有把代码阅读冒充为独立截图式人工视觉验收；颜色对比、完整键盘遍历、真实长内容布局和屏幕阅读器行为仍需浏览器专项审计。

---

## 1. 最终结论

# **不通过**

第四轮不能给出“通过”。而且相较第三轮，结论需要进一步收紧：

1. **产品主闭环仍未完成**：主力 Provider 仍是一次性 `Promise<AgentRunResult>`；Session 内没有 follow-up / steer；默认入口仍是完整 `standard-delivery`，没有真正的轻量协作模式。
2. **本轮发现了新的基础设施级合并阻断项**：当前 ownership fencing 主要依赖进程内 `AbortSignal` 和轮询，但 Job/Node 的持久化写入并未绑定 owner/generation，Workflow 成功路径、Gate 成功路径、rework 路径和 shutdown 超时路径仍可能让旧执行器继续写状态或提升分支。
3. **绿色 CI 不覆盖这些关键竞态窗口**：当前测试主要覆盖异常/失败后的 stand-down，没有完整覆盖“Gate 成功后被 fence”“checkpoint 写前 owner 已变”“rework 成功路径被 fence”“stop 超时后执行器仍在运行”等情况。
4. **实施方对第三轮报告的部分批注是正确的**，本报告已主动纠正；但“已经披露局限”不等于“能力已经完成”，也不等于可以忽略新发现的并发正确性问题。

### 1.1 分层裁决

| 验收对象 | 第四轮结论 |
| --- | --- |
| 作为普通用户的人类协作产品 | **不通过** |
| 作为完整 Harness-inspired Agent Runtime | **不通过** |
| 作为 Event Spine / Durable Job / Session UI 基础设施 PR | **暂不建议合并**；先修复本报告 F4-P0-01～F4-P0-04 |
| 单进程、Mock Provider、无恢复竞争的开发实验 | 可继续使用，但不能外推为多进程恢复正确性 |
| 现有 Workflow / Gate / Artifact / Delivery 治理资产 | 仍有价值，应保留并继续插件化 |

### 1.2 更新评分

| 维度 | 第二轮 | 第三轮后实现 | 第四轮判断 | 说明 |
| --- | ---: | ---: | ---: | --- |
| Agent 自动执行底盘 | 8.0 | 8.0 | 7.5 | 治理能力强，但 success-path fencing 与 rework 副作用存在风险 |
| 后台 Job 与恢复 | 7.0 | 7.5 | 5.5 | 有 durable job/lease/recovery，但 owner/generation 未进入数据库条件写 |
| 事件与可回放性 | 6.5 | 6.5 | 6.0 | replay/SSE 好于第一轮，仍是 best-effort projection |
| 人类输入体验 | 4.5 | 4.5 | 4.5 | 默认入口更诚实，但仍不能在 Session 中继续对话 |
| 过程可见性 | 5.0 | 5.0 | 5.0 | Feed 连续，但主流 Provider 仍非真实增量事件 |
| 人类干预能力 | 3.5 | 3.5 | 3.5 | pause/cancel/approval 有改善；follow-up/steer 仍缺失 |
| 输出可读性 | 4.5 | 5.0 | 5.0 | synthetic 标识、状态播报改善；Final Result 仍过于浅层 |
| 架构扩展性 | 7.0 | 7.0 | 6.5 | seam 增多，但 runtime/session/job 事实源仍分裂 |
| 并发与恢复可信度 | 5.5 | 6.0 | 4.5 | 错误路径有保护，成功路径与持久化 CAS 仍未闭环 |
| 测试与 CI | 8.0 | 8.5 | 8.0 | 全栈 CI 已有；关键竞态尚无 deterministic regression lock |
| 普通用户发布信心 | 4.5 | 4.5 | 4.0 | UX 有局部改善，产品主闭环和运行时可靠性仍不足 |

---

## 2. 对第三轮批注的事实纠偏

实施方在第三轮报告后追加了详细批注。第四轮逐条复核后，以下纠偏应正式吸收到结论中。

### 2.1 第三轮关于写前脱敏的回归判断是误报

当前 `agent-step-events.ts` 的顺序是：

```text
prompt/error
→ redactSecrets(...)
→ 截断/摘要
→ sink(...)
→ SessionEventStore
```

因此“先持久化、后脱敏”的第三轮描述不成立。现有 F-08 回归测试也继续覆盖 prompt summary 和 error message。

**第四轮处置：撤销该回归项，不再列为阻断。**

### 2.2 浏览器 bootstrap 仍未实现

第三轮表格曾把一次性 bootstrap 标记得过于乐观。当前 `tekon ui` / Web 鉴权仍依赖用户手工设置 session token；HTTP 路由要求 header token，没有一次性 nonce、短 TTL 消费或自动浏览器 handoff。

**第四轮处置：恢复为 P1 UX/安全启动缺口。**

### 2.3 Goal 模式默认是 fail-closed，而不是无审阅地推广源码变化

`goal` 节点没有 `code-changes` output 时，`nodeAllowsSourceChanges()` 为 false；`finalizeExecutionLease()` 会在 commit/promote 前调用 `inspectLeaseSourceChanges()`，检测到源码变化即失败。因此此前“Goal 可直接把未治理代码推广到 run branch”的说法不准确。

**第四轮处置：撤销安全阻断描述。Goal 仍是实验性只读/失败关闭模式，产品问题主要是用户预期和反馈不够清晰。**

### 2.4 响应式断点已经存在

`packages/web/src/client/styles/sessions.css` 在 860px 下把两栏布局折叠为单栏。第三轮若把“没有响应式实现”作为事实判断是不准确的。

**第四轮处置：改为“已有基础断点，但尚无真实窄屏截图、长内容和触控验收”。**

### 2.5 Delivery approval 内容身份主要是治理可信度问题

当前创建 PR 仍要求本次显式人工动作，持久化的旧 `approvedBy/approvedAt` 没有直接绕过 fresh create-pr confirmation。没有绑定 head/body/package hash 的真实影响主要是：

- 审批记录可能与当前内容不一致；
- 审计与评估指标可能误把旧批准当成当前批准；
- 后续若有人开始消费 persisted approval，风险会被放大。

**第四轮处置：从直接权限绕过降级为 P1 治理完整性硬化。**

---

## 3. 最新增量实际完成了什么

实施方最新提交 `d61907e` 主要完成：

- Session 连接状态与空状态增加 `role="status"` / `aria-live="polite"`；
- 增加 `prefers-reduced-motion` 处理；
- Playwright 增加对应可访问性断言；
- 删除用于评审阶段的自修改 GitHub Actions / 脚本；
- 在第三轮报告中追加实施方事实核验和异议说明。

这些改动是正向的，但没有新增以下核心能力：

- Codex/Claude 实时增量 runtime；
- Session follow-up / steer；
- durable input inbox；
- Collaborate / Deliver 真正双轨；
- canonical Session log；
- durable automation projector；
- startRun 原子事务；
- 一次性浏览器 bootstrap；
- 长 Session 分页/虚拟化。

第四轮评审额外顺手修改：

1. `SessionComposer` 明确告知用户当前会启动 `standard-delivery` 的 PM/RD/QA/Reviewer 受控交付全链路，避免把它伪装成轻量聊天；
2. 给 Pause / Resume / Cancel / View 等图标按钮增加可访问名称。

这些是诚实性和可访问性修复，不会被计作产品主闭环完成。

---

## 4. 本轮新发现的合并阻断项

## F4-P0-01 Job 持久化 fencing 仍是 TOCTOU：写入没有 owner/generation 条件

**严重级别：Critical**

`JobRepository.updateJob()` 当前 SQL 仅按 `job_id` 更新：

```sql
update jobs set ... where id = @jobId
```

它没有同时约束：

```text
owner
execution generation / claim token
expected status
```

而 `JobRunner.writeCheckpoint()` 的顺序是：

```text
updateJob(checkpoint)
→ 读取返回行
→ 检查 owner 是否仍是 workerId
```

也就是说，若 owner 在写入前已经变化，旧执行器可能**先覆盖新 owner 的 checkpoint/updated_at，再发现自己失去 owner**。检查发生得太晚。

相同问题还存在于：

- heartbeat：无条件刷新 lease；
- settle：先读 current.owner，再无条件写 terminal status；
- abort state 更新；
- pause/cancel 的部分状态写。

进程内 `executionTokens: Map<string, symbol>` 只能隔离同进程执行代际，无法成为跨进程数据库 fencing token。

### 影响

- stale worker 可以刷新 lease，使真正 stale 的 job 看起来仍活跃；
- stale checkpoint 可以覆盖新 owner 的恢复位置；
- owner 在 settle 的读写间变化时，旧 worker 可能覆盖新 owner 状态；
- 测试中“先改 owner，再让旧 executor settle”不足以覆盖“owner 在读写之间变化”。

### 必须修复

Jobs 表增加持久化执行代际，例如：

```text
claim_generation INTEGER NOT NULL
```

每次 claim/reclaim 原子递增，并让所有 owner-sensitive 写使用条件更新：

```sql
update jobs
set ...
where id = :id
  and owner = :owner
  and claim_generation = :generation
  and status in (...expected statuses...)
```

heartbeat、checkpoint、abort propagation、settle 都必须检查 `changes === 1`。不能再采用“先写、后检查”。

---

## F4-P0-02 ownership loss 在 Workflow 边界仍会被解释成用户取消

**严重级别：High**

`executePlan()` 在节点开始前和写入最终 `passed` 前使用：

```ts
if (options.signal?.aborted) {
  await settleCancelled(...)
}
```

这里没有区分：

- 用户取消；
- ownership lost fencing；
- server shutdown；
- 其他内部 abort reason。

当旧 worker 因 job 被新 owner reclaim 而收到 `JOB_ABORT_REASON_OWNERSHIP_LOST`，它在下一个节点边界仍可能调用 `writeWorkflowTerminal(..., 'cancelled')`。

如果新 owner 尚未写入终态，旧 worker 就可能把共享 Workflow 直接取消；这不是用户意图，而是 stale executor 的错误副作用。

### 必须修复

引擎边界必须使用明确的 abort classifier：

```text
ownership lost → silent stand-down，不写 Workflow/Node/Lease
user cancel    → cancelled
shutdown       → fence + recoverable interrupted/queued policy
```

所有 `signal.aborted` 的裸判断都应审计，不能只修 NodeExecutor 的 catch/finally 分支。

---

## F4-P0-03 Gate/Node/Rework 的成功路径没有形成一致 fencing 边界

**严重级别：Critical**

当前修复主要覆盖失败和异常路径，但成功路径仍有空洞。

### 4.3.1 Gate 成功结果在 fence 检查之前返回

`gate-runner.ts` 当前先执行：

```ts
if (result.status === 'passed' || result.status === 'skipped') {
  return true;
}
```

ownership-loss 检查位于非 passed 分支之后。因此如果 Gate 刚返回 passed，同时 owner 已被新 worker 接管，旧执行器仍会把它当作合法成功继续运行。

### 4.3.2 Node 成功路径继续 finalize lease 和写 passed

Gate 返回 true 后，`node-executor.ts` 会继续：

```text
recordQaValidationRef
→ finalizeExecutionLease
→ checkedTransitionNode(..., passed)
```

成功路径上没有可靠的 durable owner/generation 校验。仅在 catch 中检查 `AbortSignal` 不能关闭“检查之后、promote 之前”的竞态。

### 4.3.3 Rework 没有统一的 signal/fence 生命周期

`ReworkHandlerDeps` 没有 owner-generation/fence capability；rework agent、review rerun、目标 Gate、lease finalize 和节点回写分散执行。虽然底层 CommandGateway 可能继承 job signal，但业务流程本身仍会：

- 在 finally 中 finalize lease；
- transition rework/target/review node；
- alias lease；
- promote run branch；
- 重新执行 review。

这意味着被 fence 的旧 rework 流程仍可能继续制造状态和 Git 副作用。

### 4.3.4 `git branch -f` 不是具备预期旧值的原子提升

`promoteLeaseToRunBranch()` 使用：

```text
git branch -f <run-branch> <lease-branch>
```

它没有校验 run branch 是否仍指向本执行器预期的 old SHA。即使 signal 检查正确，检查与 `branch -f` 之间仍有窗口。

### 必须修复

- 把持久化 claim generation 贯穿 Agent、Gate、Node、Rework、Lease；
- 在 commit/promote 前重新验证 generation；
- 使用 compare-and-swap 式 ref 更新，例如带 expected old SHA 的 `git update-ref`；
- Gate passed、repair passed、rework passed、Node passed 前都需要相同 fence；
- rework agent 和 review rerun 必须接收并处理 job signal；
- ownership lost 只能 stand down，不能 finalize、promote 或回写共享节点。

只增加更多 `if (signal.aborted)` 仍不足以关闭数据库和 Git 的 TOCTOU。

---

## F4-P0-04 JobRunner.stop() 超时后并未真正 quiesce 执行器

**严重级别：High**

`stop()` 当前行为：

1. 停止 poll；
2. 最多等待 in-flight promise 5 秒；
3. 清除 heartbeat；
4. 清空 controller/token/pause maps；
5. 返回；
6. Web composition root 随后关闭 SQLite DB。

若执行器 5 秒后仍未退出，`stop()` 没有：

- abort 所有 controller；
- 使用 shutdown-specific reason；
- kill subprocess registry；
- 等待 child process 退出；
- 阻止 pending executor 随后访问已关闭 DB；
- 把 job 可靠交给下一 owner。

清空 controller map 并不会停止 promise 或子进程，只是丢失控制句柄。

### 影响

- server shutdown 后旧 Agent/命令仍可能修改 worktree；
- 执行器可能对已关闭 SQLite 连接继续写入；
- heartbeat 被清除后，新 server reclaim job，旧执行器仍在运行；
- 形成与 ownership-loss 相同的双执行问题。

### 必须修复

建议两阶段 shutdown：

```text
stop accepting jobs
→ abort all controllers with JOB_ABORT_REASON_SHUTDOWN
→ kill registered children
→ wait for executor/child quiescence
→ persist recoverable job state
→ close DB
```

若必须设超时，超时后不能仅丢弃句柄；应确保旧执行器再无共享写权限，并让下一 owner 使用新的 generation。

---

## F4-P0-05 Node 状态仍是 read-validate-unconditional-write

**严重级别：High**

`checkedTransitionNode()` 当前：

```text
getNode
→ assert transition
→ transitionNode(nodeId, status)
```

`transitionNode()` 只按 node id 更新，没有 expected-from、workflow terminal、owner 或 generation 条件。

Workflow terminal row 已有较好的 CAS writer，但这不能自动保护 Node 表。跨进程 stale/new owner 竞争时，旧 worker 仍可能：

- 把新 owner 已 passed 的 node 改成 awaiting-gate/interrupted；
- 让 Node 与 Workflow 终态不一致；
- 影响恢复计划、UI 和后续审计。

### 必须修复

提供类似：

```text
transitionNodeIfOwned(nodeId, expectedFrom, owner, generation, to)
```

并让 Node transition 与 Job generation 关联。至少所有 worker-owned 执行路径不能使用无条件 `transitionNode()`。

---

## 5. 产品主闭环仍未完成

## PRODUCT-P0-01 主流 Provider 仍不是实时 Agent Loop

Codex 和 Claude Code adapter 的核心仍是：

```ts
runAgent(input): Promise<AgentRunResult>
```

`runAgentWithStepEvents()` 的实际过程是：

```text
step/start
→ await 整个 adapter.runAgent()
→ 根据最终结果合成 tool/call / tool/result / assistant/message
→ step/end
```

这不是模型实时输出，也不是工具真实生命周期。

### 官方能力对照

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 将 durable `assistant/chunk`、`assistant/message`、`tool/call`、`tool/result` 与 live `agent/*` 控制分层，并要求 model-visible context 可从 Session log 重建。
- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) 已提供 long-lived JSON-RPC、Thread/Turn/Item、`item/started`、`item/completed`、`item/agentMessage/delta`、工具进度、审批和 interrupt。
- [Claude Code headless](https://code.claude.com/docs/en/headless) 已支持 `--output-format stream-json --verbose --include-partial-messages`；[Claude Agent SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output) 也能输出 partial message 和 tool-use events。

Tekon 没有必要继续从“一次性进程退出后的最终结果”反向猜测实时事件。

### 验收要求

至少先选择一个主力 Provider：

- Codex：接入 App Server；或
- Claude：接入 Agent SDK / stream-json。

并证明：

- 第一个 assistant delta 在进程结束前到达 UI；
- tool call/result 来自 Provider 真实事件；
- cancel/steer 作用于当前 turn；
- reconnect 能从 durable chunks 重建同一 final message；
- final message 引用组成它的 chunk seq。

---

## PRODUCT-P0-02 Session Detail 仍不能 follow-up / steer

`LegacyAgentDriver.followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`；Session router 只有 list/get；Session Detail 只展示 EventFeed 和 SidePanel，没有底部输入框。

当前产品是：

```text
启动一次 Workflow
→ 在 Session 页面观看投影
```

而不是：

```text
用户消息
→ Agent turn
→ 用户补充/纠偏
→ 下一 request 消费
→ 状态与上下文可恢复
```

### 验收要求

- durable inbox/message table 或 canonical Session event admission；
- `follow-up` 与 `steer` 有明确语义：排队下一 turn、注入下一 request、或中断当前 step；
- UI 显示 queued / admitted / consumed / failed；
- 重复提交幂等；
- server restart 后 pending input 仍存在；
- Provider 不支持时明确拒绝，而不是仅写一条看似已发送的 event。

---

## PRODUCT-P0-03 Collaborate 与 Deliver 仍未形成真正双轨

当前默认 Session Composer 仍调用 `project.run`，服务端默认：

```text
mode = workflow
template = standard-delivery
```

普通一句话会进入 PM/RD/QA/Reviewer 全链路。

第四轮已经把该事实直接写进 Composer，降低误导，但这只是信息披露，不是产品模式完成。

### 目标产品模型

```text
Workspace
├─ Collaborate（默认）
│  ├─ 连续消息、计划、工具、变更
│  ├─ 轻量权限
│  ├─ 风险触发审批
│  └─ 需要时升级 Deliver
└─ Deliver
   ├─ Demand / Workflow / Role
   ├─ Gate / Artifact / Readiness
   ├─ Review / Delivery
   └─ PR 人工确认
```

模式必须由后端 profile/capability 决定，而不是仅靠按钮文案或前端下拉框。

---

## 6. UI / UX 评审

### 6.1 已有进步

- 默认入口已是 Session-first；
- continuous feed 比旧多页签更容易理解；
- synthetic Assistant 内容有“摘要”标识；
- inline approval 复用原 Gate 语义，没有从前端绕过审批；
- 连接状态有非打断式 live region；
- reduced-motion 已处理；
- 两栏在窄屏下有基础折叠；
- 本轮补齐 RunControls 图标按钮的可访问名称；
- 本轮明确提示默认是受控交付全链路。

### 6.2 Session 页面仍是“观看器”，不是“工作台”

详情页没有固定 composer、pending input、plan editor、diff inspector、tool detail、retry/recovery action。用户能做的主要是：

- 看事件；
- pause/resume/cancel；
- 审批。

这仍然是 Workflow Cockpit 的单页叙事版，而不是 Agent 协作产品。

### 6.3 Final Result 过于浅层

当前 Final Result 基本是：

```text
运行结束 · status
产物 N · 错误 M
```

它没有汇总：

- 实际修改的文件；
- 测试/build/lint 结果；
- Gate 证据；
- 关键决策；
- 剩余风险；
- 未完成事项；
- PR/Delivery 下一动作。

完成页不能要求用户重新翻 Feed 和 Advanced 才理解结果。

### 6.4 RunControls 的状态来源不够可靠

SessionSidePanel 从 Session Events 推导 `runStatus`，但当前 event log 又被明确标记为 best-effort projection。若 dual-write 丢事件，UI 可能：

- 在已完成任务上继续显示 Pause/Cancel；
- 不显示 Resume；
- 不显示 Final Result；
- 显示错误的审批状态。

建议：

- authoritative Session/Job/Workflow status 通过 query 获取；
- SSE event 只驱动 narrative 和 query invalidation；
- UI 不应把 best-effort projection 当控制权限的唯一事实源。

### 6.5 长 Session 会产生明显的前端复杂度退化

当前：

- 服务端 `listEventsSince()` 无 limit；
- hook 永久保留所有事件；
- 每到一个新事件，`mergeEventsBySeq()` 重新遍历全部历史；
- 每次 render，`groupEventsByTurn()` 复制并排序全部事件；
- Feed 全量挂载 DOM。

这会形成接近 O(n²) 的累计客户端工作量。长程研发任务出现数千或上万事件时，不应依赖“典型 run 目前不多”作为设计保证。

需要：

- server pagination + bounded replay page；
- SSE 仅 tail；
- virtualized/windowed feed；
- step/tool 默认折叠；
- 搜索和类型过滤；
- spill 内容按需读取；
- 用户离开底部后停止强制自动滚动。

### 6.6 视觉与可访问性仍需真实浏览器专项验收

后续应加入：

- axe；
- keyboard-only walkthrough；
- focus visible / focus order；
- 320/768/1024/1440 截图；
- 200 字错误、长命令、超长 diff、1000+ event fixture；
- screen reader announcement；
- zoom 200%；
- reduced motion 实测。

DOM 属性测试只能证明属性存在，不能证明完整体验可用。

---

## 7. 架构评审

### 7.1 当前仍然是四套事实并存

```text
Workflow / Node / Gate / Artifact tables
Jobs / leases / checkpoints
Session Event projection
Audit hash chain
```

它们之间目前主要依赖 best-effort dual-write 和业务层顺序调用，而不是统一 transaction/outbox/projector。

这会不断产生：

- 状态与事件不一致；
- UI 与控制面不一致；
- 恢复点与实际副作用不一致；
- 新 owner 与旧 owner 竞争；
- 审计记录完整但事实已经被另一张表改写。

### 7.2 Session Event 仍不是 canonical source of truth

DeepSeek Harness 的关键不是“拥有一个 event 表”，而是：

> model-visible means logged；模型上下文、resume、fork、replay 都从同一 log 派生。

当前 Tekon 的 prompt/context 仍主要来自 legacy Workflow/Artifact 数据；Session event 丢失不会阻止执行，说明它不是 runtime 的事实源。

推荐迁移顺序：

1. user input、assistant output、tool result、approval 必须 durable append 成功；
2. legacy state write 使用 transactional outbox；
3. projector 有 checkpoint 和幂等键；
4. model request 从 Session surface 派生；
5. 建立“所有 model-visible input 都可从 log 重建”的 invariant test；
6. 最后再移除 best-effort dual-write。

### 7.3 Automation 仍依赖 process-local bus

readiness 和 auto-prepare listener 只订阅当前进程 EventBus。另一个 CLI/Web 进程写入 SQLite event，不会由 durable projector 补消费。

应改为：

```text
session_events
→ durable projector cursor
→ idempotent enqueue
→ transactional checkpoint/outbox
```

SSE 的 DB catch-up 已证明跨进程读取可行；Automation 不应停留在 process-local listener。

### 7.4 startRun 仍不是原子操作

当前大致顺序：

```text
create demand/project/workflow/plan
→ create workspace/session
→ append opening events
→ enqueue job
```

任一步失败都会留下 partial state。需要 repository-level transaction，或至少带 idempotency key 的 saga + compensation。

### 7.5 Profile 仍更像标签，不是完整 capability boundary

已有 `human-web / autonomous-delivery / review-only` 及纯函数 policy，但主运行链中 Profile 主要影响 session metadata 和 auto-prepare；它尚未统一约束：

- filesystem write；
- shell/network；
- tool approval；
- source mutation；
- delivery capability；
- AgentDriver 选择。

目标应是 capability context，而不是散落的 `if profile === ...`。

---

## 8. 代码实现质量

### 8.1 做得好的部分

- Workflow terminal writer 使用 CAS，终态单调性比第一轮明显改善；
- queued cancel、cross-process cancel relay、SSE catch-up、Session seq 分配都有针对性测试；
- secret redaction 仍在 durable sink 前；
- synthetic/real Assistant 输出有区分；
- 旧 Cockpit 没有被粗暴删除；
- Provider snapshot 与 async job rebuild 边界清晰；
- DSH bridge 对 one-shot、network acknowledgment 和 developer-preview 边界描述较诚实。

### 8.2 主要结构性问题

- worker ownership 没有成为 repository API 的类型与 SQL 前置条件；
- `AbortSignal` 被承担了持久化 fencing token 的职责，但它只能表达进程内通知；
- `transitionNode()` / `updateJob()` 等危险裸写仍对所有调用者公开；
- lease promote 没有 expected old ref；
- rework/gate/node 各自重复实现中断语义，容易漏路径；
- runtime event contract 与 adapter final-result contract 不一致；
- Session UI 控制状态依赖 best-effort event projection。

### 8.3 推荐抽象

```ts
interface ExecutionFence {
  jobId: string;
  owner: string;
  generation: number;
  signal: AbortSignal;
  assertOwned(): Promise<void>;
}

interface FencedJobRepository {
  heartbeat(fence: ExecutionFence): Promise<void>;
  checkpoint(fence: ExecutionFence, value: string): Promise<void>;
  settle(fence: ExecutionFence, status: JobStatus): Promise<void>;
}

interface FencedWorkspaceLease {
  commit(fence: ExecutionFence): Promise<CommitResult>;
  promote(fence: ExecutionFence, expectedRunHead: string): Promise<string>;
  release(fence: ExecutionFence): Promise<void>;
}
```

业务代码不应自行组合 `get → if owner → update`。

---

## 9. 测试缺口与新增验收标准

现有全量 CI 继续必要，但不足以证明本报告中的并发语义。

### 9.1 合并前必须增加的 deterministic tests

#### T1：checkpoint owner-change race

```text
old worker 进入 checkpoint
→ 在 update 前切换 owner/generation
→ old checkpoint SQL changes 必须为 0
→ new checkpoint 不被覆盖
```

#### T2：settle owner-change race

```text
old worker 读取 current owner
→ 切换 owner/generation
→ old settle 尝试 done
→ job 保持 new owner 的 running/terminal 状态
```

#### T3：ownership loss at plan boundary

```text
node 完成
→ job 被新 owner reclaim
→ old worker 在下一 node boundary 观察 ownership-lost
→ Workflow 不得写 cancelled/interrupted/passed
```

#### T4：successful gate fence

```text
Gate 返回 passed
→ 在 Node finalize 前发生 reclaim
→ stale lease 不得 commit/promote
→ stale node 不得 passed
```

#### T5：rework success fence

```text
rework agent 成功
→ finalize/promote 前发生 reclaim
→ old rework/review rerun 全部 stand down
→ run branch 不回退
```

#### T6：shutdown timeout

```text
executor 忽略 5 秒
→ stop()
→ signal 必须 aborted
→ registry child 必须 killed
→ close() 后不得再写 DB/worktree
```

#### T7：Git ref CAS

```text
new owner 已更新 run branch
→ old owner promote with expected old SHA
→ update-ref 必须失败，不得 branch -f 回退
```

### 9.2 产品里程碑测试

- Codex 或 Claude 至少一个真实 delta-before-exit smoke；
- tool call/result 来自 Provider 事件；
- Session follow-up/steer E2E；
- pending input restart recovery；
- Collaborate 与 Deliver 后端策略对照测试；
- one-time bootstrap replay/TTL/origin 测试；
- 10,000 event Session 的 server/client 性能门槛；
- axe + keyboard + responsive screenshot audit。

---

## 10. 推荐实施顺序

### Milestone 0：先关闭并发正确性红线

1. Jobs 增加 persistent claim generation；
2. owner/generation-conditioned heartbeat/checkpoint/settle；
3. ownership-loss boundary stand-down；
4. Node transition CAS；
5. Gate/Node/Rework success-path fencing；
6. Git expected-ref CAS；
7. shutdown quiescence。

在这些完成前，不建议继续扩展更多 UI/profile，因为新的表面会建立在不可靠执行所有权上。

### Milestone 1：单一真实 Provider 的 Agent Loop

优先选 Codex App Server 或 Claude Agent SDK，只完成一条真正闭环：

```text
user message
→ turn/start
→ assistant chunks
→ tool call/result
→ approval
→ follow-up/steer
→ final message
→ turn/end
```

### Milestone 2：Collaborate / Deliver 双轨

- Collaborate 默认；
- 文件变化触发 changes inspector；
- 高风险 tool 触发 approval；
- 代码变化触发 build/test；
- 用户选择 Deliver 时进入现有 Workflow/Gate/Artifact。

### Milestone 3：Event canonicalization

- transactional outbox；
- durable automation projector；
- model-visible log invariant；
- legacy projections；
- fork/resume/replay from log。

### Milestone 4：规模化与产品完成度

- pagination / virtualization / search；
- richer Final Result；
- workspace management；
- bootstrap；
- accessibility and screenshot audit。

---

## 11. PR 合并建议

**本轮建议保持 PR 打开，并按 `REQUEST_CHANGES` 处理。**

原因不只是“未来还有产品功能”，而是已经存在基础设施正确性阻断：

- durable owner/generation 未进入 SQL 写条件；
- ownership loss 在 Workflow boundary 仍可写 cancelled；
- successful Gate/Node/Rework 路径缺少可靠 fence；
- shutdown timeout 后没有真正停止执行器。

当 F4-P0-01～F4-P0-04 修复、增加 deterministic regression tests，并由当前 PR head 的正式 Core + full CI 全绿后，可以重新评估“基础设施里程碑是否可合并”。

即使基础设施届时通过，产品整体仍需完成真实流式、Session follow-up/steer 和 Collaborate/Deliver 双轨，才能判定为普通用户可用。

## 第四轮最终裁决

> **不通过。**  
> 最新可访问性和诚实披露改动可以保留；第三轮报告中的误判已经纠正；但新发现的 ownership/generation、success-path fencing 与 shutdown quiescence 问题属于合并阻断，不能用文档披露或绿色现有测试替代修复。
