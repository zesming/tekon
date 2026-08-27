# Tekon Harness Replatform 第九轮权威全面复审

> 复审日期：2026-08-27  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 上一轮报告：`docs/reviews/2026-08-27-tekon-harness-replatform-eighth-review.md`  
> 本轮详细证据矩阵：`docs/reviews/2026-08-27-tekon-harness-replatform-ninth-review.md`  
> 复审维度：产品逻辑、UI 实现、UX 交互、可访问性、整体 Runtime 架构、并发与恢复、代码质量、测试可信度、过度实现与过度设计。

---

## 1. 最终裁决

# **第八轮整改有实质进展，但整个 PR 仍不通过**

本轮必须继续把三个不同问题分开：

1. 第八轮指出的局部缺陷是否被正确修复；
2. 实施方批注是否准确描述了代码现状；
3. 整个 PR 是否已经成为普通用户可发布的持续 Agent 产品和完整 Harness-inspired Runtime。

局部修复、契约、事件名、类型和测试存在，并不自动证明第三项成立。当前仍有产品与 Runtime P0 未形成端到端闭环，因此不能直接给整个 PR“通过”。

| 验收对象 | 第九轮结论 |
| --- | --- |
| 第八轮局部整改 | **部分通过，应保留有效改动** |
| 生产浏览器认证启动 | **继续通过** |
| 移动端布局与抽屉可访问性 | **继续通过** |
| 真实执行期 Provider streaming | **不通过** |
| Session 内 follow-up / steer / resume | **不通过** |
| durable inbox 与重启恢复 | **不通过** |
| Collaborate / Deliver 后端双轨 | **不通过** |
| Web / CLI multi-owner fencing | **不通过** |
| 完整 shutdown quiescence | **不通过** |
| Narrative Feed / Current-state Inspector / Final Result | **不通过** |
| 长 Session 端到端有界化 | **不通过** |
| 作为诚实标注边界的阶段性基础设施 | **可冻结范围后评估合并，但不能宣称完整迁移或产品发布** |

---

## 2. 审查方法与证据边界

本轮重新沿真实调用链核验，而不是只搜索接口名称：

```text
CLI / Web 启动
→ 浏览器认证
→ Composer / Session 输入
→ Provider / AgentHandle
→ Tool lifecycle / Assistant delta
→ durable inbox / claim / idempotent consume
→ Job owner / generation / heartbeat / checkpoint / settle
→ Node transition
→ Git promotion
→ Session Event / SSE
→ Feed / Inspector / Final Result
→ shutdown / restart recovery
```

同时复核：

- 第八轮报告上追加的实施方批注；
- 第八轮报告之后的提交与文件变更；
- 正式 GitHub Actions 与 Playwright retry / flaky 分类；
- 共享 E2E fixture 是否绕过真实 RPC / SSE 鉴权链；
- 新增抽象是否进入生产主路径；
- 是否出现横向框架扩张快于纵向可用切片的过度设计。

本轮增量主要集中在 Runtime、认证、测试和报告。若没有新的可比截图产物，不重新声称完成截图级视觉审计；既有移动布局和 modal drawer 结论沿用此前已验证证据，新增 UI/UX 判断以当前组件、交互语义和浏览器测试为准。

---

## 3. 实施方批注复核原则

实施方可以合理标注“递延”“阶段性边界”或“需 ADR”，但以下表述不能混用：

| 表述 | 允许的证据 |
| --- | --- |
| 契约存在 | interface / schema / event type 已定义 |
| 局部实现存在 | 某 adapter、projector、fixture 或单进程路径可运行 |
| 端到端闭环 | 生产入口真实调用、持久化语义、恢复路径、并发边界和 UI replay 全部成立 |
| 产品完成 | 普通用户可以按产品承诺持续使用，且限制不依赖阅读内部文档才能理解 |

因此：

- 有 `AgentHandle.followUp` 方法不等于 follow-up 已实现；
- 有 assistant/tool 事件不等于 Provider 正在执行期流式产出；
- 有 owner 字段或进程内 symbol 不等于持久化 generation fencing；
- 有 listener unsubscribe 不等于完整 shutdown quiescence；
- 有 Profile 或 UI 标签不等于 Collaborate / Deliver 双轨；
- 有折叠组件不等于长 Session 已端到端有界化。

第九轮详细报告中的“批注主题—代码证据—通过标准”矩阵应作为批注是否成立的最终依据。

---

## 4. 产品逻辑

## P0-01：仍不是真实持续 Agent Session

通过标准必须同时包括：

```text
Provider 执行期间持续产生 assistant/tool delta
→ 同一 Session 接受 follow-up / steer
→ 消息 durable 入队
→ pending / claimed / processed
→ 幂等消费
→ 页面刷新和 daemon 重启后恢复
→ 同一 Session 继续下一 Turn
```

