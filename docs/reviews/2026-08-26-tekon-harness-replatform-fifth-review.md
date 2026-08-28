# Tekon Harness Replatform 第五轮全面复审

> 复审日期：2026-08-26  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 第四轮报告基线：`c5550b59ec639d15d51c451e7f2adb1b5d63247c`  
> 实施方最新收敛提交：`576d6b400d3f6f2c7eea50ce485952e8c7805b41`  
> 本轮评审直接修改：`4dd04675de8e8f1a9b82b728352050431ded4c25`、`466b2a8fcc4dc9cd07d2b3b6d92dd6357c58c18d`  
> 复审维度：产品逻辑、信息架构、UI 实现、UX 交互、Agent Runtime、Session/Event/Job 架构、并发恢复、代码正确性、安全与治理边界、测试可信度、过度实现与过度设计。  
> 视觉评审边界：本轮检查了 React/CSS、RPC、事件流、状态来源和现有 Playwright 路径；没有把代码阅读冒充为截图式人工视觉验收。颜色对比、真实屏幕阅读器、完整键盘遍历、窄屏触控和千级事件视觉性能仍需独立浏览器审计。

---

## 1. 最终结论

# **不通过**

第五轮仍不能给出“通过”，也仍不建议直接合并当前 PR。

实施方最新提交正确修复了第四轮中的两类明确问题：

1. ownership loss 在 Workflow plan 边界不再被直接解释成用户取消；
2. Node 正常成功路径在已经收到 ownership-loss signal 时，不再继续 finalize/promote；
3. 两处可能回退 Workflow 终态的写入改成了终态保护写。

这些修复值得保留，新增回归测试也有价值。但本轮继续沿数据和控制链向下检查后，确认当前方案仍没有形成统一、持久化、可证明的执行代际边界；并且发现一个不需要 30 秒租约饥饿即可触发的正常路径竞态：**两个并发 resume 可以同时创建 Session/Job，并让同一 Run 被重复执行。**

同时，普通用户的核心产品闭环仍未完成：主力 Provider 非真实增量流、Session 内不能 follow-up/steer、默认入口仍是完整交付 Workflow 而非轻量协作。

### 1.1 分层裁决

| 验收对象 | 第五轮结论 |
| --- | --- |
| 普通用户可直接使用的人类协作产品 | **不通过** |
| 完整 Harness-inspired Agent Runtime | **不通过** |
| 多进程 Durable Job / Recovery 基础设施 | **不通过**；缺持久化 generation、条件写和原子 resume |
| 单进程、Mock Provider、无恢复竞争的开发实验 | 可继续使用 |
| 现有 Workflow / Gate / Artifact / Delivery 治理资产 | 有价值，应保留并作为治理能力层继续演进 |
| 本 PR 是否建议直接合并 | **暂不建议**；应先作架构取舍并关闭本文 F5-P0 项 |

### 1.2 更新评分

| 维度 | 第四轮 | 第五轮 | 说明 |
| --- | ---: | ---: | --- |
| Agent 自动执行与治理 | 7.5 | 7.5 | Workflow、Gate、Artifact、Worktree 仍是强项 |
| Durable Job 与恢复 | 5.5 | 5.0 | 局部 fencing 改善，但并发 resume 和 owner-conditioned write 未闭环 |
| 事件与回放 | 6.0 | 6.0 | SSE/replay 可用，仍是 best-effort projection |
| 人类输入体验 | 4.5 | 4.8 | 入口文案更诚实，但 Session 内仍不能继续输入 |
| 过程可见性 | 5.0 | 5.0 | Feed 连续，但主流 Provider 的过程仍是事后合成 |
| 人类干预能力 | 3.5 | 3.5 | pause/cancel/approval 有入口；follow-up/steer 缺失 |
| 输出可读性 | 5.0 | 5.2 | 控件和 live-region 改善；最终结果仍浅 |
| 架构收敛度 | 6.5 | 5.8 | 抽象继续增加，但单 owner / 多 owner 产品选择尚未明确 |
| 并发与恢复可信度 | 4.5 | 4.0 | 新发现正常路径双 resume；成功副作用仍无持久化 fence |
| 测试与 CI | 8.0 | 8.0 | 测试面广；关键竞态仍缺 deterministic barrier tests |
| 普通用户发布信心 | 4.0 | 4.0 | 产品主闭环未变 |

---

## 2. 对第四轮批注与最新实现的复核

### 2.1 已确认正确完成的部分

#### F4-P0-02：plan 边界 ownership loss 不再写 cancelled

`packages/core/src/workflow/engine.ts` 现在在节点边界和最终写 `passed` 前，先区分：

```text
ownership lost
user cancellation
other abort
```

ownership lost 会直接 stand down，而不是调用 `settleCancelled()`。这关闭了旧 owner 把新 owner 正在恢复的 Run 写成 `cancelled` 的明确窗口。

**第五轮结论：已闭环该具体问题。**

