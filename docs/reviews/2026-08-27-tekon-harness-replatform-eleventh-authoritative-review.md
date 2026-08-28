# Tekon Harness Replatform 第十一轮权威全面复审

> 复审日期：2026-08-27  
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`  
> 第十轮报告提交：`818a1e2fded9bc6bd7d083ea8cdaf3fe00fe61a8`  
> 实施方第十轮整改提交：`1f9a278c7a0949048dfdf1a2efcc15fded11b6a1`  
> 本轮代码审查与修复快照：`dad49b0ba9fc7123b38a702a5cd44b3606666249`  
> 复审维度：产品逻辑、UI 实现、UX 交互、可访问性、整体框架、并发与恢复、代码实现、测试可信度、过度实现与过度设计

---

## 1. 最终结论

# **第十轮整改通过；整个产品与完整 Runtime 仍不通过**

本轮必须把三个不同的验收对象分开，否则很容易出现“一个测试问题修好，因此整个迁移完成”的误判：

| 验收对象 | 第十一轮结论 |
| --- | --- |
| 第十轮唯一新增的 PR-local Playwright flaky 整改 | **通过** |
| 本轮同步 Token 持久化与 Session Event append fast path | **通过** |
| 生产浏览器认证 bootstrap | **继续通过** |
| Git promotion expected-old OID CAS | **继续通过** |
| Job heartbeat/checkpoint/settle 的 owner/status 条件写 | **有效进展，应保留** |
| 当前 PR 作为默认可并发 Web/CLI Runtime 合入 main | **不通过** |
| 普通用户可持续协作产品 | **不通过** |
| 完整 Harness-inspired Runtime | **不通过** |
| 诚实标注边界的实验性基础设施快照 | 可继续验证，但必须冻结范围并明确部署限制 |

本轮没有发现需要推翻第十轮整改提交的代码问题。实施方确实关闭了第十轮 CI 中的五个首轮 flaky journey，正式 GitHub Actions 在本轮代码快照上得到：

```text
Core: success
Root build + typecheck: success
CLI build + unit + e2e: success
Web build + typecheck + unit: success
Web Playwright: 28 passed, 0 retry, 0 flaky, 33.6s
```

但这只关闭了测试稳定性项。以下生产能力仍未完成：

```text
真实 Provider 执行期增量流
Session follow-up / steer / resume
可唯一 claim、幂等消费、可重启恢复的 durable inbox
Collaborate / Deliver 后端双轨
完整跨进程 execution generation / Node CAS
shutdown abort / kill / join quiescence
人类叙事 Feed、当前状态 Inspector、结构化 Final Result
长 Session 的有界回放、分页、虚拟化和性能预算
```

因此，第十一轮不能对“整个产品”或“完整 Runtime”给出通过。

---

## 2. 证据与评审方法

本轮不是按接口名、事件名或实施方声明验收，而是按以下层次逐项检查：

```text
类型或契约存在
≠ 有局部实现
≠ 生产调用链真实使用
≠ 可重连、可恢复、可并发
≠ 普通用户可理解、可长期使用
```

主要证据来自：

1. 第十轮报告后的完整 Git diff；
2. 当前生产代码调用链；
3. GitHub Actions 对 PR merge ref 的正式执行；
4. Playwright 首轮结果，而不是 retry 后的最终颜色；
5. 官方架构资料；
6. 既有移动端、认证、审批、Session Feed 与 Delivery E2E。

### 2.1 UI 视觉审计边界

本轮没有新的可下载截图 Artifact，当前 GitHub Actions run 的 artifact 列表为空；本执行环境也没有可控制的产品浏览器。因此：

- 可以验收 DOM 结构、ARIA、路由、响应式 CSS、状态机和 Playwright journey；
- 不能声称完成新的截图级颜色、排版密度、真实滚动体验和视觉层级人工验收；
- 第六、七轮已确认的移动布局与 drawer 行为继续由现有 E2E 保护；
- 新的视觉设计调整仍应在独立产品 PR 中提供桌面、390px 移动端和长 Session 截图。

---

## 3. 对实施方第十轮批注的裁决

### 3.1 接受：Playwright flaky 已被正确关闭

实施方把共享业务 E2E 改为在每次同源跨文档 `page.goto()` 时注入 `#token=`，并新增 `shared-fixture-auth-lock.test.ts`，使业务 journey 不再依赖上一 document 的 React effect 是否已经把 Token 写入 `sessionStorage`。

证据：

- `packages/web/__tests__/e2e/shared-fixture.ts`
- `packages/web/__tests__/e2e/shared-fixture-auth-lock.test.ts`
- CI run `33065382380`：success
- 本轮 code head CI run `33067709997`：success
- Playwright job `98502248112`：`28 passed (33.6s)`，没有 `retry #1`

