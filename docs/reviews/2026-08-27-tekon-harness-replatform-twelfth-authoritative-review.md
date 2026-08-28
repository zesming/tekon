# Tekon Harness Replatform 第十二轮权威全面复审

> 复审日期：2026-08-27  
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`  
> 第十一轮报告提交：`b2174191f33e5330dceff42c4ff28f74972f1068`  
> 实施方第十一轮批注提交：`c224e331577e360112c20b31fece9422116b5fed`  
> 本轮代码审查与修复快照：`f23a24139400e8aeadf0c4ccdec4328c774ec15a`  
> 复审维度：产品逻辑、UI 实现、UX 交互、整体框架、并发与恢复、代码实现、测试可信度、过度实现与过度设计

---

## 1. 最终结论

# **第十一轮批注本身没有关闭核心问题；当前 PR 整体仍不通过**

第十一轮报告之后，实施方只修改了：

- 第十一轮报告的批注；
- `CHANGELOG.md`；
- 根包版本 `0.15.3 → 0.15.4`。

没有新的产品、Provider、Session、Runtime ownership、Node CAS、shutdown 或长会话实现。因此不能把第十一轮剩余项重新判为已完成。

本轮结论必须按验收对象分开：

| 验收对象 | 第十二轮结论 |
| --- | --- |
| 第十一轮实施方批注的事实核验 | **部分接受** |
| 第十轮 Playwright flaky 修复 | **继续通过，但测试覆盖边界需重新表述** |
| 本轮 E2E route-launch fixture 的语义与 hash 保留修正 | **通过** |
| 生产 `#token` 首屏启动、刷新恢复、URL/Referer 不泄漏 | **继续通过** |
| Git promotion expected-old OID CAS | **继续通过** |
| Job owner/status 条件写 | **有效进展，应保留** |
| 当前 PR 是否完成原始“完整 Harness-inspired replatform”计划 | **不通过** |
| 当前 PR 是否可作为默认并发 Web/CLI Runtime 合入 main | **不通过** |
| 普通用户持续协作产品 | **不通过** |
| 单进程、单用户、明确 experimental 的基础设施快照 | 只有在重新基线化范围并强制部署限制后，才可单独评估 |

本轮最重要的新结论有三个：

1. **“剩余全部只是未来里程碑、不是 PR-local 问题”不成立。** 原始总体执行方案明确要求在同一个 PR 分支完成阶段 0–5，阶段 2/3 的验收本身包含 follow-up/steer/inbox、真实 Agent Loop 和浏览器 journey；当前只是在后续文档中把未完成项递延，没有正式重设验收合同。
2. **当前 Session Event 架构存在事实源分裂。** Tekon 把 Session Event 定义为 best-effort projection，失败可吞掉；DeepSeek Harness 的 Session log 则是模型历史、恢复和交互事实的单一来源。两种模型不能同时被描述为同一完成状态。
3. **认证 E2E 的绿色依赖一个明确的测试启动策略。** 去掉每次 hard `page.goto` 的 Token fragment 注入后，CI 立即重新出现 6 个 flaky；恢复显式 deep-route launch 注入后 28 项首轮通过。因此广泛业务 E2E 证明的是“每个测试深链接都以生产启动 URL 进入”，不是“任意硬导航均已验证 sessionStorage 恢复”。

---

## 2. 对实施方第十一轮批注的裁决

### 2.1 接受的部分

以下判断成立：

- 第十一轮直接提交的 Token 同步持久化和 Event append fast path 本身正确；
- Git `update-ref <ref> <new> <expected-old>` 已形成可信 CAS；
- Job heartbeat/checkpoint/settle 的 owner/status 条件写是实质改善；
- 当前剩余的 single-owner daemon、完整 multi-owner、真实 Provider 与 durable inbox 都是较大的架构工作，不适合继续无边界地堆进超大 PR；
- Workflow、Gate、Artifact、Worktree、Audit、Delivery、Human Approval、Independent Review 应保留；
- DeepSeek Harness 仍为 developer preview，Tekon 应继续通过 anti-corruption adapter 借鉴模式，而不是绑定其内部 schema。

### 2.2 只部分接受的部分

实施方把 `persistToken(initialToken)` 判为“生产 sessionStorage 永不落后于内存令牌，已闭环”。

本轮通过反向实验验证了这一措辞过强：

1. 删除共享 E2E 对每次同源 hard `page.goto` 的 `#token` 注入；
2. 保留 `main.tsx` 的同步 `persistToken(initialToken)`；
3. 让业务 journey 依赖上一 document 的 sessionStorage；
4. 正式 CI 得到：

```text
22 passed
6 flaky
exit 1
```

首轮失败仍包括：

- Dashboard Token 输入为空；
- Session Detail `.event-feed` 不出现；
- Delivery Pipeline 不出现；
- Run Detail `.run-header-id` 不出现；
- 新增 hard-navigation storage lock 首轮触发 `SecurityError`。

这不能直接证明默认 `tekon ui` 启动有回归——默认首屏始终携带 `#token`，专用测试也验证 refresh 能从 sessionStorage 恢复。但它证明：