#### F4-P0-03：Node 正常成功路径增加 pre-finalize guard

`packages/core/src/workflow/node-executor.ts` 在正常成功路径调用 `finalizeExecutionLease()` 前增加 ownership-loss 检查。实施方新增测试能证明：当 signal 已经 aborted 后进入该位置时，不会再调用 worktree commit/promote。

**第五轮结论：该具体窗口已闭环，但整个成功副作用链仍未闭环。**

原因是检查和 commit/promote 仍是两个独立时刻：ownership 可以在检查通过后、Git 更新前变化。该剩余问题见 F5-P0-03。

#### F4-P0-05：两处 Workflow 终态回退写已加保护

stale-running 与 resume-at-gate 的两处 Workflow 状态写已经改为 `updateWorkflowInstanceStatusIfActive()`，不会把另一个 owner 已写入的 `passed / failed / cancelled` 回退为非终态。

**第五轮结论：这两处修复正确；Node 行本身的 CAS 与执行代际约束仍未完成。**

### 2.2 对实施方“只属于 30 秒尾部风险”的修正

实施方批注正确指出：stale reclaim 通常需要 heartbeat 超过租约 TTL，确实不是每个正常请求都会发生。

但当前系统还有另一条不依赖租约过期的多 owner 路径：

```text
Web 正在运行 JobRunner
+ 用户同时从 Web / CLI / 两个请求执行 resume
+ 两个请求都看到“没有 active job”
+ 两个请求分别创建 Session / Job
```

CLI 和 Web 都会在同一个 SQLite 上创建并启动 JobRunner。`resumeRun()` 的“检查 active job → 查找/创建 session → enqueue”不是一个事务，数据库也没有唯一约束保证一个 Run 只有一个 Session 和一个 active Job。

因此，多 owner 并发不是只在“卡死 worker 复活”时才有正确性影响。即使决定继续支持多 owner，这一项也必须作为正常请求竞态处理。

---

## 3. 新增合并阻断项

## F5-P0-01：并发 resume 可创建重复 Session 和重复 active Job

**严重级别：Critical**  
**触发条件：正常并发请求，不需要 lease 过期。**

`SessionService.resumeRun()` 当前顺序是：

```text
读取 workflow
检查 pending decisions
cancelStaleActiveJobs
findActiveByRunId
findSessionByRunId
必要时 createSession
enqueue workflow-resume job
```

这些步骤之间没有事务。

数据库约束也不足：

- `sessions.run_id` 只有普通 index，没有 unique；
- `jobs` 没有 `run_id`；
- 没有 partial unique index 保证一个 Run 只有一个 active Job；
- `enqueue()` 是普通 INSERT；
- 当前测试只验证顺序调用时“已有 active job 会拒绝”，没有两个并发调用的 barrier test。

可能结果：

```text
请求 A：active = null
请求 B：active = null
请求 A：create session A
请求 B：create session B
请求 A：enqueue job A
请求 B：enqueue job B
```

两个 Job 都可以被 claim，同一个 Run 被重复执行，产生重复 Node/Gate/Worktree 副作用。

### 必须修复

推荐最小一致性方案：

1. `sessions.run_id` 对非空值建立唯一约束；
2. 把“获取或创建 Run Session + 创建 active Job”放入一个 `BEGIN IMMEDIATE` 事务；
3. Job 层建立真正的一 Run一active-job约束：
   - 可在 `jobs` 持久化 `run_id` 并建立 partial unique index；或
   - 以唯一 session.run_id + session_id active-job partial index组合保证；
4. 冲突时返回已存在的 active Job 或稳定的 `CONFLICT`，不得创建第二个；
5. 增加两个独立 SQLite 连接、同一 barrier 同时 resume 的测试，断言：
   - 一个 Session；
   - 一个 active Job；
   - 一个 executor；
   - 两个调用得到可解释、幂等的结果。

---

## F5-P0-02：Job 持久化写仍未绑定 owner + claim generation

**严重级别：Critical（如果多 owner 是产品能力）**

当前进程内 `executionTokens: Map<jobId, symbol>` 只能识别同一进程里的旧执行代际，不能进入跨进程 SQL 条件。

Job 表仍没有持久化 generation。以下写入都没有完整 fencing 条件：

- heartbeat：按 `jobId` 更新 lease；
- checkpoint：先 `updateJob()`，再检查返回行的 owner；
- settle：先读取 owner，计算状态，再按 `jobId` 更新；
- cancel/pause control propagation；
- stale reclaim 后旧 owner 的迟到写。

典型 TOCTOU：

```text
旧 owner 读取 owner=old
新 owner reclaim 并写 owner=new
旧 owner UPDATE jobs WHERE id=:id
```

旧 owner 仍可能覆盖 lease、checkpoint、status 或 updated_at。

### 必须二选一

#### 方案 A：明确单 owner Runtime

这是本地开发产品更推荐的方案：