判定：**B，保留。**

需要澄清的是：Web Storage 的 `setItem()` 本身是同步 API。这里真正的时间窗口是 React `AuthProvider` passive effect 尚未运行，而不是浏览器在后台异步“提交 sessionStorage”。本轮已把生产入口的 Token 持久化前移到 first render 之前，见 §4.1。

### 3.2 接受但限定：fixture 修复是测试隔离，不是产品能力

共享 fixture 现在会给每个同源 `page.goto()` 添加 Token fragment。这对稳定业务 E2E 是合理的，因为 fixture 的职责是提供已连接的测试前置状态。

但它不证明真实用户每次跨页面导航都会获得新 fragment；生产应用只在启动 URL 或手工 hash 更新时获得 Token，随后依靠内存与 `sessionStorage`。因此：

- `shared-fixture-auth-lock.test.ts` 证明 fixture 契约；
- `prod-bootstrap*.test.ts` 才证明生产 bootstrap、刷新保持、URL 清理和 Referer 不泄漏；
- 两类测试不能互相替代。

判定：**B，保留；不得拿它关闭产品认证或持续 Session 的其他问题。**

### 3.3 接受：Git promotion CAS 已闭环

`packages/core/src/runtime/worktree-manager.ts` 使用：

```text
git update-ref <target-ref> <new-oid> <lease.baseHead>
```

将 lease 创建时持久化的 `baseHead` 作为 expected-old OID。旧 lease 无法观察新 head 后再静默覆盖；CAS miss 会 fail closed。

判定：**B，Git ref 侧关闭。**

这不等于 Node、Artifact、Audit 和 Job 的所有副作用都已有同样的 authority/CAS，见 §6。

### 3.4 部分接受：Job owner/status 条件写是实质改进

heartbeat、checkpoint、settle 等关键 Job row 写入已加入 owner/status 条件，`settleOwnedJob` 也把 owner 校验、取消优先级和终态写入收敛到单条 SQL。

判定：**P，Job row 侧大幅改善。**

仍未完全关闭的原因：

- schema 没有持久化 `claim_generation`；
- 进程内 `executionTokens: Map<jobId, symbol>` 无法代表跨进程执行代际；
- Node transition 仍是无 expected-from/revision 的直接 UPDATE；
- Artifact/Audit/Delivery 等副作用没有统一携带 execution authority。

### 3.5 不接受：“其余都可仅视为未来里程碑”

真实 streaming、Collaborate 和长 Session 可以在“只合并实验性基础设施”的前提下递延；但 multi-owner authority、Node CAS 和 shutdown quiescence 是当前 Runtime 的正确性问题，不只是未来产品功能。

当前代码允许：

```text
Web 进程运行 JobRunner
CLI tekon run 运行嵌入式 JobRunner
两者访问同一项目 SQLite 与 Git 工作区
```

只要该部署形态仍可达，就必须二选一：

1. 强制 single-owner runtime，并让 Web/CLI 成为客户端；
2. 完整承担 multi-owner generation、条件写和副作用 fencing。

不能同时保留 multi-owner 入口，又把相应正确性问题全部归为“以后再做”。

---

## 4. 本轮直接修改

本轮只修改了边界明确、可独立验证、不会伪装关闭架构缺口的项目。

### 4.1 在 React first render 前同步持久化 bootstrap Token

提交：`6ce9fb552000484c86ae23f10d239ad6edd0e1e7`

原始顺序：

```text
main.tsx 读取 #token
→ 同步设置 RPC token
→ React render
→ AuthProvider passive effect 稍后写 sessionStorage
```

这会留下一个很小但真实的窗口：页面已经显示已认证状态，但快速 cross-document navigation / reload 发生在 passive effect 前，下一 document 可能读不到 storage。

现在顺序是：

```text
读取 fragment/storage
→ 同步 persistToken(initialToken)
→ 同步 setRpcSessionToken(initialToken)
→ React render
```

`AuthProvider` 仍重复执行持久化和 RPC seed，作为幂等防御。

修改文件：

- `packages/web/src/client/main.tsx`

判定：**通过。**

### 4.2 为 Session Event merge 增加有序追加快路径

提交：

- `ffc1ecdb80dcfb9f77776aabc97423e06ef36722`
- `dad49b0ba9fc7123b38a702a5cd44b3606666249`

原实现每收到一个事件都执行：

```text
遍历全部 existing
→ 建完整 Map
→ 加 incoming
→ values 全量排序
```

正常 SSE 和 Last-Event-ID catch-up 绝大多数是严格单调、无重叠追加。现在：