> **同步持久化是有价值的产品硬化，不等于“任意业务 hard navigation 的 storage 恢复已被广泛 E2E 证明”。**

因此本轮将该项从“完整闭环”降级为“默认首屏与 refresh 路径通过；任意深链接 hard navigation 覆盖有限”。

### 2.3 不接受的部分

实施方认为剩余项全部属于“诚实 C 递延”，不应再视为当前 PR 的阻断。

这个推论不成立，原因有两层。

#### 第一层：原始范围没有正式重设

总体执行方案明确写明：

```text
用户决策：按完整报告方向推进
同一分支按阶段推进
全部阶段后全项目 e2e → 整体 reviewer → 无必修项 → PR ready
```

其中阶段 2 明确交付：

```text
AgentDriver events/followUp/steer/pause/cancel/whenIdle
turn/step/inbox/follow-up/steer
assistant chunk/message
运行中纠偏 golden journey
```

阶段 3 明确交付：

```text
默认对话式工作台
运行中 follow-up/steer/pause/cancel
tool/diff/artifact/final-result cards
断线重连 + replay
```

但阶段 2 详细设计又把真实 chunk、inbox、follow-up、steer 递延到 2b；阶段 3 详细设计把 follow-up/steer、真实模型流、diff card 继续列为非目标，同时文件头仍写“3a–3d 全部实现完成”。

这代表的是**子切片完成**，不是原始阶段验收完成。

#### 第二层：Runtime 风险已经暴露在当前产品中

Web server 和 CLI 都会构造并启动 JobRunner，访问同一项目 SQLite、Git worktree 和 subprocess world。single-owner / multi-owner 不是纯未来能力选择；当前部署已经允许多个 owner 出现。

因此，方向确实需要项目决策，但在决策落实之前，结论只能是：

```text
需要决策
≠ 当前实现安全
≠ 当前 PR 可按默认 Runtime 合入
```

---

## 3. P0：范围与验收合同发生漂移

### 理由

一个 PR 是否通过，必须先有稳定的“完成”定义。当前仓库同时存在三种互相冲突的叙述：

1. 总体执行方案：阶段 0–5 全部完成后 PR ready；
2. 阶段 2/3 详细设计：将阶段核心能力递延，但仍标注该详细切片“已实施/全部完成”；
3. 当前 PR 正文与 README：明确只把它描述成阶段性基础设施，承认普通用户持续协作、完整 Runtime 尚未完成。

后两者可以成为合理的新方向，但必须正式替代第一份验收合同，而不是并存。

### 依据

- `docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md`
- `docs/superpowers/plans/2026-08-24-phase2-streaming-agent-loop-design.md`
- `docs/superpowers/plans/2026-08-24-phase3-session-ui-design.md`
- `README.md`
- PR #10 当前说明

### 影响

- reviewer 无法判断“递延”是批准后的 scope change，还是未完成项；
- 阶段状态、版本和 CHANGELOG 会给维护者造成错误完成感；
- 后续 Agent 可能继续把 criteria-based 未通过项批注成“非本轮缺口”，造成无限复审循环；
- 超大 PR 的合并、回滚与责任边界持续恶化。

### 通过条件

必须二选一：

#### 路径 A：坚持原始完整计划

继续完成原始阶段 2–5 验收，直到真实 Provider、inbox、持续 Session、双轨产品和 Runtime ownership 全部闭环。

此路径不推荐继续在当前超大 PR 执行。

#### 路径 B：正式重新基线化（推荐）

- 新增 scope ADR；
- 把本 PR 重命名为类似：

```text
Phase 1 + Phase 2a + partial Phase 3 infrastructure
```

- 把阶段 2/3 文档状态改成“2a / UI slice 已完成，阶段整体未完成”；
- 为 single-owner、Provider vertical slice、durable inbox、Collaborate、长 Session 分别建立独立 issue/ADR/PR；
- 删除“完整 replatform 已完成”的任何暗示；
- 当前 PR 只按重新基线后的基础设施标准验收。

判定：**未通过。**

---

## 4. P0：事实 multi-owner 不能只留给未来 ADR

### 理由

当前不是“未来可能支持 multi-owner”，而是：

```text
tekon ui → Web JobRunner
tekon run / resume / approval → CLI embedded JobRunner
两者 → 同一 SQLite + Git workspace + subprocess world
```

Job owner/status 条件写能够保护部分 Job row，但完整执行权没有贯穿所有副作用。

### 依据

- `packages/web/src/server/api/root.ts`
- `packages/cli/src/lib/session-context.ts`
- `packages/cli/src/commands/run.ts`
- `packages/core/src/session/job-runner.ts`
- `packages/core/src/db/migrations.ts`
- `packages/core/src/db/repositories.ts`

当前 Jobs 表没有持久化 per-claim execution authority；可以采用：

```text
claim_generation
或每次 claim 都生成的唯一 claim token
```

关键不是字段名，而是每次 reclaim 后旧执行权必须永久失效，并且该 authority 必须进入：

- heartbeat/checkpoint/settle；
- Node transition；
- Artifact/Audit/Gate/Delivery 写入；
- Git commit/promotion；
- subprocess control。

### 当前风险