- 一个长驻 daemon 独占 JobRunner、Agent、Worktree 和数据库写控制；
- Web 和 CLI 都只是客户端；
- daemon 启动时获取进程锁，第二个 runtime 拒绝启动；
- UI/CLI 经本地 HTTP/SSE、Unix socket 或 JSON-RPC 调用同一个 runtime。

若选择此方案，必须删除或阻止 Web/CLI 同时各自 claim Job 的部署形态，而不是只写文档说“不常发生”。

#### 方案 B：正式支持多 owner

则必须实现：

```text
jobs.claim_generation INTEGER NOT NULL
```

每次 claim/reclaim 原子递增，并把 `{jobId, owner, generation}` 放入 `JobExecutionContext`。所有敏感写入必须类似：

```sql
UPDATE jobs
SET checkpoint = :checkpoint
WHERE id = :jobId
  AND owner = :owner
  AND claim_generation = :generation
  AND status IN ('running', 'paused')
```

`changes !== 1` 时立即 fence，不能“先写后验”。heartbeat、checkpoint、settle、abortState 都需要同样契约。

---

## F5-P0-03：成功副作用链仍没有持久化执行能力票据

**严重级别：Critical**

最新 pre-finalize signal guard 能关闭一部分窗口，但不能关闭：

```text
检查 signal 未 abort
→ owner 变化
→ commit lease
→ git branch -f run branch
```

`finalizeExecutionLease()` 仍包含一组不可回滚或难回滚的副作用：

```text
inspect source changes
commit worktree
读取 lease head
promote run branch
写 audit
release lease
```

它只接收 `runId/nodeId`，没有 `{owner, generation}` 或 `assertOwned()` capability。`promoteLeaseToRunBranch()` 使用 `git branch -f`，没有验证 run branch 的 expected old OID。

### 仍未统一覆盖的路径

- Gate 返回 passed/skipped 的成功路径；
- Node 正常 finalize；
- auto-fix repair；
- changes-requested rework；
- review rerun；
- rework 失败时对 partial lease 的 finalize；
- review rerun finalize 失败被吞掉；
- worktree promote 与 Node passed 写之间的跨边界一致性。

### 必须修复

1. 引入不可伪造的 `ExecutionAuthority`：

```ts
interface ExecutionAuthority {
  jobId: string;
  owner: string;
  generation: number;
  signal: AbortSignal;
  assertOwned(): Promise<void>;
}
```

2. Agent、Gate、Node、Rework、Lease、Artifact 都接收同一 authority，而不是各自读取裸 signal；
3. 每个 DB 成功写带 owner/generation 或对应 Node revision；
4. Git ref 提升改为 expected-old OID CAS：

```text
git update-ref <run-ref> <new-oid> <expected-old-oid>
```

当前 ref 已改变时必须失败，而不是 force 覆盖；
5. 对以下窗口增加 deterministic barrier tests：
   - guard 通过后、commit 前 ownership 变化；
   - commit 后、promote 前 ownership 变化；
   - Gate passed 后 ownership 变化；
   - rework 正常完成前 ownership 变化。

---

## F5-P0-04：Node 状态机仍是 read-validate-unconditional-write

**严重级别：High**

Workflow 终态写已有 CAS，但 Node transition 仍主要是：

```text
getNode
assert transition
transitionNode(nodeId, to)
```

数据库 UPDATE 没有：

- expected-from；
- node revision；
- owner/generation；
- changes===1 验证。

而且正常 Node 启动路径中，ownership 可能在 plan 边界检查通过后发生变化；旧执行器会先写 Node running / Workflow running，之后才在更深的位置看到 signal。

### 必须修复

增加：

```ts
transitionNodeIfFrom({
  nodeId,
  expectedFrom,
  to,
  expectedRevision,
  authority,
})
```

并在 SQL 中一次完成条件写。`checkedTransitionNode()` 不应再把 read + validate + write 分成多个无条件步骤。

恢复逻辑需要明确决定：

- stale executor 失败写不得覆盖新 owner；
- new owner 恢复时只能从预期状态推进；
- 同一 Node 的 rework/review iteration 应有明确 revision，而不是复用同一行的模糊状态往返。

---

## F5-P0-05：JobRunner.stop() 仍未保证 quiescence

**严重级别：High**

当前 `stop()`：

1. 停止 poll；
2. 最多等待 5 秒；
3. 清 heartbeat、controller map、execution token、pause flag；
4. 返回；
5. Web/CLI 随后关闭 SQLite。

清空 Map 不会终止 Promise、子进程或正在执行的 Git 操作。超时后执行器仍可能：

- 修改 worktree；
- 写 run branch；
- 访问已关闭的 DB；
- 留下 orphan subprocess；
- 在下一次启动前产生不可观察副作用。

### 必须修复

两阶段关闭：

```text
停止 claim 新 Job
→ 用 shutdown 专用 reason abort 全部 controller
→ registry.killAll 对应 run subprocess
→ 等待 executor 和 child process quiesce
→ 将未完成 Job 留成可恢复状态
→ 最后关闭 SQLite
```