- existing 与 incoming 都严格递增；
- incoming 第一项位于 existing 最后一项之后；

则直接线性 concat；遇到 replay overlap、duplicate 或乱序时，仍回退到 Map + sort 防御路径。

新增测试覆盖：

- ordered batch append；
- 对象身份保持；
- out-of-order existing 修复；
- 原有 dedupe、replay overlap、first occurrence 语义继续成立。

修改文件：

- `packages/web/src/client/lib/session-stream.ts`
- `packages/web/__tests__/client/session-stream.test.ts`

判定：**通过。**

注意：这只把正常 append 从“重建 Map + 排序”降为线性复制；客户端仍无界保留全部历史，不能据此关闭长 Session 规模问题。

---

## 5. 产品逻辑复审

### P0-PRODUCT-01：主流 Provider 仍不是执行期增量 Agent Loop

当前 `runAgentWithStepEvents()` 的核心顺序仍是：

```text
step/start
→ await adapter.runAgent(input)
→ 根据完整 AgentRunResult 生成 tool/call
→ 生成 tool/result
→ 生成 assistant/message
→ step/end
```

`LegacyAgentDriver.events()` 也先：

```ts
await done;
```

再遍历 buffered events。

因此，UI 看到的 Tool 和 Assistant 事件主要是完成后的投影，不是 Provider 正在运行时产生的：

- assistant delta；
- tool started / progress / completed；
- request boundary；
- interruption；
- mid-turn steer；
- partial replay。

代码依据：

- `packages/core/src/runtime/agent-step-events.ts`
- `packages/core/src/runtime/legacy-agent-driver.ts`

官方对照：

- OpenAI Codex App Server 使用 `item/started → item/*/delta → item/completed`，使客户端可以在 item 完成前开始渲染；
- Claude Managed Agents 的 user/session/agent events 双向流支持执行中 interrupt 和 redirect；
- DeepSeek Harness Session log 保存 raw `assistant/chunk`，以支持 replay、UI fidelity 和模型历史重建。

判定：**不通过。**

### P0-PRODUCT-02：Session 内持续输入仍不存在

当前 Session Router 只有：

```text
session.list
session.get
```

没有：

```text
session.message
session.followUp
session.steer
session.resumeTurn
```

`AgentHandle.followUp()`、`steer()` 与 `AgentDriver.resume()` 仍抛出 `NotSupportedYet`；Session Detail 页面也没有当前 Session 的输入 Composer。

代码依据：

- `packages/web/src/server/api/routers/session.ts`
- `packages/core/src/runtime/legacy-agent-driver.ts`
- `packages/web/src/client/pages/SessionDetailPage.tsx`
- `packages/web/src/client/components/sessions/SessionComposer.tsx`

当前 `SessionComposer` 的职责仍是创建一个新的 `standard-delivery` Run，并明确写着“轻量协作、会话内追问与转向尚未开放”。

判定：**不通过。**

### P0-PRODUCT-03：durable inbox 尚未实现

现有 schema 没有独立的可消费用户输入队列，也没有等价的命令状态模型。

一个可靠 inbox 至少需要：

```text
message_id / idempotency_key
pending
claimed(owner + generation + lease)
processed / failed
retry / poison handling
turn_id / step_id causality
restart recovery
```

单纯追加 `user/message` Event 不能证明该输入会被唯一消费，也不能区分“已显示”“已排队”“执行中”“已处理”。

代码依据：

- `packages/core/src/db/migrations.ts`
- `packages/core/src/types/session-contract.ts`

判定：**不通过。**

### P0-PRODUCT-04：Collaborate / Deliver 仍未形成后端双轨

当前 Profile 的差异主要是：

- 是否允许 mutation；
- 是否自动准备 Delivery；
- 是否 review-only。

它没有形成语义不同的轻量 Collaborate 产品。默认 Composer 仍启动 `standard-delivery`，CLI 默认也启动 `standard-delivery`。

代码依据：

- `packages/core/src/session/profile-policy.ts`
- `packages/web/src/client/components/sessions/SessionComposer.tsx`
- `packages/web/src/server/api/routers/project.ts`
- `packages/cli/src/commands/run.ts`

目标应当是：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 用户心智 | 讨论、理解、快速修改 | 受控研发交付 |
| 默认成本 | 低 | 高 |
| 角色 | 单 Agent / 小计划 | PM / RD / QA / Reviewer |
| 权限 | 只读或受限 Patch | Worktree / Gate / Delivery |
| Git 副作用 | 默认最小 | 显式受控 |
| 结果 | Answer / Patch / Summary | Evidence / Review / PR / CI |
| 恢复单元 | Session / Turn | Job / Workflow / Delivery |