```text
Worker A claim
→ A 停顿，lease 过期
→ Worker B reclaim
→ A 在下一次 heartbeat 发现前恢复
→ A 写 Node / Artifact / Audit 或执行 Git 副作用
```

Git promotion 已有 expected-old OID CAS，这是正确的一层；但 Node transition 仍为：

```sql
update nodes set status = ?, updated_at = ? where id = ?
```

没有 expected-from、revision 或 execution authority。

### 通过条件

#### 推荐：single-owner daemon

- 项目级 Runtime lock，第二 owner fail-fast；
- 一个长驻 Runtime 独占 JobRunner/Agent/Worktree/Subprocess；
- Web/CLI/IDE 只作为客户端；
- shutdown abort/kill/join；
- 两进程竞争 E2E。

#### 或完整 multi-owner

- persistent per-claim authority；
- owner + authority + expected status 条件写；
- Node revision CAS；
- 全副作用 fencing；
- 两个真实进程/SQLite connection 的交错测试；
- CAS miss 后 silent stand-down。

判定：**未通过。**

---

## 5. P0：Session Event 的事实源角色不清晰

### 理由

Tekon 当前明确规定：

```text
workflow/gate/audit 等旧表是事实源
session_events 是 best-effort 追加投影
append/publish 失败可吞掉，不影响治理主路径
```

这对于“UI 可观测投影”是合理的；但它不能同时承担：

- 模型历史的完整来源；
- durable inbox；
- follow-up/steer 的唯一消费记录；
- crash/restart resume；
- Harness 式事件回放事实源。

DeepSeek Harness 的关键约束则是：

```text
Session = append-only typed event log
Session log = interaction history single source of truth
deriveMessages() 从 log 派生模型历史
模型可见即必须可从 log 重建
```

### 依据

- `packages/core/src/session/dual-write.ts`
- `packages/core/src/runtime/agent-step-events.ts`
- `packages/core/src/runtime/legacy-agent-driver.ts`
- `README.md` 当前边界说明
- DeepSeek Harness `docs/architecture.md`
- DeepSeek Harness `docs/subsystems/session.md`

`agent-step-events.ts` 甚至要求 Event sink 必须 best-effort，发射错误不能逃逸；这意味着 `assistant/message` 或 `tool/result` 可能缺失而 Agent 仍成功完成。

### 影响

若不先决定 authority：

- “模型可见历史可重建”只能是弱保证；
- durable inbox 无法以普通 Session Event 直接实现；
- UI timeline 与旧表状态可能永久不一致；
- replay/resume 会同时依赖两个事实源；
- Projection/Checkpoint/Recovery 抽象继续增长，但没有单一不变量。

### 通过条件

二选一：

#### Projection-only 模型

- 明确 Session Event 只是 UI/Audit projection；
- 不宣称它是完整 model history 或 durable command log；
- resume/inbox 使用独立权威表和事务状态机；
- 投影缺失提供 backfill/rebuild，而非把它当交互真值。

#### Authoritative Session log 模型

- 模型可见 Event append 不得 best-effort 丢失；
- 与主状态采用同事务/outbox/commit barrier；
- 模型历史、inbox claim、processed、resume 从 log 与持久化元数据派生；
- crash repair 与顺序不变量有测试；
- 旧表逐步降为 projection。

判定：**未通过。**

---

## 6. P0：Provider 与持续 Session 仍是 one-shot 投影

### 理由与依据

当前生产路径仍为：

```text
step/start
→ await adapter.runAgent(...)
→ Provider 完整结束
→ 合成 node-level tool/call
→ 合成 tool/result
→ assistant/message
→ step/end
```

`LegacyAgentDriver.events()` 仍先 `await done`，再 yield buffered Events；`followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`；Session router 只有 list/get；Session Detail 没有消息 Composer；首页 Composer 创建的是新的 `standard-delivery` Run。

代码依据：

- `packages/core/src/runtime/agent-step-events.ts`
- `packages/core/src/runtime/legacy-agent-driver.ts`
- `packages/web/src/server/api/routers/session.ts`
- `packages/web/src/client/pages/SessionDetailPage.tsx`
- `packages/web/src/client/components/sessions/SessionComposer.tsx`

### 与官方模式的差距

OpenAI Codex App Server 使用：

```text
item/started
→ item/*/delta
→ item/completed
```

让客户端在 item 完成前开始渲染；持久 Thread 包含多个 Turn，可恢复和重连。

DeepSeek Harness 在一个 Turn 内：

```text
claim inbox
→ derive model history from Session log
→ llm/stream
→ assistant/chunk*
→ assistant/message
→ tool/call/result
```

Claude Managed Agents 允许 `user.message` 继续 Session，并用 `user.interrupt` 在执行中停止/转向；queued event 具有 processed 状态。

### 通过条件

至少用一个真实 Provider 完成纵向切片：

- Provider 尚未完成时，浏览器已看到 delta；
- Tool start/progress/result 来自真实 Provider/tool boundary；
- cancel 能停止当前 subprocess/tool；
- follow-up/steer 有 durable pending/claimed/processed；
- refresh/reconnect 从 cursor 恢复；
- daemon 重启后恢复 Session/Turn；
- 同一 Session 可以继续下一 Turn。