若强制超时仍不能停，应：

- 返回明确的 forced-shutdown 结果；
- 不声称运行已安全停止；
- 不删除执行代际信息；
- 至少保证旧 authority 的后续持久化写会失败。

现有测试只覆盖“executor 在 5 秒内正常结束”，需要增加超时 executor 和真实 registry spy。

---

## 4. 产品主闭环复核

## PRODUCT-P0-01：主力 Provider 仍不是真实增量 Agent Loop

`AgentAdapter` 仍是：

```ts
runAgent(input): Promise<AgentRunResult>
```

`runAgentWithStepEvents()` 的真实顺序仍是：

```text
step/start
await adapter.runAgent()
根据最终结果合成 tool/call
合成 tool/result
合成 assistant/message
step/end
```

这不是 Provider 在工作过程中持续产生的 typed stream。

### 直接影响

- 用户无法看到真实 Assistant delta；
- Tool Card 不是实际 tool lifecycle；
- 无法精确定义 steer 插入点；
- 无法在请求边界可靠暂停；
- UI 看见的是 Node 级包装，而不是 Agent 工作过程；
- Provider 被伪装成一个“大工具”，丢失内部 command/file-change/approval 结构。

### 推荐实现顺序

只选一个 Provider 先做完整 vertical slice：

- Codex：优先接 App Server 的 Thread / Turn / Item 与 delta；
- Claude：使用 Agent SDK streaming input，或至少 `stream-json` + partial messages；
- 将 Provider 事件适配为 Tekon `turn/step/item`，不要先继续扩充更多合成事件类型。

验收必须包括：started → delta → completed、真实 tool progress、取消、approval、重连 replay、最终 usage。

---

## PRODUCT-P0-02：Session 内仍没有 follow-up / steer

当前 Session 页面只有 Feed 和右栏，没有输入 Composer。`AgentHandle.followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`；Session RPC 只有 list/get。

产品仍是：

```text
创建一次任务
→ 观察 Workflow
→ pause/cancel/approve
```

而不是：

```text
提出目标
→ 看 Agent 工作
→ 继续追问
→ 补充上下文
→ 修改方向
→ 保持同一 Session 继续执行
```

### 验收要求

- Session Detail 固定 Composer；
- 输入先 durable append，带 clientMessageId/idempotency key；
- running 时 steer 的作用范围明确为“当前 step”或“下一 admitted request”；
- idle 时 follow-up 创建新 turn，不创建全新 Run；
- pending input 刷新后仍可见；
- 进程重启后可恢复；
- 重复提交不会产生重复 turn；
- UI 显示 queued / claimed / applied / rejected，而不只是“发送成功”。

---

## PRODUCT-P0-03：Collaborate / Deliver 仍未形成真正双轨

本轮已把默认 Composer 的文案和按钮改成“受控交付”，这是正确的诚实性修复：它不再假装是轻量聊天。

但产品本身仍只有完整 `standard-delivery` 默认路径。一个简单解释、代码探索或小修复仍会进入 PM / RD / QA / Reviewer 全链路。

### 推荐产品模型

#### 协作任务 Collaborate（默认）

- 一个长 Session；
- 快速理解、解释、探索、小范围修改；
- 用户可持续 follow-up/steer；
- 默认不创建 PR；
- 可以只读或受限写；
- 当变更或风险升级时显示“升级为受控交付”。

#### 受控交付 Deliver（显式选择）

- Demand/Plan 审批；
- Workflow、Gate、Artifact、独立 Review；
- 分支、测试、Delivery、PR；
- 清楚说明成本和副作用。

两种模式必须在后端绑定不同 policy/template/tool/gate 组合，不能只换按钮文案。

---

## 5. UI 与 UX 复核

### 5.1 本轮正向修改

本轮评审直接提交了以下低风险修复：

- 默认 CTA 从“开始会话”改为“启动受控交付”；
- pending 文案改为“正在创建交付…”；
- Composer 加 `aria-busy`、`aria-describedby`、`aria-invalid` 和错误 `role=alert`；
- 非 compact 的 Pause / Resume / Cancel / View 控件显示文字，不再只靠图标和 tooltip；
- 控件组增加可访问名称；
- Event Feed 使用 `role=log`，按增量更新语义暴露；
-连接状态增加 `aria-atomic=true`；
- 主 Feed 和右栏增加 landmark 名称；
- Playwright 增加 Feed log 和状态 atomic 断言。

### 5.2 Feed 仍过于接近内部事件日志

默认 Feed 同时展示：

- step；
- turn；
- governance；
- tool；
- raw unknown event type；
- synthetic assistant summary。

普通用户需要的是：

```text
Agent 在做什么
刚完成了什么
修改了哪些文件
测试是否通过
现在是否需要我操作
最终结果是什么
```

不应要求用户理解 `workflow/node-ended`、`gate/result`、`step/end` 等内部词汇。