判定：**不通过。**

---

## 6. Runtime 与代码正确性复审

### P0-RUNTIME-01：当前部署形态已是事实 multi-owner，但缺持久 execution generation

Jobs 表仍只有：

```text
owner
lease
status
abort_state
checkpoint
```

没有 `claim_generation`。

当前改善可以阻止旧 owner 修改 Job row，但不能完整证明旧 executor 不再触碰其他共享状态。进程内 `symbol` 只覆盖同进程代际，不跨 Web/CLI 进程。

风险交错：

```text
A claim job
→ A 停顿，lease 过期
→ B requeue/claim
→ A 恢复，在下一次 heartbeat 发现 ownership loss 之前
→ A 继续 Node/Artifact/Audit/Git 副作用
```

最低关闭方案二选一：

#### 推荐：single-owner daemon

```text
一个 Tekon Runtime 独占 JobRunner / Agent / Worktree / Subprocess
Web / CLI / IDE 通过本地协议作为客户端
```

这与 Codex App Server 的长驻 runtime + 多客户端模式更一致，也显著缩小当前项目不需要承担的分布式状态空间。

#### 完整 multi-owner

所有敏感写入必须携带：

```text
job_id
owner
claim_generation
expected status / revision
```

并要求 SQL `changes === 1`；Git、Node、Artifact 和 Delivery 也必须消费同一 authority。

判定：**不通过。**

### P0-RUNTIME-02：Node transition 仍缺 expected-from/revision CAS

`repositories.transitionNode()` 当前仍然是：

```sql
update nodes
set status = ?, updated_at = ?
where id = ?
```

调用前可以检查合法状态，但检查与写入不是同一个原子操作，也没有 owner/generation/revision。

需要类似：

```ts
transitionNodeIfFrom({
  nodeId,
  expectedFrom,
  expectedRevision,
  to,
  executionAuthority,
});
```

并在 CAS miss 时让旧执行器 silent stand-down，不能继续 Gate、Artifact 或 Git 路径。

代码依据：

- `packages/core/src/db/repositories.ts`
- `packages/core/src/workflow/node-executor.ts`
- `packages/core/src/workflow/engine.ts`

判定：**不通过。**

### P0-RUNTIME-03：完整 shutdown quiescence 仍未实现

`JobRunner.stop()` 当前：

```text
停止 poll
→ 等待 pending 或 5 秒超时
→ 清 heartbeat / controller / token / pause map
→ 返回
```

清空 Map 不会终止仍在执行的 Promise 或外部子进程。超时返回后，上层仍可能关闭 DB 或退出进程，而 Agent、Gate、Git side effect 继续运行。

正确关闭链：

```text
停止 claim 新 Job
→ 停止接收新 automation work
→ 用 shutdown reason abort 所有 executor
→ kill registry 中的子进程
→ join Agent / Gate / Git side effect
→ 写入明确可恢复状态
→ 最后关闭 DB 与 HTTP server
```

代码依据：

- `packages/core/src/session/job-runner.ts`
- `packages/web/src/server/http.ts`

判定：**不通过。**

### P1-RUNTIME-04：Session replay 和客户端历史仍无界

服务端：

```ts
listEventsSince(sessionId, sinceSeq)
```

没有 limit，SQL 会返回 `seq > sinceSeq` 的全部事件。

客户端：

- `useSessionStream` 永久保存完整 `events[]`；
- Feed 对全部 Events 分组和映射；
- SidePanel 再次扫描全部 Events；
- DOM 无 virtualization；
- 大 payload 仅截断，没有完整 spill/reference 流程。

本轮 append fast path 只降低正常合并成本，无法限制：

```text
网络 replay 大小
内存增长
Feed 派生成本
SidePanel 重复派生
DOM 数量
```

需要：

```text
server cursor pagination
bounded initial replay
gap recovery
client bounded accumulation
append-only incremental projections
Turn / Step collapse
virtualization
search / filter
payload spill/reference
性能预算与长任务基准
```

判定：**不通过。**

---

## 7. UI 与 UX 复审

### 7.1 已经改善并继续通过

以下改动应保留：

- Session-first 默认路由；
- legacy Cockpit 降到 `/advanced`；
- 390px 页面不再横向溢出；
- 移动 drawer 具备 modal、focus trap、Escape、focus restore 和 background inert；
- 单一 main landmark；
- Feed 使用 `role="log"`；
- 连接状态使用 polite live region；
- 审批与 PR 创建保留明确确认步骤；
- Composer 明确声明当前启动完整受控交付，不伪装成轻量聊天。

### 7.2 P1-UX-01：Token 仍是长期暴露的实现细节