判定：**未通过。**

---

## 7. P0：Shutdown 仍未完成 quiescence

### 理由与依据

`JobRunner.stop()` 当前：

```text
停止 poll
→ 等 pending 或 5 秒超时
→ 清 heartbeat/controller/execution token/pause map
→ 返回
```

清 Map 不会终止 Promise、Provider subprocess、Gate command 或 Git side effect。超时后，上层仍可能关闭 DB。

代码依据：

- `packages/core/src/session/job-runner.ts`
- `packages/core/src/session/subprocess-registry.ts`
- `packages/web/src/server/api/root.ts`

### 通过条件

```text
停止 claim 新 Job
→ 停止接收 automation work
→ shutdown reason abort 全部 executor
→ kill registry 子进程
→ join Agent/Gate/Git side effect
→ 持久化明确可恢复状态
→ 最后关闭 DB/HTTP
```

并增加：

- 永不结束 executor；
- 拒绝响应 abort 的 executor；
- 活跃 subprocess；
- shutdown 与 Git promote 交错；
- DB close 后无迟到写入。

判定：**未通过。**

---

## 8. UI、UX 与产品逻辑

### 8.1 已经改善并继续通过

以下方向正确：

- 默认入口明确叫“受控交付”，不再伪装成轻量聊天；
- Session-first 路由，旧 Cockpit 位于 `/advanced`；
- 390px 页面级横向溢出已关闭；
- 移动 drawer 具备 modal/focus trap/Escape/focus restore/inert；
- 单一 main landmark；
- Feed 使用 `role="log"`；
- 审批和 PR 创建保留显式确认；
- Token 首屏 fragment 不进入 HTTP URL/Referer，刷新恢复有专用测试。

### 8.2 认证测试覆盖边界必须诚实标注

本轮尝试移除共享 E2E 的 hard-navigation Token 注入，正式 CI 立即恢复 6 flaky。随后恢复显式 route-launch policy，并做两项修正：

1. 注释明确：广泛业务 journey 的每次 hard `page.goto` 都被视为一次新的 authenticated `tekon ui` launch；
2. 使用 `URLSearchParams` 在已有 hash 上追加 Token，不再无条件覆盖已有 fragment 参数。

最终测试 `shared-fixture-auth-lock` 明确验证的是：

```text
sessionStorage 被清空
→ deep route page.goto 自动携带 #token
→ 首屏认证成功
→ 应用清除 fragment
```

它不再被描述为 sessionStorage hard-navigation 测试。

通过边界：

- 默认 `#token` 启动：通过；
- refresh/sessionStorage：专用测试通过；
- 任意无 fragment 的 hard deep-link navigation：当前广泛业务套件不覆盖，不能宣称完全通过。

### 8.3 Token 仍长期暴露在顶栏

自动 bootstrap 后，普通用户仍看到完整密码输入框和显示按钮；输入暂停 350ms 后自动切换 auth scope。

建议默认改为：

```text
已连接 / 认证失败
重新连接
高级设置
```

手工 Token 使用 local draft + 显式“应用”，避免用户尚未输入完就重建 RPC/SSE scope。

代码依据：`packages/web/src/client/layouts/TopBar.tsx`。

判定：**P1 未通过。**

### 8.4 Feed 仍是系统事件墙

当前仍直接展示：

```text
step/start/end
workflow/node-started/ended
gate/result
job/status
artifact/created
unknown raw event
```

默认 Narrative 应聚合为：

```text
理解需求
形成计划
实施变更
运行验证
请求审批
完成交付
```

raw Event、seq、Node ID、checkpoint、correlation ID 应进入 Advanced/Audit。

代码依据：

- `packages/web/src/client/lib/event-feed.ts`
- `packages/web/src/client/components/sessions/EventFeed.tsx`

判定：**P1 未通过。**

### 8.5 Inspector 仍复制历史，Final Result 仍过浅

右栏再次从全部 Events 提取 Tool/Artifact/Error cards，与 Feed 重复；最终结果主要为：

```text
运行结束 · status
产物 N · 错误 M
```

Inspector 应是当前状态投影：

- Current Plan；
- Changed Files；
- 最新 Checks/Gates；
- Pending Approval；
- Risks/Limitations；
- Final Result；
- Delivery/PR/CI；
- Recovery Action。

Final Result 应由服务端结构化输出，而不是浏览器临时扫描原始 Events。

代码依据：

- `packages/web/src/client/lib/session-side-panel.ts`
- `packages/web/src/client/components/sessions/SessionSidePanel.tsx`

判定：**P1 未通过。**

### 8.6 长 Session 仍无界

当前仍是：

```text
SSE 初始从 seq=0 拉全部
服务端 listEventsSince 无 limit
客户端永久保存 events[]
Feed 与 SidePanel 分别扫描全部历史
DOM 无 virtualization
```

append fast path 只优化正常合并 CPU，不限制网络、内存、投影和 DOM。

需要：

- cursor pagination；
- bounded initial replay；
- gap recovery；
- client bounded accumulation；
- Turn/Step collapse；
- virtualization；
- search/filter；
- large payload spill/reference；
- 10k+ Events 性能预算。

判定：**P1 未通过。**