推荐默认 Feed 只展示高层 narrative，技术事件折叠到“过程详情”。`assistant/chunk` 需要在同一 message item 内合并，不应每个 chunk 生成一行。

### 5.3 控制状态来源不够权威

右栏 `RunControls` 的 status 主要从 best-effort Session Events 推导，并在未知时默认 `running`。如果 projection 丢失或连接尚未 replay 完成，可能出现错误 affordance。

推荐：

- `session.get` 返回 authoritative run status / active job status / pending decisions 摘要；
- SSE 只增量更新；
- 重连后以 authoritative snapshot + seq 继续；
- 不以缺失事件推断“正在运行”。

### 5.4 Final Result 仍过浅

当前最终卡片主要是：

```text
运行结束 · status
产物 N · 错误 M
```

发布级 Final Result 至少应包括：

- 需求/目标完成摘要；
- 修改文件与 diff stat；
- build/lint/test 结果；
- Gate 和人工审批；
- 风险与未完成项；
- 生成产物；
- PR/Delivery 状态；
- 明确下一步。

### 5.5 长 Session 仍不可规模化

当前：

- 服务端 `listEventsSince()` 无 limit；
- 初次连接 replay 全量历史；
- 客户端永久累积全部 events；
- 每个新 event 都重新构造 Map 并 sort；
- render 时再次复制、sort、group；
- 没有分页、虚拟化、折叠、搜索或自动滚动暂停。

千级/万级事件会产生内存、CPU、DOM 和认知负担。

### 5.6 鉴权启动体验仍未闭环

`tekon ui` 读取持久 token 并启动服务器，但用户仍需手工在页面输入 token。没有短时、单次消费的 bootstrap handoff。

这不是当前最大的安全阻断，但会显著影响“人可以直接用”的第一印象。

---

## 6. Event / Data 架构复核

### 6.1 Session Event 仍不是 canonical source of truth

现有结构仍是：

```text
Legacy tables 是事实源
→ best-effort dual-write
→ Session Event / UI projection
```

这使 UI 事件可能静默缺失，而 model/context 又不能仅靠 Session log 重建。

DeepSeek Harness 的关键约束是：模型可见内容必须进入 durable Session log，历史从同一日志派生。Tekon 当前尚未达到这一点。

建议在完成真实 Provider vertical slice 后，选择：

- event-first + durable projector；或
- transactional outbox；

而不是继续扩大 best-effort dual-write 覆盖面。

### 6.2 `visibility` 与 `modelVisible` 是重复且可能冲突的状态

Session Event 同时有：

```text
visibility: model | ui-only | internal
modelVisible: boolean
```

例如 opening `user/message` 设置 `modelVisible=true`，但没有覆盖默认 `visibility=ui-only`。两个字段可能表达矛盾事实。

建议只保留一个类型安全来源：

- event variant 决定是否属于 model surface；或
- 单一 `visibility` discriminant；

不要让两个字段分别漂移。

### 6.3 Automation 仍依赖 process-local bus

readiness 和 auto-prepare listener 只监听当前进程的 EventBus。进程离线、CLI 写入、重启窗口和 listener enqueue 失败都可能错过触发。

`projection_checkpoints` 已存在，但当前接口只有 upsert，没有完整 durable scanner/read/retry 机制，属于尚未兑现的基础设施骨架。

### 6.4 startRun 仍非原子

一次启动跨越：

```text
Demand / Project / Workflow / Plan / Audit
Session
session/created
workflow/started
user/message
Job
```

任何中途失败都可能留下 orphan Run、无 Job Session 或缺 opening events。需用同库事务，跨边界则用 outbox/saga 补偿，并做逐点故障注入测试。

### 6.5 Workspace 与 Project 语义重复

每次 `prepareRun()` 都创建一个新的 Project UUID，但 Workspace 已经代表当前 repo。Web `listScopedProjects()` 会列出同一路径下所有 Project 行。

这会导致：

- Project 数量随 Run 增长；
- Workspace/Project 谁是长期容器不清楚；
- Session 属于 Workspace，Workflow 属于新 Project；
- UI 和权限必须跨两套容器拼接。

建议明确：

```text
Workspace = 长期 repo / checkout / policy 容器
Run = Workspace 下的一次执行
```

若 Project 没有独立业务意义，应合并或改成稳定的一Repo一Project，而不是每 Run 新建。

---

## 7. 过度实现与过度设计评估

## 7.1 不是所有复杂度都是多余的

Tekon 的差异化价值来自：

- Workflow；
- Gate；
- Artifact；
- Worktree 隔离；
- Audit；
- Delivery；
- 人工审批。

这些不是应删除的“复杂度”，而是受控交付产品的核心资产。

## 7.2 Replatform 层出现了“抽象领先于纵向闭环”

当前已经存在：