如果主路径仍是：

```text
await adapter.runAgent()
→ 得到完整结果
→ 再合成 tool/call、tool/result、assistant/message
```

或者 `events()` 先等待整个 `done` Promise，则 UI 仍是任务完成后的事件投影，而不是执行期可转向的 Agent Session。

`followUp()`、`steer()`、`resume()` 还必须进入真实 Provider 和恢复路径；返回显式 `NotSupportedYet` 虽然诚实，但结论仍是功能未完成。

## P0-02：durable inbox 不能以普通 Session Event 代替

用户输入队列需要独立、可恢复的处理状态：

- message id / idempotency key；
- pending / claimed / processed / failed；
- owner / generation；
- claim lease；
- retry / poison handling；
- restart recovery；
- 与 Turn / Step 的因果关系。

仅把 user/message 写入 append-only event stream，不能证明它会被唯一、可靠地消费。

## P0-03：Collaborate / Deliver 仍需后端双轨

真正的双轨需要在下列维度产生可测试差异：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 用户目标 | 持续讨论、理解、轻量修改 | 受控研发交付 |
| 默认成本 | 低 | 高 |
| 角色编排 | 单 Agent / 小计划 | PM / RD / QA / Reviewer |
| 权限 | 只读或受限 Patch | Worktree / Gate / Delivery |
| Git 副作用 | 默认最小 | 显式受控 |
| 结果 | Answer / Patch / Summary | Evidence / Review / PR / CI |
| 恢复 | 会话优先 | Job / Workflow 优先 |

Profile、模板、下拉选项或不同文案，若最终仍进入同一条 standard-delivery 主路径，就不构成双轨。

---

## 5. UI 实现与 UX

## P1-01：Token 应退到连接状态和高级设置

自动 bootstrap 成立后，普通用户不应长期面对完整 Token 输入框。合理默认形态是：

```text
已连接 / 认证失败 / 重新连接
```

手工兜底应使用本地 draft + 明确“应用”动作。每个字符立即调用 `setToken` 会：

- 反复切换 auth scope；
- 清理 query cache；
- 重建 RPC / SSE 请求；
- 在输入未完成时制造短暂认证失败；
- 让内部鉴权细节长期占据顶栏和移动空间。

## P1-02：Feed 应从事件墙升级为 Narrative

默认 Feed 应聚合：

```text
理解需求
→ 形成计划
→ 实施变更
→ 运行验证
→ 请求审批
→ 生成结果
```

底层 seq、correlation id、checkpoint、原始 payload、重复 tool/result 和完整审计历史应进入 Advanced / Audit。

## P1-03：Inspector 应显示当前状态，而不是复制历史

Inspector 应优先投影：

- 当前计划；
- Changed Files；
- 最新 Checks / Gates；
- Pending Approval；
- Current Risk；
- Final Result；
- Delivery / PR / CI；
- 失败后的恢复动作。

从同一 `events[]` 再生成一份 Artifact / Tool 历史，会增加重复、滚动长度和认知负担。

## P1-04：Final Result 需要服务端结构化投影

Final Result 至少应包含：

- summary；
- changed files / diff；
- tests；
- gates；
- independent review；
- risks / limitations；
- artifacts；
- PR / CI；
- recommended next action。

只依赖前端从无界事件数组临时派生，无法保证刷新、跨客户端和 schema 演进后的稳定性。

## P1-05：长 Session 必须端到端有界

完整方案需要同时包含：

```text
server cursor pagination
+ bounded initial replay
+ append-fast path
+ gap recovery
+ client bounded accumulation
+ virtualization
+ turn/step collapse
+ search/filter
+ large payload spill/reference
+ performance budgets
```

只做 CSS 折叠、只做前端 virtualization，或只给 SSE 增加 reconnect，都不能关闭无界 DB 读取、内存、排序和 DOM 增长。

---

## 6. Runtime 架构

## P0-04：multi-owner 必须有持久化 generation

Web 和 CLI 都可能访问同一 SQLite 与 Git 工作区时，正确的写入前提应至少包含：

```text
job_id
+ owner
+ claim_generation
+ expected status
```

并应用于：

- heartbeat；
- checkpoint；
- pause / cancel propagation；
- settle；
- Node transition；
- Artifact / Audit 关键写；
- Git promotion。

进程内 `symbol`、Map、AbortController 只能防本进程旧协程，不能防另一个进程 reclaim 后的 zombie executor。

## P0-05：Node 和 Git 需要统一 CAS

Node transition 应使用 expected-from / revision CAS；Git promotion 应统一使用 expected-old OID，例如 `git update-ref <ref> <new> <old>` 的 compare-and-swap 语义。

只在部分表、部分状态或部分分支路径做条件写，仍可能留下旧 owner 推进 Node 或 Git ref 的窗口。