### 8.7 视觉审计证据限制

本轮 GitHub Actions 没有上传可下载截图 Artifact，当前执行环境也没有可控制的产品浏览器。因此本轮没有声称完成新的像素级视觉审计。

本节 UI 结论仅基于：

- 当前组件/样式代码；
- 现有 Playwright 布局、键盘与流程断言；
- 当前正式测试日志。

没有复用旧轮次截图作为本轮视觉证据。

---

## 9. 过度实现与过度设计

### 不属于过度设计

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

这些是 Tekon 的受控交付价值，应继续保留。

### 当前真正的过度设计

横向抽象已领先于纵向闭环：

```text
Event vocabulary
Profile
Automation Job
Projection checkpoint
AgentDriver / AgentHandle 契约
DSH bridge
multi-owner recovery
```

同时：

- `AgentDriver` 关键方法未实现；
- Legacy driver 没有生产 caller；
- Session Event 仍是 best-effort projection；
- Collaborate 产品不存在；
- 一个真实 Provider 的实时纵向链路尚未完成。

PR 当前约 170+ commits、208 changed files、3.4 万行新增。继续在本 PR 增加横向 Event/Profile/Automation 会降低评审、revert 和故障定位能力。

### 简化建议

立刻冻结当前 PR，不再添加新横向能力。后续顺序：

1. scope rebaseline ADR；
2. single-owner Runtime lock/daemon；
3. shutdown quiescence；
4. 一个真实 Provider streaming vertical slice；
5. durable inbox + follow-up/steer/resume；
6. Collaborate track；
7. Narrative/Inspector/Final Result；
8. long-session bounded architecture。

---

## 10. 本轮直接修改

### 10.1 认证 E2E 反向实验

中间快照：`0f65b71b786f6bbc297a7f993e47cb82377d3596`

变更：移除共享 fixture 对 hard `page.goto` 的 `#token` 注入，尝试让全部业务 journey 走 sessionStorage。

正式 CI：

```text
Core: success
Root: success
CLI: success
Web unit/build: success
Playwright: failure
22 passed / 6 flaky / exit 1
```

该失败实验未保留为最终行为，但作为第十二轮测试边界证据记录。

### 10.2 最终保留的测试修正

提交：

```text
eabdce1da4053b98007066643a84fe69c6d7bea2
test(web): make authenticated route-launch fixture explicit

f23a24139400e8aeadf0c4ccdec4328c774ec15a
test(web): lock authenticated deep-route launch policy
```

最终行为：

- 每次同源 hard `page.goto` 明确视为一次 authenticated launch；
- 追加 Token 时保留已有 hash 参数；
- 注释不再把广泛 journey 描述成 sessionStorage recovery 测试；
- auth-lock 清空 sessionStorage，验证 fragment 是该 deep-route 首屏的唯一 Token 来源；
- prod-bootstrap suite 继续独立验证 refresh/sessionStorage、URL cleanup 与 Referer。

这属于测试可信度和覆盖边界修正，不冒充产品功能完成。

---

## 11. 正式验证

### 11.1 最终代码快照

```text
f23a24139400e8aeadf0c4ccdec4328c774ec15a
```

- Core workflow `33072333808`：success
- CI workflow `33072333654`：success
- Root typecheck + lint：success
- CLI build + unit + e2e：success
- Web build + typecheck + unit：success
- Web Playwright job `98517899117`：success

Playwright：

```text
Running 28 tests using 1 worker
28 passed (36.7s)
```

日志中没有 `retry #1`，因此最终代码快照为 28 项首轮通过、0 flaky。

### 11.2 失败对照快照

```text
0f65b71b786f6bbc297a7f993e47cb82377d3596
```

- Core/Root/CLI/Web unit：success
- Web Playwright job `98516017053`：failure
- `22 passed / 6 flaky / exit 1`

该对照证明 route-launch injection 是广泛业务 E2E 的测试前置条件；最终报告不会把它误写成“全部 journey 验证了 storage fallback”。

### 11.3 验证边界

正式绿色 CI 证明当前已有断言通过；它不证明尚未实现的：

- real Provider streaming；
- durable inbox；
- follow-up/steer/resume；
- persistent execution authority；
- Node/side-effect fencing；
- shutdown quiescence；
- arbitrary hard-navigation storage fallback；
- 10k+ Event 性能；
- 新的截图级视觉质量。

---

## 12. 官方资料对照

- OpenAI Codex App Server：<https://openai.com/index/unlocking-the-codex-harness/>
  - item 有 `started → delta → completed` 生命周期；
  - Thread 是包含多个 Turn 的持久 Session 容器。
- DeepSeek Harness architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
  - 一个 inbox 驱动 Turn/Step；
  - `llm/stream → assistant/chunk* → assistant/message`；
  - Session log 生成模型历史。
- DeepSeek Harness Session：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
  - append-only typed log 是 interaction history 的 single source of truth。
- Claude Managed Agents Events：<https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
  - `user.message` 继续 Session；
  - `user.interrupt` 可在执行中停止并重定向；
  - queued event 有 processed 状态；
  - event delta 与 authoritative buffered event 分层。