自动 bootstrap 已经能够建立连接后，普通用户顶栏仍常驻：

- 完整密码输入框；
- 显示/隐藏按钮；
- 350ms debounce 后切换 auth scope。

更合适的默认状态是：

```text
已连接
认证失败
重新连接
高级设置
```

手工 Token 应放到高级设置，并使用 draft + 显式“应用”，避免用户尚未输入完成就切换认证作用域。

代码依据：

- `packages/web/src/client/layouts/TopBar.tsx`

判定：**不通过，但不是当前最高优先级。**

### 7.3 P1-UX-02：Feed 仍以系统事件为主，而不是任务叙事

`EventFeed` 仍直接映射大量：

```text
step/start
step/end
workflow/node-started
workflow/node-ended
gate/result
job/status
artifact/created
unknown event type
```

默认用户叙事应聚合为：

```text
理解需求
形成计划
实施变更
运行验证
请求审批
完成交付
```

底层 seq、Node ID、checkpoint、correlation ID 和 raw payload 应进入 Advanced/Audit。

代码依据：

- `packages/web/src/client/lib/event-feed.ts`
- `packages/web/src/client/components/sessions/EventFeed.tsx`

判定：**不通过。**

### 7.4 P1-UX-03：Inspector 仍复制历史，而不是显示当前状态

`SessionSidePanel` 从同一个 events[] 再提取 Tool、Artifact 和 Error cards，导致主 Feed 与右栏重复展示历史。

Inspector 应稳定显示：

```text
当前 Plan
Changed Files
最新 Checks / Gates
Pending Approval
Risks / Limitations
Final Result
Delivery / PR / CI
Recovery Action
```

代码依据：

- `packages/web/src/client/lib/session-side-panel.ts`
- `packages/web/src/client/components/sessions/SessionSidePanel.tsx`

判定：**不通过。**

### 7.5 P1-UX-04：Final Result 仍不足以完成用户验收

当前最终卡片主要是：

```text
运行结束 · status
产物 N · 错误 M
```

需要服务端稳定投影：

- summary；
- changed files / diff；
- build / lint / test；
- gates；
- independent review；
- risks / limitations；
- artifacts；
- branch / PR / CI；
- recommended next action。

这不应完全依赖浏览器临时扫描原始 Events。

判定：**不通过。**

---

## 8. 过度实现与过度设计

### 8.1 不属于过度设计的部分

以下能力是 Tekon 的核心差异化，应继续保留：

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

它们使 Tekon 能承担受控软件交付，而不仅是聊天式 coding assistant。

### 8.2 当前真正的过度设计

横向抽象已经明显领先于纵向产品闭环：

```text
Event vocabulary
Profile
Automation Job
Projection checkpoint
AgentDriver / AgentHandle 契约
DSH bridge
multi-owner recovery
```

但仍没有一个真实 Provider 完成：

```text
execution-time streaming
→ real tool lifecycle
→ durable follow-up / steer
→ restart recovery
→ same Session replay
→ human-readable final result
```

PR 当前已超过 160 个 commits、200 个 changed files 和 3 万行新增。继续在同一个 PR 里增加 Event type、Profile 或 Automation kind，会进一步降低：

- 评审可信度；
- 回归定位能力；
- revert 能力；
- 架构决策清晰度；
- 后续合并安全性。

### 8.3 简化建议

推荐下一步先做一个 ADR：

```text
ADR: Tekon Runtime ownership = single-owner daemon
```

然后按独立 PR 拆分：

1. Runtime owner/lock + shutdown quiescence；
2. 一个真实 Provider 的 streaming vertical slice；
3. durable inbox + follow-up / steer / resume；
4. Collaborate track；
5. Narrative Feed + Final Result；
6. long-session pagination / virtualization。

DeepSeek Harness 仍处于 developer preview，并明确提示会有 compatibility-breaking changes。继续采用模式借鉴和 anti-corruption adapter 是合理的，不应让 Tekon 数据库或核心领域模型绑定其不稳定内部 schema。

---

## 9. 合并与发布建议

### 9.1 对本 PR 的建议

**不建议把当前 PR 作为默认 Runtime 直接合入 main。**

合并前至少满足以下之一：

#### 路径 A：强制 single-owner

- 项目级 Runtime lock；
- Web/CLI 不再各自成为并发 owner；
- 明确的 daemon/client 协议；
- shutdown abort/kill/join；
- 相关 E2E。

#### 路径 B：完成 multi-owner 基础契约

- jobs.claim_generation；
- owner + generation 条件写；
- Node expected-from/revision CAS；
- Artifact/Audit/Delivery authority；
- stale executor 交错测试；
- shutdown quiescence。