- 冻结的 AgentDriver / AgentHandle contract；
- followUp/steer/resume 方法；
- 多种 Session Event 类型；
- profile policy；
- automation executor；
- projection checkpoint 表；
- dual-write bridge；
-多 owner JobRunner；
- Session UI。

但真正决定用户体验的一个完整纵向切片仍缺失：

```text
一个真实 Provider
→ 实时 delta/tool/approval
→ durable Session log
→ Session Composer follow-up/steer
→ 重启恢复
→ 同一 UI 正确回放
```

这使系统处于成本最高的中间态：既承担分布式恢复和双事实源复杂度，又没有交付持续协作体验。

### 建议冻结

在完成上述 vertical slice 前，不再新增：

- 新 profile；
- 新合成事件类型；
- 新 automation kind；
- 新 projector；
- 新模式字段；
- 新的“未来接口但实现抛 NotSupportedYet”。

现有未来接口可保留为 experimental，但不要继续让它们扩大生产 surface。

## 7.3 单 owner 与多 owner 必须作产品级决策

当前同时支持 Web 和 CLI 各自启动 JobRunner，却没有完成多 owner 所需的全部一致性机制。

### 推荐：单 owner daemon

对本地 Agent 产品，这是更合理、成本更低的主线：

```text
tekon runtime
  ├─ owns SQLite writes
  ├─ owns JobRunner
  ├─ owns live Agent handles
  ├─ owns worktrees/subprocesses
  └─ exposes local protocol

Web / CLI / future IDE
  └─ clients only
```

优点：

- 不需要让每个 CLI 命令成为一个竞争 worker；
- follow-up/steer 有稳定 live Agent；
- shutdown 生命周期集中；
- Session Event 与 UI stream 集中；
- 减少 owner/generation 传播面；
- 更接近 Codex App Server 的长驻 runtime + 多 client 模式。

### 只有确实需要分布式 worker 时才选择多 owner

若产品目标明确包含多个独立进程抢占同一队列，则不能把 generation/CAS/唯一索引当成可选硬化。这些是该模式的基础正确性成本。

## 7.4 PR 本身已经过大

本轮报告前 PR 约为：

- 180 个变更文件；
- 81 个提交；
- 约 27k 行新增。

这已经显著降低：

- 人工审查可信度；
- 二分定位能力；
- 回滚能力；
- 架构决策可追踪性；
- 合并后的责任边界。

建议停止继续把完整 Phase 2/3/4 能力堆入同一 PR。后续拆分为：

1. Durable runtime correctness；
2. Provider streaming vertical slice；
3. Session interaction；
4. Collaborate mode；
5. Event canonicalization / automation；
6. Long-session UI。

---

## 8. 推荐目标架构

### 8.1 Runtime 层

```text
Single Owner Runtime
  ├─ Agent Registry
  ├─ Durable Inbox
  ├─ Job / Turn Scheduler
  ├─ Provider adapters
  ├─ Tool / approval pipeline
  ├─ Worktree manager
  ├─ Session event store
  └─ Projection/outbox workers
```

### 8.2 事实模型

```text
Workspace
  └─ Session
       ├─ Turn
       │    ├─ Item started/delta/completed
       │    ├─ Assistant message
       │    ├─ Tool call/result
       │    └─ Approval
       ├─ Goal / Plan
       ├─ Changes / Artifacts
       └─ Optional Delivery Workflow
```

Workflow 不再是所有会话的默认外壳，而是 Session 中的一种受控能力。

### 8.3 Provider 接入优先级

1. 先接 Codex App Server 或 Claude Agent SDK 中一个；
2. 实现稳定 Item lifecycle；
3. 接 durable input inbox；
4. 完成 follow-up/steer；
5. 再把 Tekon Gate/Artifact/Delivery 作为能力接入；
6. 最后再扩展第二个 Provider。

---

## 9. 测试与验证要求

### 9.1 最新实施方提交的现有 CI

`576d6b400d3f6f2c7eea50ce485952e8c7805b41` 的正式 Core 与全栈 CI 均通过。新增两条第四轮回归测试有效覆盖了其目标窗口。

### 9.2 本轮评审 UI 修改

`466b2a8fcc4dc9cd07d2b3b6d92dd6357c58c18d` 已触发正式 Core/CI；报告提交前 Core、Root build/typecheck、Web build/typecheck/unit 已通过，其余最终结果以当前 PR head 的 GitHub Actions 为准。

### 9.3 仍必须新增的 deterministic tests

| 场景 | 验收 |
| --- | --- |
| 两连接同时 resume | 只有一个 Session、一个 active Job、一个 executor |
| checkpoint 前 owner 已变 | UPDATE 0 行，旧 executor fence，新 checkpoint 不被覆盖 |
| settle 读 owner 后被 reclaim | 旧 settle UPDATE 0 行，不改新 Job |
| heartbeat 在 reclaim 后迟到 | 不更新新 generation lease |
| guard 通过后、commit 前 ownership 变化 | 不 commit、不 promote |
| commit 后、promote 前 ownership 变化 | expected-old ref 更新失败 |
| Gate passed 后 ownership 变化 | 不 finalize、不写 Node passed |
| rework/review rerun ownership 变化 | 不提升 stale worktree，不回退 Node |
| stop 超时 | abort + kill，DB 关闭前 executor quiesce |
| 1000/10000 Session Events | 有界内存、分页、可搜索、无全量 DOM |