- Git update-ref：<https://git-scm.com/docs/git-update-ref>
  - 三参数形式先校验 expected old OID，再更新 ref。
- SQLite transactions：<https://www.sqlite.org/lang_transaction.html>
  - `BEGIN IMMEDIATE` 获取写事务并串行化 SQLite writer；
  - 这不能替代 Git/subprocess/外部副作用的 execution fencing。

外部资料只用于核对模式和验收标准；最终裁决仍以当前仓库代码、计划合同、持久化语义和正式 CI 为准。

---

## 13. 合并建议

### 当前不建议按默认 Runtime 合入 main

原因不是 CI 红——最终代码快照 CI 已绿；原因是：

- 原始范围与当前阶段性范围没有正式重新基线化；
- 当前部署事实允许 Web/CLI multi-owner；
- execution authority 没有贯穿 Node 与外部副作用；
- shutdown 不保证 quiescence；
- Session Event 的 authority 角色未决。

### 可接受的最小合并路径

若项目决定把它作为 experimental infrastructure snapshot 合并，至少需要：

1. 正式 scope ADR 和阶段状态订正；
2. PR 标题、CHANGELOG、README 统一写明 partial infrastructure；
3. 代码级 single-owner enforcement，而不是只靠文档“禁止并发”；
4. 明确 Session Event 是 projection 还是 authority；
5. 关闭当前超大 PR，后续功能全部使用独立小 PR；
6. 不宣称普通用户持续协作或完整 Harness 迁移完成。

若不做以上重新基线化，则应继续按原始执行计划验收，当前显然未完成。

---

## 14. 最终裁决

> **第十二轮仍不通过。**
>
> 实施方第十一轮批注正确承认了 single-owner / multi-owner 需要项目决策，也正确保留了 Git CAS、Job 条件写、认证启动、移动端与测试治理改进。但它没有提交新的产品或 Runtime 实现，并且把剩余项全部归为“非 PR-local 递延”与原始总体执行方案冲突。
>
> 本轮进一步确认：同步 Token 持久化不应被表述成“所有跨文档认证已闭环”。广泛业务 E2E 的稳定绿色依赖每次 hard route launch 自动携带生产 Token fragment；移除该策略会恢复 6 flaky。本轮已经把这一测试策略和覆盖边界写清楚，并修正了已有 hash 被覆盖的问题，最终正式 CI 28 项首轮全过。
>
> 真正阻断合并的仍是：范围合同漂移、事实 multi-owner 未被代码约束、Session Event 事实源分裂、one-shot Provider、缺 durable inbox/follow-up/steer、Node/side-effect fencing 和 shutdown quiescence。产品侧 Feed、Inspector、Final Result 与长 Session 也未达到普通用户长期使用标准。
>
> 推荐立即冻结该 PR，先正式重新基线化为 partial infrastructure，并用一个独立 ADR/PR 落实 single-owner daemon；随后再以小 PR 完成真实 Provider 的 streaming → durable inbox → follow-up/steer → recovery 纵向闭环。

本轮未执行 merge、release 或 deploy。

---

## 15. 实施方批注（第十二轮）

> 批注日期：2026-08-28  
> 实施方 HEAD：`ef56dfa`（已 fast-forward 到远端）→ 本轮收敛提交见文末版本记录  
> 评估方式：动态评估 workflow（3 视角并行 + 首席 max 综合），三视角 + 首席一致 `hasMustFix=false`、`needsUserAdrDecision=true`。逐条代码事实已由实施方独立复核。

### 15.1 结论：本轮为第五个「无新 PR-local 代码必修」轮（与第 8/9/11 轮同类）

`c224e33..ef56dfa` 6 个新提交经 `git diff --stat` 核验，**只改了两个 e2e 测试文件（`shared-fixture.ts`、`shared-fixture-auth-lock.test.ts`）与本报告**，无任何产品 / Provider / Session / Runtime / Node / shutdown 代码变更。最终快照 CI 28 项首轮全绿（报告 §11.1，实施方本地复跑一致）。因此本轮不存在可在不做用户级架构决策的前提下、孤立修复的 PR-local 代码缺陷。

**接受报告对整体验收对象的裁决**：作为「原始完整 Harness replatform 计划」与「默认并发 Web/CLI Runtime 合入 main」，当前 PR 确实不通过；这与实施方自第 4 轮起反复记录、并向用户呈现的判断一致。分歧不在事实，而在**归类**——报告要求把这些计入「本 PR 未通过」，实施方主张它们是「需用户先拍板方向的架构决策 / 已披露里程碑」，二者可在下述 ADR 决策落定后统一。

### 15.2 逐条裁决（A/B/P/C/D）