## P0-06：完整 shutdown 必须 abort / kill / join

正确顺序是：

```text
停止领取新 Job
→ 停止接收新 automation work
→ abort 所有 executor
→ kill 已登记子进程
→ 等待 Agent / Gate / Git side effect quiesce
→ 持久化可恢复状态
→ 最后关闭 SQLite / HTTP
```

固定等待若干秒后直接返回，只是超时策略，不是 quiescence 证明。listener unsubscribe 和等待某一类 auto-prepare task，只能关闭特定竞态。

---

## 7. 代码实现与测试可信度

## 7.1 共享 E2E fixture

广泛业务 E2E 不应通过 monkeypatch `window.fetch` 自动塞入 Token，因为这会绕过：

- `main.tsx` 的初始 bootstrap；
- `AuthProvider`；
- RPC header 组装；
- SSE header 组装；
- token scope 切换。

本轮评审优先采用生产同款、标签页级的 `sessionStorage` bootstrap；fragment 捕获、地址栏清理、刷新保持和 URL / Referer 不泄漏，继续由独立、无 monkeypatch 的 production-bootstrap suite 验证。

## 7.2 Green workflow 不等于一次通过

Playwright 将“首次失败、retry 后通过”分类为 flaky。评审时必须同时检查：

- `retry #`；
- `flaky` 数量；
- 首次失败 trace；
- 是否只在冷启动或共享 fixture 下出现；
- 是否存在 server readiness、SSE、DB teardown 或页面导航竞态。

PR Checks 绿色只能证明最终结论为 success，不能据此写“全部一次通过”。

## 7.3 测试应锁真实行为

高价值回归应覆盖：

- 真实启动 URL；
- 首请求带 Token；
- 手工重新连接首请求不 401；
- 同页 hashchange；
- Router history state；
- shutdown 中已进入 callback 的任务；
- lease 失效后旧 owner 无法 heartbeat / checkpoint / settle；
- Node / Git CAS 失败时不产生副作用；
- restart 后 inbox / session / job 恢复。

---

## 8. 过度实现与过度设计

以下能力是 Tekon 的差异化治理底盘，应保留：

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

过度设计集中在 replatform 横向层：Event vocabulary、Profile、Automation、Projection、AgentDriver 契约、recovery 和 multi-owner 状态空间增长快于一个真实 Provider 的纵向可用切片。

在以下纵向链路闭环前，不应继续扩横向抽象：

```text
真实 streaming
→ tool lifecycle
→ follow-up / steer
→ durable inbox
→ restart recovery
→ 同一 UI replay
```

本 PR 已经很大，后续应冻结范围。single-owner daemon / multi-owner、真实 Provider、双轨产品、长 Session 和安全 nonce 应分别进入独立 ADR 与独立 PR。

---

## 9. 推荐执行顺序

1. single-owner daemon，或完整 owner-generation fencing；
2. Node expected-from CAS 与 Git expected-old OID CAS；
3. 完整 shutdown abort / kill / join；
4. 一个真实 Provider 的执行期 streaming 与 tool lifecycle；
5. durable inbox、follow-up / steer / resume 与 restart recovery；
6. Collaborate / Deliver 后端双轨；
7. Narrative Feed、Current-state Inspector 与结构化 Final Result；
8. cursor pagination、bounded replay、virtualization 和性能预算；
9. 一次性短时 bootstrap nonce / rotation。

---

## 10. 官方资料对照

- Playwright retries / flaky：<https://playwright.dev/docs/test-retries>
- React `useEffect`：<https://react.dev/reference/react/useEffect>
- MDN URI fragment：<https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment>
- MDN `sessionStorage`：<https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage>
- Git `update-ref`：<https://git-scm.com/docs/git-update-ref>
- SQLite isolation：<https://www.sqlite.org/isolation.html>
- WAI-ARIA modal dialog：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- DeepSeek Harness architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- OpenAI Codex harness / app-server：<https://openai.com/index/unlocking-the-codex-harness/>

外部资料用于核对模式与术语；最终裁决仍以本 PR 的生产调用链、持久化语义和可复现测试为准。

---

## 11. 最终结论

> **第九轮整体仍不通过。**
>
> 第八轮之后的有效整改应保留；实施方对阶段边界的诚实披露也可以接受。但当前仍未同时满足真实持续 Agent Session、durable inbox、Collaborate / Deliver 双轨、持久化 multi-owner fencing、Node / Git CAS 与完整 shutdown quiescence。
>
> 当前 PR 最多作为诚实标注边界、冻结范围的阶段性基础设施里程碑评估合并；不得宣称完整 Harness 迁移已经完成，也不得宣称普通用户产品已经可发布。

本轮未执行 merge、release 或 deploy。