如果决定先合并实验性快照，则必须：

- 明确标为 experimental；
- 限定单进程、单用户、本地环境；
- 禁止同时运行 Web owner 与 CLI owner；
- 不宣称普通用户可发布；
- 立即关闭该超大 PR，后续使用小 PR 演进。

### 9.2 对产品发布的建议

普通用户发布门槛还需：

1. 真实 Provider streaming；
2. Session follow-up / steer / resume；
3. durable inbox；
4. Collaborate / Deliver 双轨；
5. Narrative Feed / Inspector / Final Result；
6. long-session 有界化；
7. 截图级桌面、移动、长内容和键盘验收。

---

## 10. 推荐实施顺序与可验证验收条件

### Step 1：Runtime ownership

验收：

- 两个进程竞争时只有一个 authority；
- stale owner 无法修改 Job、Node、Artifact、Audit 或 Git；
- shutdown 后没有子进程、DB 写入或 Git side effect；
- 测试使用两个真实 SQLite connection/process barrier。

### Step 2：一个真实 Provider vertical slice

验收：

- Provider 尚未结束时，浏览器已收到 assistant/tool delta；
- tool start/progress/result 顺序真实；
- cancel 能停止当前 subprocess；
- 网络断开后从 durable seq 恢复；
- 不使用 synthetic node-level tool 代替真实 tool lifecycle。

### Step 3：durable inbox 与持续 Session

验收：

- follow-up 和 steer 有独立语义；
- pending/claimed/processed 可观察；
- idempotency key 防重复；
- daemon 重启后继续；
- 同一 Session 能创建下一 Turn；
- UI 显示排队、处理中和已消费状态。

### Step 4：Collaborate / Deliver 双轨

验收：

- 后端权限、成本、角色、Git 和 Gate 明确不同；
- Collaborate 默认不启动 PM/RD/QA/Reviewer 全链路；
- 写代码时按风险升级到 Diff/Test/Review；
- 用户可以把 Collaborate Session 显式升级为 Deliver。

### Step 5：产品叙事与规模能力

验收：

- 默认 Feed 无 raw event wall；
- Inspector 是当前状态投影；
- Final Result 结构化；
- 首次只加载有界窗口；
- 上翻分页；
- 10k+ Events 性能预算；
- 桌面和 390px 截图验收。

---

## 11. 官方资料对照

- OpenAI Codex App Server：<https://openai.com/index/unlocking-the-codex-harness/>
  - typed item lifecycle：`item/started`、optional delta、`item/completed`；
  - durable thread 包含多个 turn，并允许客户端重连与恢复一致时间线。
- DeepSeek Harness architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
  - Session log 是模型上下文来源；
  - raw `assistant/chunk` 支持 replay 与 UI fidelity；
  - capability seam 必须包含 definition/provider/consumer，而非只有接口。
- DeepSeek Harness session subsystem：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
  - append-only typed SessionEvent log 是 interaction history 的 source of truth。
- DeepSeek Harness README：<https://github.com/deepseek-ai/deepseek-harness/>
  - 当前仍为 developer preview，并明确存在 breaking changes。
- Claude Managed Agents session event stream：<https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
  - user events 与 session/agent events 双向流；
  - 支持执行中 interrupt/redirect；
  - idle session 可继续。
- Git update-ref：<https://git-scm.com/docs/git-update-ref>
- SQLite isolation：<https://www.sqlite.org/isolation.html>
- Playwright retries：<https://playwright.dev/docs/test-retries>
- WAI-ARIA modal dialog：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>

外部资料用于核对模式和验收标准；裁决仍以当前 PR 的生产调用链、持久化语义和正式 CI 为准。

---

## 12. 正式验证

代码快照：`dad49b0ba9fc7123b38a702a5cd44b3606666249`

### GitHub Actions

- Core workflow run：`33067709999` — success
- CI workflow run：`33067709997` — success
- Root typecheck + lint job：`98501896792` — success
- CLI build + unit + e2e job：`98502029825` — success
- Web build + typecheck + unit job：`98502029911` — success
- Web Playwright job：`98502248112` — success

### Playwright 明细

```text
Running 28 tests using 1 worker
28 passed (33.6s)
```

日志中没有 `retry #1`，因此本轮可以诚实表述为：**28 个浏览器测试均首轮通过，无 flaky。**

### 验证边界

- 正式 CI 证明当前已有测试覆盖的行为没有普通回归；
- 它不证明尚未实现的 streaming、inbox、generation、Node CAS 和 shutdown quiescence；
- CI 未上传截图 Artifact，因此不声称完成新的截图级视觉审计。

---