| 报告条目 | 分类 | 理由与证据 |
| --- | --- | --- |
| §8.2 / 本轮 5 个 `test(web)` fixture 提交（`9d3a0f3`/`8b56961`/`0f65b71`/`eabdce1`/`f23a241`） | **B**（本轮唯一真实代码产物，闭环真锁无回归） | `9d3a0f3` 作为反向实验移除第十轮的 `page.goto` `#token` 注入 → 复现 6 flaky；`eabdce1` 以 **`URLSearchParams` 保留 hash 的条件注入**恢复（`shared-fixture.ts:49-59`：先解析已有 hash，仅当 `!hash.has('token')` 才 `set`），严格优于第十轮的无条件 `target.hash` 覆盖。复核确认无隐患：`App.tsx` 用 `createBrowserRouter`（路径路由），所有业务 `page.goto` 均为裸路径无 hash，故 `URLSearchParams('')` 起点为空 → 干净 `#token=`；`beforeEach`（`:72`）唯一带 hash 的 goto 其 fragment 已含 `token=` → 正确跳过不双写；视角担心的 `#/route→#%2Froute=` mangling 在本套件不可达。`auth-lock` 为真锁（revert 注入则 `.run-header-id` 15s 超时 401 失败），非死测试。 |
| §2.1 接受部分（Git `expected-old` CAS / Job owner-status 条件写 / Token 同步持久 / Event append fast-path 正确保留） | **B** | 与第 9~11 轮共识一致，无回归。 |
| §8.1 已改善继续通过（受控交付入口 / Session-first 路由 / 移动 drawer focus trap / `role="log"` / token 不进 URL/Referer） | **B** | 前几轮 UX / 可访问性 / 移动端 / token bootstrap 修复正确保留，无回归。 |
| §8.7 / §11.3 视觉审计与验证边界限制 | **B** | 报告如实声明本轮无新像素级视觉证据、CI 绿不证明未实现能力。诚实的验证边界陈述，无夸大——**实施方本轮同样不声称新的截图级视觉审计**（无可下载 CI 截图 artifact、无可控产品浏览器）。 |
| §2.2 将第十一轮 `persistToken` 从「完整闭环竞态」降级为「首屏 + refresh 通过；任意深链 hard-nav 覆盖有限」 | **P**（措辞 / 覆盖边界修正，**接受**） | 降级 **正确**。反向实验 `0f65b71`（移除注入）确实复现 `22 passed / 6 flaky / exit 1`，证明广泛业务 E2E 绿依赖每次 hard route launch 注入 `#token`，而非 sessionStorage 恢复。`persistToken` 闭合的是**产品首屏 + refresh**（`prod-bootstrap` 专测独立覆盖），不是任意无 fragment 的 hard deep-link。**实施方据此订正自身第十一轮 CHANGELOG / 记忆中「闭环了同一 bootstrap 竞态」的过强措辞**为「产品首屏 + refresh 恢复路径通过（`prod-bootstrap` 覆盖）；广泛业务 E2E 绿依赖测试启动策略注入 `#token`，任意深链 hard-nav 的 sessionStorage 回落未被广泛 E2E 证明」。fixture 注释（`shared-fixture.ts:38-41`）与 `auth-lock` 标题（`:8`）已如实标注，无需再改测试码。 |
| §3 P0 范围 / 验收合同漂移（路径 A 坚持原计划 / 路径 B 重新基线化） | **C（needs-user-ADR）** | 事实**为真**：`docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md:14/16/41/108-120` 记录「用户决策：按完整报告方向推进」「同一分支按阶段推进」并把 follow-up/steer/inbox/streaming/diff-card 列入同一 PR；而 `phase2` 头称「已实施 S1–S6 完成」、`phase3` 头称「3a-3d 全部实现完成」，其 §0.2 却**显式递延**同批核心能力到 2b/phase4。但「路径 B 重新基线化」会**覆盖已记录的用户决策**、重定义验收合同 / PR 标题 / README——**实施方不能单方裁定**，须交用户。见 §15.3-①。 |
| §4 P0 事实 multi-owner 不能只留未来 ADR | **C（needs-user-ADR）** | 自第 4 轮起每轮标记的用户 ADR。`root.ts` + CLI `run.ts`/`approval.ts`/`session-context.ts` 都 `createJobRunner().start()`、共享同一 SQLite/Git 且无 runtime lock 是**事实**；`repositories.ts:569` `transitionNode` 仍为无 CAS 的 `update nodes set status=?, updated_at=? where id=?`；`claim_generation` 列 grep 为空。报告「需要决策 ≠ 当前安全 ≠ 可合入」的**风险论断成立**，但两条闭合路径（single-owner daemon / 完整 multi-owner fencing）都是需用户先拍板方向的重大架构改动。见 §15.3-②。 |
| §5 P0 Session Event 事实源角色不清晰（best-effort projection vs authoritative log）— **本轮新框定** | **C（needs-user-ADR）** | 本轮最新框定。核验后是**设计选择需明文决定**，非既有 correctness bug：当前 `dual-write.ts` 显式声明 `session_events` 是 best-effort 投影、绝不拖垮治理路径（C1），治理主路径（workflow/gate/audit 旧表）才是事实源——自洽且已披露，不造成治理数据错误。报告的通过条件二选一（projection-only 明文化 / authoritative log）均需 ADR，且与既有 durable-inbox C 递延重合。见 §15.3-③。 |
| §6 P0 Provider / 持续 Session 仍 one-shot 投影 | **C** | `legacy-agent-driver.ts:132` `await done` 一次性、`followUp`/`steer`/`resume` throw `NotSupportedYet`、session router 仅 list/get、`SessionComposer` 起 `standard-delivery` run——自第 2/3 轮起披露并 C 递延的真实 Provider streaming 里程碑。核验属实且本轮未改动。 |
| §7 P0 Shutdown 未完成 quiescence | **C** | `STOP_SETTLE_TIMEOUT_MS = 5_000` 清 map 不终止 subprocess/Promise，是第 4~11 轮披露的 shutdown quiescence 里程碑。修复需 executor abort / subprocess kill / join 的实质架构工作。 |
| §8.3-8.6 Token 顶栏 / Feed 系统事件墙 / Inspector 复制历史 + Final Result 过浅 / 长会话无界 | **C** | 均报告自判 **P1**，属 token 状态化 / Narrative Feed / Inspector 当前状态 / 结构化 Final Result / 长会话 bounded 的产品化里程碑，第 4~11 轮一贯 C 递延（报告 §8/§9 自身接受为独立 PR）。现有实现无回归。 |
| §9 过度设计（横向抽象领先纵向闭环）+ 冻结 PR 建议 | **C（流程 / 项目决策）** | 观察属实（`AgentDriver` 关键方法未实现、legacy driver 无生产 caller、170+ commits），但属 PR 治理策略建议，需项目 / 用户决策，非可修代码缺陷。 |
| §1 / §14 最终裁决（整体不通过） | **C** | 裁决所依据的全部阻断项，均为自第 4 轮起报告 §8 自认的独立 ADR/PR 里程碑或待用户拍板项，非本轮可修的 PR-local 代码 bug；CI 最终快照 28 项首轮全绿。 |