绿色 happy-path CI 不能替代这些竞态测试。

---

## 10. 外部官方基准

本轮使用以下官方资料校准目标，而不是要求 Tekon 逐行复制其实现：

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)：durable Session facts 与 live Agent control 分层，模型历史从 Session log 派生；
- [DeepSeek Harness Sessions](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)：append-only SessionEvent 作为交互历史事实源；
- [OpenAI：Unlocking the Codex harness / App Server](https://openai.com/index/unlocking-the-codex-harness/)：长驻 runtime、双向协议、Thread/Turn/Item、增量事件和客户端解耦；
- [Claude Agent SDK Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)：持久交互、follow-up、interrupt 和 session management；
- [Claude Agent SDK Streaming Output](https://code.claude.com/docs/en/agent-sdk/streaming-output)：文本与 tool call 的真实增量输出；
- [Git update-ref](https://git-scm.com/docs/git-update-ref.html)：以 expected old OID 实现安全 ref 更新。

DeepSeek Harness 当前仍是 developer preview，因此 Tekon 应继续通过适配层借鉴模式，而不应把 Domain/DB 绑定到其不稳定内部 schema。

---

## 11. 建议实施顺序

### Milestone 0：先做架构取舍

- ADR：单 owner daemon 或正式多 owner；
- 推荐选择单 owner；
- 冻结新事件/profile/automation 扩张。

### Milestone 1：关闭 Durable Runtime 红线

- 原子 resume；
- 唯一 Session / active Job；
- owner + generation 条件写；
- Node CAS；
- Git expected-ref CAS；
- shutdown quiescence；
- 完整 deterministic race tests。

### Milestone 2：真实 Provider vertical slice

- Codex 或 Claude 一个 Provider；
- Item started/delta/completed；
- tool/approval/cancel；
- durable replay。

### Milestone 3：Session 持续协作

- Composer；
- durable inbox；
- follow-up/steer；
- restart recovery；
- UI 状态闭环。

### Milestone 4：产品双轨

- Collaborate 默认；
- Deliver 显式升级；
- 保留 Tekon 治理资产作为差异化能力。

### Milestone 5：数据和规模收敛

- canonical event/outbox；
- durable automation；
- Workspace/Project 合并；
- long-session pagination/virtualization/search；
- 一次性 UI bootstrap；
- screenshot + keyboard + screen-reader 专项验收。

---

## 12. 合并验收清单

在把当前 PR 视为“可合并的基础设施里程碑”前，至少应满足：

- [ ] 明确并强制单 owner，或实现持久化 claim generation；
- [ ] 同一 Run 只能存在一个 canonical Session；
- [ ] 同一 Run 只能存在一个 active Job；
- [ ] resume 并发测试通过；
- [ ] heartbeat/checkpoint/settle 使用 owner+generation 条件写；
- [ ] Node transition 使用 expected-from/revision CAS；
- [ ] worktree promote 使用 expected-old OID；
- [ ] rework/review 成功路径接受统一 execution authority；
- [ ] stop 超时能 abort/kill/quiesce；
- [ ] 当前 PR head 全部正式 CI 通过；
- [ ] PR 描述不再暗示 Session human collaboration 已完成。

在把产品视为“普通用户可用”前，还必须满足：

- [ ] 一个真实 Provider 产生实时 typed stream；
- [ ] Session 内 follow-up/steer 完成；
- [ ] 默认 Collaborate 与显式 Deliver 双轨完成；
- [ ] Final Result 可读且可行动；
- [ ] 长 Session 可规模化；
- [ ] 完成真实浏览器、键盘和辅助技术验收。

---

## 13. 最终裁决

> **不通过。**
>
> 最新实施方提交正确修复了第四轮中的几个具体窗口，本轮的 UX/accessibility 小修也应保留；但当前多 owner 模型仍缺少其基础一致性契约，并存在正常并发 resume 生成重复 Job 的新阻断。产品层的真实流式、Session 持续输入和 Collaborate/Deliver 双轨也尚未完成。
>
> 下一步不应继续扩充 profile、event 和 projector，而应先决定 single-owner runtime 还是完整 multi-owner，并完成一个真实 Provider 的端到端纵向切片。

---

## 附：实施方批注（2026-08-26，第五轮收敛）

> 本节由实施方在收到本报告后追加。评审方法：本报告是扎实的架构级复审，确认第四轮 F4-P0-02/03/05 已正确闭环，并提出一个不依赖租约过期的正常路径新阻断 F5-P0-01。为逐条核验，我委派动态 workflow（F5-P0-01 首审 + 对手方复核两个最高思考等级 subagent 独立回代码 + 三线取舍 + 首席综合）+ 独立 code review 复核，再由我复核。

### F5-P0-01（CONFIRMED / High）—— 本轮 MUST-FIX，已修

**核验共识**：并发 resume 竞态属实且**不需要 30s 租约饥饿**。`resumeRun`（session-service.ts）的 `findActiveByRunId`（裸 read，不在事务/锁内）与 `enqueue` 之间有 await 间隙；`sessions.run_id` 非 unique、`jobs` 表无 `run_id`/active 唯一约束；CLI 与 web 各开独立 SQLite 连接 + 各自进程内 WriteQueue（只单进程串行化）。两并发 resume 可都见"无 active job"→各 enqueue → 同一 run 被两 executor **真跑**（双 agent 花费 + 两 worktree 各 `promoteLeaseToRunBranch`(`git branch -f`) 到同一 run 分支冲突/相互覆盖）。第四轮的 workflow 终态 CAS 只保证**状态**单调，不阻止**执行**层双跑——故是真实正确性缺口而非纯 UI 噪音。

**处置（已修）**：新增 `JobRepository.enqueueIfNoActiveByRunId`，把 active-check + insert 收进一个 `BEGIN IMMEDIATE` 事务（复用 `appendEvent` 已验证的跨进程临界区范式：写者锁在 check 之前获取，`busy_timeout=5000` 处理短竞争），冲突时返回既有 active job 不第二次 insert。`DurableJobRunner` 加同名包装；`SessionService.resumeRun` 与 **`gate.approve`**（报告未点名的第二个并发 resume 入口，同样有此竞态）均改用原子方法。

**否决报告建议的"仅 sessions.run_id partial unique"**：可 resume 的状态只有 paused，paused run 必由 startRun 生成、session 已存在，resume 走 findSessionByRunId 命中非空、跳过 createSession——故该 unique index 对主导案例零保护。事务方案是根因修复。

**测试**：`session-store.test.ts` 加 3 条——顺序 re-check 真锁（移除 in-tx re-check 即 fail）+ 两连接 file-db 集成断言（诚实标注：better-sqlite3 同步单线程无法在进程内制造真交错，原子性由与 appendEvent 同款 BEGIN IMMEDIATE 保证，此测试锁"两连接收敛到单 active job"）；`resumeRun` 的 active-job 契约由既有测试覆盖。

### 对报告其余部分的处置

- **§2.1 确认第四轮修复正确闭环**（F4-P0-02/03/05）——回代码确认与报告一致。
- **F5-P0-02/03/04/05 ≡ 第四轮 F4-P0-01/03递延/05递延/04 的重述+扩展**：报告 §2.2/§7.3 自述"单 owner daemon 更推荐、generation/CAS/唯一索引仅多 owner 才必需"，把 F5-P0-02 明标"Critical（IF 多 owner）"——**本质是 single-vs-multi owner 架构决策，交用户拍板，非无条件 code bug**。延续前四轮"基础设施里程碑 + 诚实披露"原则递延。
- **PRODUCT-P0-01/02/03**（真流式/follow-up-steer/Collaborate-Deliver 双轨）：前四轮已在 README/manual 诚实披露的里程碑递延。
- **本轮已提交的 a11y 改动**（EventFeed `role=log`、SessionComposer `aria-*`/`role=alert`、RunControls `role=group`+中文标签、SessionDetailPage `aria-atomic`+landmark + e2e 断言）：回代码确认正确、无回归、e2e 有效。
- **§6.2 visibility/modelVisible 双字段**：属实但**无运行后果**——`'model'` 枚举成员是死值（全库无 `visibility==='model'` 判定门，实际门是 `modelVisible`）。低成本清理项，本轮不动以保持 PR 聚焦，**记录交用户决策**。
- **§6.5 Workspace/Project 每 run 新建、§7.2 抽象领先纵向闭环、§7.4 PR 过大（实测 181 files/28k 行/83 commits，报告数字准确）、§11 单 owner ADR、Milestone 拆分**：架构/过程建议，**记录交用户决策**，非本 PR 阻断 bug。

### 本轮裁决（实施方）

> 采纳报告唯一新增的真实正确性缺口 **F5-P0-01（CONFIRMED/High），已用原子 `BEGIN IMMEDIATE` enqueue 修复两个 resume 入口 + 真锁回归测试**，全量 `pnpm test` 110 files/1293 passed、Playwright 11 passed（5 预存 flaky retry 通过、session-feed 隔离 2/2）。F5-P0-02~05（单-vs-多 owner 架构决策 + 已披露递延）、产品主闭环、PR 拆分/ADR 记录为交用户决策。报告对本 PR「不通过 / 暂不建议合并」的整体裁决属实——单 owner daemon vs 完整多 owner 是需要用户拍板的架构方向，与前四轮结论一致，本 PR 继续按「基础设施里程碑 + 诚实披露」推进。