## 13. 最终裁决

> **第十一轮对第十轮整改的裁决：通过。**
>
> 实施方已经稳定关闭了第十轮的 Playwright 首轮 flaky；本轮又补齐了 first-render 前同步 Token 持久化和有序 Session Event append fast path，正式 CI 为 Core/Root/CLI/Web/Playwright 全绿，Playwright 28 项首轮通过。
>
> **第十一轮对当前 PR 作为默认 Runtime、普通用户产品和完整 Harness 迁移的裁决：仍不通过。**
>
> 当前仍缺真实 Provider execution-time streaming、Session follow-up/steer/resume、durable inbox、Collaborate/Deliver 后端双轨；同时事实 multi-owner 缺 persistent generation、Node CAS 与完整 shutdown quiescence。Feed、Inspector、Final Result 和长 Session 也未达到长期使用门槛。
>
> 最合理的下一步不是继续往本 PR 增加横向抽象，而是冻结当前范围，先以 single-owner daemon ADR 收敛 Runtime，再用独立小 PR 完成一个真实 Provider 的纵向闭环。

本轮未执行 merge、release 或 deploy。

---

## 实施方批注（第十一轮）

> 批注日期：2026-08-27  
> 批注方：实施侧（主代理 + 三视角评估 workflow：CI 提交核验 / 报告 P0-P1 triage / CI 事实与合并门槛 + 首席综合，均实地读码 / 实跑测试 / gh 核验 CI）  
> 收敛版本：v0.15.4（PATCH）  
> 核心裁决：**本轮无任何新的 PR-local 必修代码项**（性质同第八 / 九轮）。报告 §1 已明确 PASS 第十轮 flaky 整改与本轮 CI 三提交；剩余全部为第 4~10 轮已一致披露的架构里程碑，诚实 C 递延。**本轮报告的实质增量是一个合并门槛 / 架构 ADR 决策（single-owner daemon vs 完整 multi-owner），需用户 / 项目拍板，非实施方本轮可单方面写代码收敛的项。**

### 一、本轮 CI 三提交（`6ce9fb5`/`ffc1ecd`/`dad49b0`）实地核验：正确、无回归、测试真锁（判 B 保留）

报告 §4 记录的"本轮直接修改"实际由 CI 自修改工作流提交，报告已判【通过】。实施方独立复核确认：

| 提交 | 代码证据 | 裁决 |
| --- | --- | --- |
| `6ce9fb5` main.tsx first-render 前同步 `persistToken(initialToken)` | `main.tsx`：`readTokenFromLocation()` → `persistToken(initialToken)` → `setRpcSessionToken(initialToken)` → `createRoot`。关闭"可见 app 已认证但 sessionStorage 尚未写入"的 cross-doc/reload 窗口。`persistToken(null)` 为 `removeItem` no-op、不误清有效令牌；`AuthProvider` 仍重复 persist/seed 作幂等防御 | **B 已闭环**。这是对我第十轮诊断的**同一 bootstrap 竞态的产品侧硬化**，与我第十轮的 e2e fixture `#token=` fragment 注入**互补非冲突**（前者让生产 sessionStorage 永不落后于内存令牌；后者让测试跨导航不依赖 sessionStorage 交接） |
| `ffc1ecd` session-stream 有序追加快路径 | `mergeEventsBySeq`：`existingOrdered && incomingOrdered && (incoming[0].seq > existing 末项 ‖ 任一为空)` → 线性 `concat`，否则回退 Map dedupe + sort。11 边界 cross-check probe 证明与 fallback 输出等价（边界 seq 相等走慢路径，保 first-occurrence / replay-overlap 语义） | **B 已闭环**（纯性能优化，防御路径完整覆盖乱序 / 重叠 / 去重，无正确性回归。仍不关闭长会话无界问题——报告 §4.2 已注明） |
| `dad49b0` 有序追加锁测试 | `session-stream.test.ts`：ordered batch append 保对象身份（`merged[0]===existing[0]`、`merged[2]===incoming[0]`）+ out-of-order existing 修复；原 dedupe / replay-overlap / first-occurrence 保留 | **B 已闭环**（真锁 fast-path 与回退两分支；identity 断言 fallback 亦满足属测试强度 nuance、非正确性 bug） |

验证：本地 web 单测 253 passed（session-stream 15/15、reconnect 7/7）；HEAD `b217419` 与 `dad49b0` 六项 CI check 全 success，Playwright 28 passed / 0 flaky / 0 retry；报告 §12 run id（`33067709999`/`33067709997`/`33065382380`）逐一 gh 核验一致；报告无占位符 / 断链、与 git·CI 事实无矛盾。

