# Tekon Harness Replatform 第十轮权威全面复审

> 复审日期：2026-08-27  
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`  
> 第九轮后代码审查快照：`3215b5631553358308a2a29f4435b3e351d3ffcc`  
> 仓库卫生修正：误加入的根目录测试文件 `nonexistent` 已由 `9bf51a7bcf80853f1b9247e660f6af3b507729d2` 删除  
> 本报告性质：产品逻辑、UI 实现、UX 交互、整体框架、并发与恢复、代码实现、测试可信度、过度实现与过度设计的重新裁决

---

## 1. 最终结论

# **第十轮仍不通过**

第九轮之后存在真实、值得保留的整改，特别是 Git promotion CAS、Job owner-conditioned 条件写、生产同款认证 bootstrap、Playwright 对 flaky 的显式失败处理，以及部分 UI 可访问性修复。

但这些改动仍未把当前 PR 推进到以下任一完整目标：

1. 可持续交互、可恢复的真实 Agent Session；
2. 普通用户可以长期使用的 Collaborate 产品；
3. 后端语义真正分离的 Collaborate / Deliver 双轨；
4. 多入口、多进程条件下具有完整 fencing 和副作用隔离的 Runtime；
5. 可以用稳定 CI 证明可发布的 Web 产品。

因此，本 PR 可以作为**诚实标注边界、冻结范围后的阶段性基础设施里程碑**继续评估；不能宣称“完整 Harness 迁移完成”，也不能宣称“普通用户产品已经可发布”。

---

## 2. 本轮验收口径

本轮继续严格区分四层：

```text
接口、类型或事件名存在
≠ 局部代码路径存在
≠ 生产端到端闭环
≠ 普通用户可发布
```

例如：

- 出现 `AsyncIterable` 不等于执行期增量 streaming；
- 出现 `user/message` 不等于 durable inbox；
- 出现 Profile 不等于 Collaborate / Deliver 双轨；
- 出现 owner 条件写不等于跨进程 persistent generation fencing；
- Playwright 重试后通过不等于首轮稳定通过。

最终裁决以生产调用链、持久化状态、真实副作用边界和可复现测试为准。

---

## 3. 第九轮后已经有效关闭或明显改善的项目

### 3.1 Git promotion 已采用 expected-old OID CAS

`packages/core/src/runtime/worktree-manager.ts` 已将 delivery ref promotion 收敛为：

```text
git update-ref <target-ref> <new-oid> <lease.baseHead>
```

这里 `lease.baseHead` 是租约创建时持久化的 expected-old OID，而不是 promotion 前临时读取的目标 ref。该设计可以让两个基于同一旧基线的 promoter 中只有一个成功，后到的 stale promoter 失败关闭，避免静默覆盖新结果。

相关测试也补充了：

- 使用租约创建时的 `baseHead` 作为 expected old OID；
- legacy lease 缺少 `baseHead` 时 fail closed；
- target ref 已偏离时不允许陈旧租约覆盖；
- target ref 仍等于 lease base 时允许首次 promotion。

**裁决：Git 侧 P0 CAS 已形成可信闭环，应保留。**

### 3.2 Job owner-conditioned 原子写有实质进展

Job heartbeat、checkpoint、pause、cancel、settle 已大量转向带 owner/status 谓词的条件更新，`settleOwnedJob` 将 owner 检查、取消优先和终态写入放在同一个 SQL 中。

这比先读后写安全得多，也能阻止一部分 stale executor 在所有权变化后继续 terminalize Job。

**裁决：局部 owner fencing 已闭环；但不等于完整 multi-owner generation fencing，见第 5.4 节。**

### 3.3 Web 认证测试不再通过 fetch monkeypatch 绕过生产链路

共享业务 E2E 已改为经过生产入口：

```text
#token fragment
→ main.tsx / AuthProvider
→ sessionStorage
→ RPC / SSE credential wiring
→ URL fragment cleanup
```

这比在浏览器中 monkeypatch `window.fetch` 自动注入 header 更可信。独立 bootstrap 测试还覆盖了：

- 首屏从 fragment 获得 token；
- refresh 后 sessionStorage 恢复；
- token 不进入请求 URL 或 Referer；
- 已打开页面接收新的 token fragment。

**裁决：测试真实性明显提升，应保留。**

### 3.4 Playwright 不再把 flaky 运行报告成绿色

`packages/web/playwright.config.ts` 当前保留一次 retry 以留取 trace，但在 CI 中启用：

```ts
failOnFlakyTests: !!process.env.CI
```

这意味着首轮失败、重试通过会使 CI 失败，而不是伪装为稳定绿色。

**裁决：测试治理方向正确。当前 CI 恰好证明仍有真实 flaky，不能通过。**

### 3.5 UI 可访问性和移动端导航有可验证改善

本轮增量中可以保留的改进包括：

- 单一顶层 `main` landmark；
- 移动端 drawer 的 modal、focus trap、Esc / backdrop / navigation close 与 focus restore；
- viewport 变宽后清理陈旧 drawer 状态；
- Session Feed 使用 `role="log"`、`aria-live="polite"`、`aria-atomic="false"`；
- 连接状态使用 live region。

**裁决：局部 UI / a11y 通过，但不足以覆盖完整产品 UX。**

---

## 4. 当前 CI 是明确阻断项

对代码快照 `3215b5631553358308a2a29f4435b3e351d3ffcc` 的 GitHub Actions 结果为：

| Workflow / Job | 结果 |
| --- | --- |
| Core | success |
| Root typecheck + lint | success |
| CLI build + unit + e2e | success |
| Web build + typecheck + unit | success |
| Web Playwright e2e | **failure** |

Playwright 运行共记录：

```text
22 passed
5 flaky
workflow exit 1
```

首轮失败、retry 后通过的 5 个 journey 是：

1. Dashboard 主流程：首轮 Token 输入仍为空；
2. Mobile layout：首轮 Session Detail 未出现 `.event-feed`；
3. Release dashboard：首轮未出现 Delivery Pipeline；
4. Run detail overview：首轮未出现 `.run-header-id`；
5. Session Feed：首轮未出现 `.event-feed`。

这些失败跨越认证 bootstrap、路由首屏、Session Feed 和 Advanced 页面，不是单一 selector 的偶发误差。共同特征是：

```text
第一次导航或首次状态建立未在超时内完成
→ retry 立即通过
```

这说明生产静态 server、客户端 bootstrap、初始 query / route 状态之间仍存在未解释的首轮确定性问题。

由于配置已正确启用 `failOnFlakyTests`，本轮不能把它解释为“最终绿色”；CI 的正确结论就是失败。

**通过门槛：同一最终 HEAD 在 CI 上首轮无 flaky，或找到并修复确定性根因，而不是继续增加 retry。**

---

## 5. 仍未关闭的核心 P0

### 5.1 真实 Provider 执行期 streaming 仍不存在

当前事件层已经能描述：

- `step/start` / `step/end`；
- `tool/call` / `tool/result`；
- `assistant/message`；
- `agent/error`。

但主路径仍是：

```text
await adapter.runAgent(...)
→ Provider 完整结束
→ 根据最终结果补写 tool / assistant / step events
```

`LegacyAgentDriver.events()` 也明确先 `await done`，再把缓冲事件逐条 yield。

这仍是**完成后的事件投影**，不是执行期增量协议。真正通过至少需要证明：

```text
Provider 尚未结束
→ assistant delta 已持久化
→ tool started / progress / result 实时到达
→ 浏览器在任务结束前可见
→ cancellation 能作用于当前 Provider / tool
→ reconnect / restart 后可从 durable cursor 继续
```

**裁决：P0 未通过。**

### 5.2 follow-up / steer / resume 仍是冻结契约，不是能力

`LegacyAgentDriver` 对：

- `AgentHandle.followUp`；
- `AgentHandle.steer`；
- `AgentDriver.resume`

仍抛出显式 `NotSupportedYet`。

显式失败比静默丢消息好，但它只证明 API 边界被诚实冻结，不能算持续 Session 已完成。

**裁决：P0 未通过。**

### 5.3 append-only `user/message` 不等于 durable inbox

持续 Session 的下一条消息至少需要：

```text
pending
→ claimed(owner + generation + lease)
→ processed / failed
→ retry / poison handling
```

还需要：

- message id / idempotency key；
- Turn / Step 因果关系；
- 唯一消费者；
- claim 过期恢复；
- daemon 重启恢复；
- processed 状态持久化；
- follow-up 与 steer 不同的消费语义。

当前没有独立 durable inbox 状态机。把用户输入写进 Session Event Log 不能证明它会被唯一、可靠、可恢复地消费。

**裁决：P0 未通过。**

### 5.4 persistent claim generation 仍缺失

Jobs 表仍没有持久化 `claim_generation` / fencing token。现有保护主要由：

- owner 字符串；
- status 条件；
- 进程内 `executionTokens: Map<string, symbol>`；
- AbortController；
- heartbeat miss 后本进程自我 abort。

它能改善同一进程内的旧 generation，但不能完整证明以下跨进程场景安全：

```text
Worker A claim
→ A 停顿，lease 过期
→ Worker B reclaim
→ A 恢复
→ A 继续 checkpoint / Node write / Artifact / Git side effect
```

完整方案需要关键写入共同携带：

```text
job_id
+ owner
+ claim_generation
+ expected status / revision
```

并覆盖 heartbeat、checkpoint、settle、Node transition、Artifact / Audit、Git promotion 和 Delivery 副作用。

**裁决：owner-conditioned 局部通过；完整 multi-owner P0 未通过。**

### 5.5 Node transition 尚未形成 expected-from / revision CAS

Workflow instance 已有部分状态 CAS，Git ref 也已使用 expected-old OID；但 Node transition 仍没有统一 revision 或 expected-from 条件写。

这会留下：

- stale executor 覆盖新状态；
- 旧 owner 在失去 Job 后继续结束 Node；
- Node 状态、Artifact、Audit、Git promotion 之间缺少统一的 side-effect fence。

正确通过条件应是：

1. Node transition 带 expected-from 或 revision；
2. CAS miss 明确停止所有后续副作用；
3. Artifact / Audit 写入绑定同一 execution generation；
4. 两个真实 DB connection / process 的并发测试证明只允许一个写者胜出。

**裁决：P0 未通过。**

### 5.6 shutdown quiescence 仍不完整

`JobRunner.stop()` 当前：

- 停止 poll；
- 最多等待 pending tasks 5 秒；
- 清 heartbeat；
- 清内存 controller / token / pause state。

但固定等待后返回不等于底层执行已经停止。完整关闭需要：

```text
停止领取新 Job
→ 停止接收新 automation work
→ abort 全部 executor
→ kill 已登记子进程
→ join Agent / Gate / Git side effects
→ 持久化明确可恢复状态
→ 最后关闭 SQLite / HTTP
```

若超时，至少要证明未完成任务已被 durable 标为可恢复，旧进程不再能够继续碰 workspace。

**裁决：P0 未通过。**

### 5.7 Collaborate / Deliver 后端双轨仍未形成

当前 Profile 主要区分 mutation / automation surface，例如 `review-only` 与 `autonomous-delivery`，但没有形成两套完整产品语义。

真正双轨至少应在以下方面不同：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 目标 | 持续讨论、理解、轻量修改 | 受控研发交付 |
| 默认成本 | 低 | 高 |
| 角色 | 单 Agent 或小计划 | PM / RD / QA / Reviewer |
| 权限 | 只读或受限 Patch | Worktree / Gate / Delivery |
| Git 副作用 | 默认最小 | 显式受控 |
| 结果 | Answer / Patch / Summary | Evidence / Review / PR / CI |
| 恢复单元 | Session / Turn | Job / Workflow / Delivery |

入口名、Profile 或文案不同，但最终仍进入相同主流程，不构成双轨。

**裁决：P0 未通过。**

---

## 6. 产品逻辑与 UX 复审

### 6.1 Token 仍以内部凭证形态暴露给普通用户

生产 fragment bootstrap、URL 清理和 sessionStorage 恢复已经改善安全性；但 bootstrap 成功后，顶部仍长期暴露完整 Token 输入框和显示/隐藏按钮。

普通用户默认更适合看到：

```text
已连接
认证失败
重新连接
高级设置
```

手工 Token 应退居故障恢复或高级设置，而不是核心交互控件。

当前输入使用 350ms debounce，避免每键立即切换 auth scope，方向正确；但仍缺少显式 Apply / Cancel、连接状态和错误恢复模型。

**裁决：部分通过。**

### 6.2 Narrative Feed 已出现，但仍偏事件可视化

Session Feed 已经比原始事件列表更友好，能够把 message、tool、step、governance、error 分组为 Turn。

但它仍主要由事件类型映射组成，普通用户仍会看到大量：

- 节点开始 / 结束；
- Gate result；
- Job status；
- 合成 assistant summary；
- 技术型 tool / artifact 行。

推荐明确三层：

```text
默认 Narrative
当前状态 Inspector
高级 Audit / Raw Events
```

默认 Narrative 只保留“理解了什么、计划什么、改了什么、验证结果、需要用户决定什么”。

**裁决：P1 未通过。**

### 6.3 Current-state Inspector 缺失

右侧栏目前能显示 RunControls、pending approval 和若干 result cards，但不能稳定回答：

- 当前计划与正在做的步骤；
- 已修改文件；
- 最新检查结果；
- 当前风险；
- pending approval；
- Delivery / PR / CI 状态。

这不是再复制一份事件流，而应是服务端结构化投影。

**裁决：P1 未通过。**

### 6.4 Final Result 仍是客户端合成摘要

当前终态卡主要由：

```text
运行状态 + artifact count + error count
```

合成。它不能稳定回答：

- 改了哪些文件；
- 运行了哪些测试；
- Gate 与独立 Review 结论；
- 风险和未完成项；
- 分支、PR、CI 状态；
- 用户下一步。

Final Result 应由服务端生成版本化、结构化结果，而不是前端遍历 events 临时拼装。

**裁决：P1 未通过。**

### 6.5 长 Session 仍未端到端有界

当前 SSE 可以按 `sinceSeq` / `Last-Event-ID` 恢复，并通过本地 bus + SQLite catch-up poll 补跨进程事件，这是好的基础。

但仍缺少完整规模化能力：

```text
server cursor pagination
+ bounded initial replay
+ gap recovery
+ client bounded accumulation
+ virtualization
+ Turn / Step collapse
+ search / filter
+ large payload spill
+ performance budgets
```

当前事件列表、客户端数组和服务端 replay 对很长 Session 仍可能线性增长。

**裁决：P1 未通过。**

---

## 7. 整体架构与代码实现

### 7.1 值得保留的架构资产

以下是 Tekon 的差异化资产，不应因为本轮不通过而删除：

```text
Workflow
Gate
Artifact
Worktree
Audit
Delivery
Human Approval
Independent Review
```

Event spine、Session store、Job runner 和 SSE 也可以作为未来纵向闭环的基础。

### 7.2 当前最大问题是横向抽象快于纵向闭环

当前已有：

- 大量 Event vocabulary；
- Session Profile；
- Automation jobs；
- Projection checkpoint；
- AgentDriver / AgentHandle 契约；
- multi-owner 状态空间；
- 多种 UI projection。

但一个真实 Provider 的完整纵向链路仍未闭环：

```text
真实增量 streaming
→ tool lifecycle
→ durable follow-up / steer
→ restart recovery
→ 同一 UI replay
→ 结构化 Final Result
```

这正是过度实现 / 过度设计的主要来源。

**建议立即冻结 Event type、Profile、Automation kind 和 Projector 的横向扩张。**

### 7.3 推荐拆分

后续至少拆为独立 ADR 与 PR：

1. single-owner daemon，或完整 persistent generation multi-owner；
2. Node revision CAS 与全链路 side-effect fencing；
3. 一个真实 Provider 的执行期 streaming；
4. durable inbox、follow-up / steer / resume 与 restart recovery；
5. Collaborate / Deliver 后端双轨；
6. shutdown quiescence；
7. Narrative / Inspector / Final Result；
8. 长 Session 分页、bounded replay、virtualization 与性能预算；
9. 短时 bootstrap nonce / rotation。

---

## 8. 本轮对实施方批注的裁决

### 接受的批注

- Git expected-old OID CAS 已闭环；
- Job owner/status 条件写是实质修复；
- production bootstrap 测试链路更真实；
- 持久 generation、Node CAS、真实 Provider、双轨与长 Session 属后续架构里程碑；
- 当前 PR 只能作为诚实标注边界的阶段性基础设施评估。

### 不接受的推论

“这些项目属于后续里程碑”不等于“本轮无阻断项”。

若 PR 的目标仍包含 Harness replatform、持续 Session 或普通用户可发布产品，那么这些就是验收阻断项。只有将 PR 明确降格为基础设施里程碑并冻结范围，才可以不要求在同一个 PR 内全部实现。

同时，当前 Playwright CI 已直接失败，属于本 PR 自身可以、也必须继续收敛的问题，不能仅以“架构递延”解释。

---

## 9. 推荐执行顺序

1. 先定位并修复 5 个首轮 flaky 的共同根因，确保最终 HEAD CI 首轮稳定；
2. 决策 single-owner daemon 或 persistent generation multi-owner；
3. 补 Node revision CAS 与 Artifact / Audit / Git side-effect fence；
4. 完成 shutdown abort / kill / join；
5. 用一个真实 Provider 完成 execution-time streaming 与 tool lifecycle；
6. 建 durable inbox，闭环 follow-up / steer / resume / restart recovery；
7. 落 Collaborate / Deliver 后端双轨；
8. 服务端输出 Narrative / Inspector / Final Result projection；
9. 完成长 Session 有界化和性能预算。

---

## 10. 官方资料对照

- Playwright retries 与 flaky：<https://playwright.dev/docs/test-retries>
- Playwright `failOnFlakyTests`：<https://playwright.dev/docs/api/class-testconfig#test-config-fail-on-flaky-tests>
- Git `update-ref`：<https://git-scm.com/docs/git-update-ref>
- SQLite isolation：<https://www.sqlite.org/isolation.html>
- WHATWG Server-Sent Events：<https://html.spec.whatwg.org/multipage/server-sent-events.html>
- WAI-ARIA modal dialog：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- DeepSeek Harness architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- OpenAI Codex harness / app-server：<https://openai.com/index/unlocking-the-codex-harness/>

外部资料只用于核对模式与术语；最终裁决仍以本 PR 的代码、生产调用链、持久化语义和 CI 结果为准。

---

## 11. 最终裁决

> **第十轮整体仍不通过。**
>
> 第九轮后的 Git CAS、Job 条件写、认证测试真实性、a11y 与 flaky 治理改动应保留。但当前仍没有真实 Provider 执行期 streaming、durable inbox、follow-up / steer / resume、Collaborate / Deliver 后端双轨、persistent generation fencing、Node 全链路 CAS、完整 shutdown quiescence、结构化 Final Result 和长 Session 有界化。
>
> 更直接地说，当前最终代码快照的 Core、CLI、Web build/unit 均通过，但 Playwright CI 因 5 个首轮 flaky 正确地失败，所以连“当前 PR 自身稳定通过 CI”这一最低发布门槛也尚未满足。
>
> 本 PR 最多作为范围冻结、边界诚实披露的阶段性基础设施里程碑评估合并；不得宣称完整 Harness 迁移或普通用户产品已经可发布。

本轮未执行 merge、release 或 deploy。