**无 D（误报）**：本轮报告的事实陈述经逐条核验全部属实，未发现夸大或错误定位。这与第三轮（机器生成、含 REG-01/P1-04 误报）形成对比——本轮是扎实的架构级复审。

### 15.3 交用户 / 项目拍板的决策（`needsUserAdrDecision=true`，自第 4 轮起持续呈现，本轮报告 §3/§4/§5 进一步收紧）

以下三项都**不是实施方可单方在本 PR 内低成本修复的代码**，而是需要用户 / 项目先定方向的重大决策。实施方不做未经拍板的架构重写（符合 CLAUDE.md「不要当英雄」「Iron Man suit 优先」与相称原则）：

**① 范围合同重新基线化（报告 §3，路径 A vs 路径 B）**
- **路径 A**：坚持原始完整计划，继续在（或另起 PR）完成阶段 2–5 的真实 Provider、inbox、持续 Session、双轨与 Runtime ownership 全闭环。报告不推荐继续在当前超大 PR 执行。
- **路径 B（报告推荐）**：新增 scope ADR，把本 PR 正式重命名 / 重新验收为 `Phase 1 + 2a + partial Phase 3 infrastructure`，订正 phase2/3 文档状态为「slice 完成、阶段整体未完成」，为 single-owner / Provider 纵切 / durable inbox / Collaborate / 长 Session 分别建独立 issue/ADR/PR，并删除任何「完整 replatform 已完成」的暗示。
- 此项会**覆盖已记录的「用户决策：按完整报告方向推进」**，故必须由用户裁定。

**② Runtime ownership（报告 §4，single-owner daemon vs 完整 multi-owner）**
- **single-owner daemon（报告推荐）**：项目级 Runtime lock，第二 owner fail-fast；长驻 Runtime 独占 JobRunner/Agent/Worktree/Subprocess；Web/CLI/IDE 仅作客户端。
- **完整 multi-owner fencing**：持久 per-claim authority（`claim_generation` 或 claim token）贯穿 heartbeat/checkpoint/settle + Node transition CAS + Artifact/Audit/Gate/Delivery + Git + subprocess control，配两进程交错测试。
- 报告的关键论断——「当前部署已允许多 owner，需要决策 ≠ 当前实现安全」——成立；在决策落实前，不能按默认并发 Runtime 合入 main。

**③ Session Event 事实源角色（报告 §5，projection-only vs authoritative log）**
- **projection-only**：明文规定 Session Event 只是 UI/Audit 投影，不宣称是完整 model history 或 durable command log；resume/inbox 使用独立权威表与事务状态机；投影缺失走 backfill/rebuild。
- **authoritative log**：模型可见 Event append 不得 best-effort 丢失，与主状态同事务/outbox/commit barrier；模型历史、inbox claim/processed、resume 从 log 派生，旧表逐步降为 projection，并补 crash-repair 与顺序不变量测试。
- 此项决定与 durable-inbox（§6）耦合，属同一纵向切片的架构决策。

### 15.4 本轮相称动作

- 追加本批注（§15，A/B/P/C/D 分类 + 逐条理由与证据）；
- **订正实施方自身对 `persistToken` 的过强措辞**（§15.2 的 P 项，同步 CHANGELOG 与记忆）；
- 版本 `0.15.4 → 0.15.5`（PATCH：文档批注 + 措辞订正，无用户可见行为变化，无代码变更）；
- 向用户呈现 §15.3 的三项 ADR 决策；
- **不做未经用户拍板的架构重写，不为凑工作量改代码**（第 8/9/11 轮同类相称做法）。

README / manual / AGENTS 无需同步：本轮无代码行为变化，仅文档批注与版本记账。