### 二、核心增量：合并门槛 / 架构 ADR 决策（needs user decision）

报告 §3.5 / §6 / §9 / §13 的实质主张是：multi-owner authority（持久 `claim_generation`）、Node expected-from/revision CAS、完整 shutdown quiescence 是**当前 Runtime 的正确性问题，而非纯未来功能**。

**实施方核验：该事实前提成立。** 当前 Web 服务端（`packages/web/src/server/api/root.ts:167,177` `createJobRunner().start()`）与 CLI（`packages/cli/src/commands/run.ts:153`、`approval.ts:308`、`lib/session-context.ts:201`）都会构造并启动各自的 `JobRunner`；CLI `session-context.ts` 注释明确"jobs 表跨进程共享"；二者可访问同一 project 的 SQLite 与 Git 工作区，且当前无任何 runtime lock。因此"事实 multi-owner 部署形态可达"属实，report 的正确性关切成立。

**但报告 §9.1 / §13 提出的两条闭合路径本身都是需用户先拍板方向的重大架构改动，不是实施方本轮可单方面低成本收敛的代码**：

- **路径 A（推荐）**：强制 single-owner daemon —— 一个 Tekon Runtime 独占 JobRunner / Agent / Worktree / Subprocess，Web / CLI / IDE 降为本地协议客户端。这需要新的 daemon/client 协议 + runtime lock + shutdown abort/kill/join + 相关 E2E。
- **路径 B**：完成完整 multi-owner 基础契约 —— `jobs.claim_generation` + owner+generation 条件写 + Node expected-from/revision CAS + Artifact/Audit/Delivery authority + stale-executor 交错测试 + shutdown quiescence。
- **路径 C**：先合并实验性快照，但必须明确标 experimental、限单进程单用户本地环境、禁止同时运行 Web owner 与 CLI owner、不宣称可发布、冻结超大 PR 后续走小 PR。

报告 §13 自身也判定："最合理的下一步不是继续往本 PR 增加横向抽象，而是冻结当前范围，先以 single-owner daemon ADR 收敛 Runtime，再用独立小 PR 完成一个真实 Provider 的纵向闭环。" 实施方认同：**方向选择（A/B/C）是用户 / 项目层面的架构与合并决策**，与第 4~10 轮反复记录、交用户拍板的 single-owner-vs-multi-owner ADR 是同一决策，本轮不做未经拍板的重大架构重写。

### 三、诚实递延（C，与第 4~10 轮一致，与代码事实一致，勿当本轮缺口）

- **§5 P0-PRODUCT**：真实 Provider 执行期 streaming（`runAgentWithStepEvents` await 后投影、`legacy-agent-driver.events()` 先 `await done`）、follow-up/steer/resume（`NotSupportedYet`，session router 仅 `list`/`get`、`SessionComposer` 仅建 `standard-delivery` run）、durable inbox（无表）、Collaborate/Deliver 后端双轨（profile 仅 mutation/automation surface 差异）。
- **§6 P0-RUNTIME**：persistent `claim_generation`（无该列）、Node transition CAS（`transitionNode` 无 expected-from/revision）、shutdown quiescence（`stop()` 5s 固定超时）—— 均与上节 ADR 决策同源。
- **§7 P1-UX / §6 P1-RUNTIME-04**：token 状态化 UX、Narrative Feed、Current-state Inspector、结构化 Final Result、长 Session 端到端有界（`listEventsSince` 无 limit + 客户端 `events[]` 无界）。

以上均为报告 §10 分阶段独立 ADR/PR 里程碑，无倒退、无本应闭环却递延项。

### 四、本轮低成本诚实项

- **版本**：CI 三提交（fix + perf + test）含实质 web 代码变更却未 bump（仍 0.15.3）；随本批注 `0.15.3` → `0.15.4`（PATCH，内部竞态硬化 + 性能优化，无用户可见新功能）+ CHANGELOG。
- **文档**：本轮改动为 `main.tsx` 令牌持久化时序 + session-stream 内部合并优化 + 报告批注 / 版本，无用户可见行为变化，故 README / manual / AGENTS 无需同步。

> **实施方裁决**：认可报告 §1"第十轮整改通过、本轮三提交通过"与 §13"当前 PR 作为默认 Runtime / 普通用户产品 / 完整 Harness 迁移仍不通过"的双重裁决。本轮无新的 PR-local 必修代码；CI 三提交正确保留（B）；架构 P0/P1 诚实 C 递延。报告的核心增量是一个 **single-owner daemon vs 完整 multi-owner** 的合并门槛 / 架构 ADR 决策——该方向选择交由用户 / 项目拍板，实施方不在本轮做未经决策的重大架构重写。
