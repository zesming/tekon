# Tekon 人类可用性与 Harness 架构第六轮全面复审

- **复审日期**：2026-08-30
- **用户本轮整改提交**：`ca30e8c278ec23c1655535a702178b05c7f8d348`
- **本轮审阅修复提交**：
  - `772e7a7a85a0c39d6e815ca059997b420f0cfd67`
  - `e32aa78e4780d4cfb4dceeed1cad9271764b153d`
  - `3d7f8c151efb66a864ad29311311f170eae7466c`
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **对照基线**：第五轮权威报告快照 `3dd4330664117f1df2999435c9aecd6bf36720dd`；仓库主线 `main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **用户整改验证**：Core #284 `success`；CI #193 `success`
- **本轮代码验证**：`772e7a7` Core #285 / CI #194 `success`；`e32aa78e` Core #286 `success`（CI #195 因后续提交被取消）；`3d7f8c1` Core #287 `success`，CI #196 由 PR 自动化继续验证
- **覆盖维度**：产品逻辑、CLI/Web UI、UX 与可访问性、Runtime/Session/数据架构、代码实现、测试可信度、DeepSeek Harness 最新官方边界、过度实现与过度设计
- **最终结论**：**用户的 v0.17.0 整改方向正确且有实质价值；在本轮补齐跨入口合同、停机竞态、SSE 隔离和查询状态问题后，最新代码可以继续合并审阅。Tekon 仍不通过“面向普通人的稳定持续协作研发工作台”产品验收，可作为实验性受控交付执行与观察基础设施有条件通过。**

> 本报告取代第五轮附录和整改回填，成为 PR #11 当前详细裁决。`docs/reviews/current.md` 是稳定入口；旧报告只保留判断演进历史。

---

## 1. 执行摘要

用户本轮不是简单修改措辞，而是一次真实的产品增量：版本提升到 `0.17.0`，新增或加强了安全停机、执行计划、dsh 联网确认、失败处理、连接管理、workspace 实时刷新、长事件流展示和主路径可访问性。版本提升合理，代码与测试总体方向正确。

但第五轮报告附录把多项“已经有实现”直接等同于“合同已闭环”，高估了成熟度。本轮对代码、入口和故障路径重新交叉验证后，发现六个会直接影响真实行为的断点：

1. Web 有 dsh 不受限网络确认，CLI 仍可无确认启动；
2. 高级页面有执行计划，默认 Session 主入口仍可直接启动完整交付；
3. 失败会话可以在未失败时预先 acknowledge，`list/get` 语义不一致，重试后的新失败可能被旧确认遮蔽；
4. 顶栏虽然出现“应用连接”，输入内容仍会自动切换活动 Token，“已连接”也只是字符串存在而非服务端验证；
5. `JobRunner.stop()` 与已经进入的 poll 存在竞态，stop 可能在新任务被 claim/spawn 前冻结空的 pending 集合并提前返回；
6. workspace SSE 的 process-local 路径订阅全仓库事件，却把其它 workspace 的 session id/type 标成当前 workspace 转发。

本轮已直接修复上述问题，并额外修复 `useQuery` 在查询键切换时短暂暴露上一份执行计划或旧认证域数据的问题。

仍不能关闭的结构性主线是：

```text
single-owner runtime
→ 可证明的 shutdown / recovery 语义
→ 权威 Session log + durable inbox
→ 真实 Provider / DSH SDK 或 ACP streaming
→ follow-up / steer / resume / restart recovery
→ Collaborate → Deliver 显式升级
→ 长 Session 数据、内存与 DOM 全链路有界化
```

---

## 2. 复审方法与证据边界

本轮覆盖了：

- **产品与文档**：README、用户手册、技术计划、第五轮报告及附录、`current.md`、CHANGELOG；
- **CLI**：入口、run/goal/provider 参数、Session composition、JobRunner、pause/cancel/resume；
- **Web**：默认 Session Composer、高级 StartRunForm、TopBar、SessionsPage、EventFeed、SSE/RPC、审批与运行控制；
- **Core**：JobRunner、Session store/service、dual-write、Agent runtime、dsh adapter/probe、run plan 和数据库 migration；
- **测试**：Core/CLI/Web 单测、API 集成、Playwright、Actions 工作流；
- **外部基线**：DeepSeek Harness 最新 prerelease、Architecture、Headless、SDK、ACP 和 Safety 官方文档。

本轮没有可访问的独立部署实例，因此没有冒充完成全站视觉、屏幕阅读器或多浏览器审计。UI 判断来自组件结构、状态合同、ARIA/label、RPC/SSE 行为和 Chromium Playwright。

---

## 3. 对用户 v0.17.0 整改的逐项裁决

| 整改方向 | 裁决 | 理由 |
| --- | --- | --- |
| P0-ARCH-02 安全停机 | **显著改善，仍为部分完成** | 用户增加等待、abort/kill 和 drain；本轮又补齐 active poll 与 pending snapshot 竞态。仍缺对不响应 abort 的 executor 的硬终止上界，也未定义“服务关闭应 cancel 还是可恢复 requeue”的持久语义。 |
| P1-PRODUCT-02 执行计划 | **部分通过** | 高级页已有角色、阶段、Gate 和网络摘要，本轮补到默认主入口；但计划不是与 run 绑定的权威快照/摘要哈希，字段仍缺实际 provider 配置、权限 posture、产物、dirty-base、完整 timeout 和成本影响，且高级页 plan 失败时尚未统一 fail-closed。 |
| P1-SEC-01 dsh 联网确认 | **当前 Web/CLI 启动合同已关闭** | 用户完成 Web/RPC/审计，本轮补齐 CLI 显式参数、fail-fast、runtime override 与审计。仍不代表 Harness 本身安全，也不替代 OS/container 隔离。 |
| P1-UX-02 失败处理 | **主要闭环** | 有持久 `acknowledged_at`、RPC、排序和 UI；本轮禁止非 failed 预确认、统一 list/get，并让后续失败重新成为待处理。长期仍应使用明确 failure generation，而不是依赖时间戳耦合。 |
| P1-UX-03/04 连接与术语 | **交互语义改善，验证语义部分完成** | 本轮移除自动应用，改为草稿 + 显式应用，并把“已连接”改为诚实的“凭据已设置”。仍没有服务端握手、身份或过期状态，不能声称真实连接健康。 |
| P1-UX-01 workspace 实时刷新 | **当前轻量合同通过** | 用户增加 SSE + 跨进程签名轮询；本轮补齐跨 workspace 隔离。它仍是刷新通知，不是 durable workspace event stream。 |
| P1-UX-05 长 Session | **仅 DOM 层部分完成** | EventFeed 默认窗口减少渲染节点；`useSessionStream` 仍把全历史永久保存在浏览器内存，服务端 replay/传输也无 cursor/limit，因此不能称“长 Session 有界”。 |
| P2-A11Y-02 | **部分完成** | 主入口、StartRunForm、连接面板和若干状态具备更好语义；仍缺全站焦点顺序、错误关联、名称/角色/值、对比度、屏幕阅读器和多浏览器专项。 |
| P2-PROCESS-01 | **未按声明真正关闭** | 第五轮报告继续追加大段代理批注和整改回填，与“只维护 current.md + 当前报告”的规则冲突。本轮不再追加 CHANGELOG 或旧报告，直接生成第六轮权威报告。 |

---

## 4. 本轮实际代码修复

### 4.1 跨入口 dsh 联网知情确认

提交：`772e7a7a85a0c39d6e815ca059997b420f0cfd67`

涉及：

- [`packages/cli/src/commands/run.ts`](../../packages/cli/src/commands/run.ts)
- [`packages/cli/src/lib/agent-factory.ts`](../../packages/cli/src/lib/agent-factory.ts)
- [`packages/cli/__tests__/run-mode-policy.test.ts`](../../packages/cli/__tests__/run-mode-policy.test.ts)

修复内容：

- 新增 `--acknowledge-unrestricted-network`；
- 对需要不受限网络的 provider 在 Workflow/Session/Job 副作用前 fail-fast；
- 只在明确传参时把 acknowledgement 写入 provider runtime override；
- `onPrepared` 写入 `run.network-acknowledged` 审计，标记 `surface: cli`；
- 增加无确认拒绝与 runtime threading 测试。

这关闭的是“当前 Tekon Web/CLI 启动入口的知情确认合同”，不是对 dsh 安全性的背书。用户手册中的旧表述仍应在独立文档清理中改成精确参数说明。

### 4.2 默认人类入口补齐执行计划

提交：`772e7a7a85a0c39d6e815ca059997b420f0cfd67`

涉及：

- [`SessionComposer.tsx`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`session-routing.test.ts`](../../packages/web/__tests__/e2e/session-routing.test.ts)

默认 `/` 不再完全绕过 run plan：它会加载服务端计划并展示角色链、控制点、人工确认数量和网络摘要；计划加载失败时阻止主入口启动并提供重试。

这使“默认人类入口”与高级表单不再拥有两套透明度标准。不过高级页的计划仍是预览数据，不是被 run 消费和审计的不可变计划快照，故 P1-PRODUCT-02 仍为部分完成。

### 4.3 失败确认的当前状态语义

提交：`772e7a7a85a0c39d6e815ca059997b420f0cfd67`

涉及：

- [`packages/web/src/server/api/routers/session.ts`](../../packages/web/src/server/api/routers/session.ts)
- [`session-acknowledge.test.ts`](../../packages/web/__tests__/api/session-acknowledge.test.ts)
- [`SessionsPage.tsx`](../../packages/web/src/client/pages/SessionsPage.tsx)

修复内容：

- 仅当前状态为 `failed` 的 Session 可标记已处理；
- `session.list` 与 `session.get` 返回一致的 `acknowledgedAt/needsAction/actionKind`；
- 后续状态变化或新失败使旧确认失效；
- 文案从容易与生命周期归档混淆的“确认归档”改为“标记已处理”；
- 测试覆盖预确认拒绝、重复失败重开、list/get 一致和 HTTP token 边界。

当前实现通过 `acknowledged_at === updated_at` 识别同一失败代际，能修复现有行为，但长期更稳健的方案是持久化 `failure_generation` 或在状态转移 SQL 中原子清空 acknowledgement。

### 4.4 连接凭据改为显式应用

提交：`772e7a7a85a0c39d6e815ca059997b420f0cfd67`

涉及：

- [`TopBar.tsx`](../../packages/web/src/client/layouts/TopBar.tsx)
- [`topbar-connection.test.ts`](../../packages/web/__tests__/e2e/topbar-connection.test.ts)

修复内容：

- 移除输入 350ms 后自动切换活动 Token 的隐式行为；
- 编辑期间仅保存本地草稿；
- Enter/“应用连接”才切换认证域并清理旧 cache/SSE；
- Escape/关闭恢复焦点；
- “已连接”改为“凭据已设置”，不伪装服务端验证。

### 4.5 JobRunner stop/poll 竞态

提交：`e32aa78e4780d4cfb4dceeed1cad9271764b153d`

涉及：

- [`packages/core/src/session/job-runner.ts`](../../packages/core/src/session/job-runner.ts)
- [`job-runner-stop-race.test.ts`](../../packages/core/__tests__/session/job-runner-stop-race.test.ts)

原序列可能是：

```text
poll 通过 stopped 检查
→ await syncOwnedControls
→ stop 设置 stopped 并快照 pending=[]
→ poll claimNext + spawnJob
→ stop 提前返回并关闭 DB
```

本轮改为追踪具体 `pollTask`，stop 先进入 draining、清除 interval、等待已经进入的 poll 返回，再冻结 pending 集合；poll 在 control sync 后再次检查 stopped。新增 delayed-claim 故障测试证明 stop 不会越过已经进入的 claim。

该修复关闭了明确竞态，但不能证明所有第三方 provider 都会响应 AbortSignal，也不能给无限阻塞 executor 提供 OS 级 hard deadline，因此 P0-ARCH-02 只收窄，不完全关闭。

### 4.6 workspace SSE 隔离

提交：`e32aa78e4780d4cfb4dceeed1cad9271764b153d`

涉及：

- [`packages/web/src/server/sse.ts`](../../packages/web/src/server/sse.ts)
- [`workspace-sse.test.ts`](../../packages/web/__tests__/api/workspace-sse.test.ts)

原 process-local 路径使用 repository-wide `subscribeAll`，没有验证 event.sessionId 是否属于订阅 workspace。本轮维护由持久 store 刷新的 workspace Session membership，只转发成员事件，并增加“foreign workspace 无 frame / local workspace 有 frame”的反例测试。

### 4.7 查询键切换时的旧计划污染

提交：`3d7f8c151efb66a864ad29311311f170eae7466c`

涉及：

- [`use-query.ts`](../../packages/web/src/client/hooks/use-query.ts)
- [`workspace-summary-stream.ts`](../../packages/web/src/client/lib/workspace-summary-stream.ts)

`useQuery` 原先在 key 从 workflow/codex 切到 goal/dsh 或认证域变化时，effect 执行前仍返回旧 key 的 data。高级表单可能短暂把旧计划展示在新 provider/mode 下。现在 state 与 key 绑定，key-changing render 同步屏蔽旧数据，新 key 无 cache 时返回空/loading 状态；异步回写同时检查 key 和 generation。

workspace summary client 类型也已与服务端轻量 catch-up frame 对齐，并丢弃 workspaceId 不匹配的数据。

---

## 5. 产品逻辑评审

### 5.1 Deliver 轨道：基本成立

当前受控交付路径已经具备相对明确的边界：

- 默认入口明确是完整 `standard-delivery`，不是轻量聊天；
- Goal 与 Workflow 不兼容组合由共享 policy 拒绝；
- dsh-headless 限制在一次性 Goal；
- 需求卡批准、计划批准、Gate、Artifact、交付准备和真实 PR 副作用均有控制点；
- run plan 开始进入默认和高级入口；
- dsh 不受限网络确认已经贯通 Web 与 CLI，并落审计。

因此，当前可以称为“实验性受控交付执行与观察基础设施”。

### 5.2 Collaborate 轨道：仍不存在

当前 Session 仍不能：

- 追加 durable user input；
- 在运行中 follow-up/steer；
- 消费真实 provider execution-time stream；
- 浏览器刷新或进程重启后恢复同一交互；
- 从轻量协作显式升级为 Deliver。

[`legacy-agent-driver.ts`](../../packages/core/src/runtime/legacy-agent-driver.ts) 的 `followUp`、`steer` 和 `resume` 仍未实现。Session UI 的“对话感”主要来自运行事件和产物投影，不等于协作会话。

### 5.3 run plan 仍不是权威启动合同

当前 `workflow.plan` 是读取模板后生成的预览，与实际启动之间没有 plan id/hash：

```text
GET/调用 plan
→ 用户查看
→ 模板、provider 配置或 repo 状态可能变化
→ project.run 再次独立解析与执行
```

后续应让 run plan 成为服务端生成的不可变输入摘要：至少记录 template digest、provider/model、permission/network、dirty-base、timeouts、artifact outputs、human gates 和关键成本因子，并在 run audit/provider snapshot 中保存实际采用版本。无需把 token 成本伪装成精确报价，但应展示影响因素。

---

## 6. UI / UX 评审

### 6.1 本轮有效改善

- 默认页面和高级页面均开始展示执行计划；
- dsh 风险告警和确认不再只存在于一个入口；
- 历史失败可以标记已处理，新失败重新置顶；
- 连接编辑不再静默切换认证状态；
- workspace 列表具备实时刷新通知；
- EventFeed 默认隐藏技术噪声并限制初始 DOM；
- 主路径核心控件的键盘、label 和 ARIA 明显改善。

### 6.2 高级启动页信息密度过高

StartRunForm 同时展示模式、模板、agent、profile、角色链、phase、所有 Gate、网络风险、timeouts 和 dirty workspace。它对专家有用，但普通用户难以形成“这次会做什么、哪里需要我确认”的快速心智模型。

建议采用两层：

```text
默认摘要：目标、角色链、预计控制点、权限/网络、需要人工确认
→ 展开技术详情：phase/node/gate key/毫秒 timeout/provider config
```

不要继续把更多底层字段直接平铺在主表单。

### 6.3 连接管理仍不是连接健康检查

当前状态只能诚实表达“凭据已设置”。后续若要显示“已连接”，必须有受控 server probe，并区分：

- 未设置；
- 已设置但未验证；
- 验证成功；
- 无效/过期；
- 服务不可达。

probe 不应在每次键入时触发，也不能泄露完整 token。

### 6.4 长 Session 仍会占用无限客户端内存

[`EventFeed.tsx`](../../packages/web/src/client/components/sessions/EventFeed.tsx) 只窗口化可见 DOM；[`use-session-stream.ts`](../../packages/web/src/client/hooks/use-session-stream.ts) 仍将所有 event 合并进一个不断增长的数组。服务端首次 replay 同样缺 cursor/limit。

真正闭环需要：

- 服务端 cursor/limit 和摘要 checkpoint；
- 客户端只保留活动窗口与少量索引；
- 用户主动加载更早历史；
- 大 payload spill/摘要；
- turn 导航或虚拟列表。

---

## 7. Runtime、Session 与数据架构

### 7.1 P0-ARCH-01：仍无单一 Runtime authority

Web 与 CLI 仍会分别创建 JobRunner，共享 SQLite、Git、worktree、`.tekon/runs`、Artifact、Audit 和子进程。Job owner/lease/CAS 只覆盖 jobs 表，不能 fence 所有文件与 Git 副作用。

推荐方向仍是：

```text
repo-scoped daemon / service
+ repo lock
+ CLI/Web 作为客户端
```

在此之前，不应继续增加新的独立 execution surface。

### 7.2 P0-ARCH-02：shutdown 主路径改善，但恢复语义未定

本轮修复后，已知 late-claim 竞态被关闭；正常响应 abort 的 executor 可在 DB 关闭前完成 finally/settle。

仍需决策：

- 服务关闭是否将正在运行的 job 标记 `cancelled`，还是持久化 `interrupted/recoverable` 并在重启后恢复；
- provider 不响应 abort 或子进程 kill 时，stop 的硬上限是什么；
- Git/文件写入如何证明已停止；
- listener/outbox/write queue 的 drain 顺序如何形成可测试 invariant。

### 7.3 P0-ARCH-03：Session Event 仍是观察投影

[`dual-write.ts`](../../packages/core/src/session/dual-write.ts) 明确 best-effort：原写成功后 event 追加失败不回滚，无 Session 时可静默跳过。因此它不能作为模型历史、durable inbox、完整 replay 或 fork/resume 的唯一事实源。

应明确二选一：

1. Session log 升级为权威写路径，旧表成为 projection；或
2. 保持治理数据库为权威源，并诚实地把 session_events 定义为可重建/可丢失观察投影。

当前代码和文档仍处于中间态。

### 7.4 P1-DATA-01：引用完整性仍未关闭

`session_events.session_id`、`jobs.session_id`、`projection_checkpoints.session_id` 无外键，appendEvent 也不验证 Session 存在。增加 `acknowledged_at` 不改变这一事实。

应以独立 migration PR 处理：

- 扫描并分类孤儿数据；
- 决定删除、隔离或补建父记录；
- SQLite 表重建；
- 老库升级/回滚测试；
- 开启和验证 foreign_keys；
- 明确删除 Session 时的 cascade/restrict 策略。

---

## 8. 代码实现与维护性

### 8.1 正向评价

- run-mode policy 复用良好；
- 用户为 shutdown、SSE、ack、计划和 a11y 增加了真实测试，而不是只改 UI；
- 本轮补充的 delayed-claim 与 cross-workspace negative case 能验证关键竞态/隔离；
- `0.17.0` 是用户可见功能版本，不是为评审文档空 bump；
- 用户停止继续扩写 CHANGELOG 的方向正确。

### 8.2 JobRunner 已接近需要拆分的复杂度

`job-runner.ts` 同时管理：poll、claim、owner fencing、generation token、heartbeat、pause/cancel、subprocess kill、stale recovery 和 shutdown。继续在一个闭包中增加分支会使 invariant 越来越难审阅。

后续应按生命周期拆为：

- claim/poll coordinator；
- execution lease/fencing handle；
- control relay；
- shutdown/drain coordinator。

先建立状态转移和 ownership invariant 测试，再拆文件，避免只为“代码更短”而重构。

### 8.3 Session get 为读取 acknowledgement 扫描 workspace

因为冻结的 Session contract 不含 `acknowledgedAt`，当前 `session.get` 通过 `listSessions(workspaceId)` 找当前行。功能正确，但随 workspace 增长会不必要地读取整表。

建议增加 `getSessionSummary(id)` / `getSessionListEntry(id)`，或在下一次正式 contract migration 中把人类处理状态纳入权威 projection。

### 8.4 查询缓存应继续补 key-switch 回归测试

本轮已修复旧 key 数据污染，但当前 Web 单测环境没有完整 DOM hook 测试。后续应增加最小 React 测试环境，锁定：

- key A 有数据 → 切 key B 未缓存时不能返回 A；
-旧认证域 promise 不能写入新域；
- invalidate/refetch 不产生重复并发回写。

---

## 9. DeepSeek Harness 最新对齐

### 9.1 当前官方事实

截至 2026-08-30，官方 GitHub 最新 prerelease 是 [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)，发布于 2026-08-27。Tekon 仍钉死 `0.1.1-rc.2`，严格 fail-closed 本身正确，但版本与 contract fixture 已明显落后。

官方现已提供：

- [`sdk/`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk)：stdio JSON-RPC，客户端可打开 Session、发送 prompt，并实时观察 Session event、Agent 状态和 subagent completion；
- [`dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)：标准 ACP v1，支持持久 Session 的 new/list/resume/close、prompt/cancel、权限请求和语义执行更新，并明确要求 quiescent close；
- one-shot headless：仍适合脚本/CI/Goal，不适合持续协作。

官方 [`SAFETY.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 同时明确：项目仍是 developer preview、未经安全审计，sandbox/approval/permission 不能保证隔离，不能作为不可信任务的唯一安全控制。

### 9.2 对 Tekon 的建议

- **保留 headless 作为 experimental Goal provider**，不要继续为它模拟 follow-up/streaming；
- **为 Collaborate vertical slice 优先评估 SDK**：它与 Tekon 自有 Session/Event 模型更直接，能保留较完整实时语义；
- **ACP 作为标准互操作候选**：当目标是编辑器/第三方控制器兼容时更合适，但它主动舍弃 DSH 私有展示数据；
- 先写一份 SDK vs ACP ADR，再实现一个真实 provider 的最小纵向切片；
- 新版本升级前重新验证 version/help/profile/config/stdout/stderr/cancel/permission fixture；
- 增加 `tekon provider preflight dsh-headless` 和精确兼容安装命令；
- 对不受限网络继续要求 OS/container 级隔离建议，不能只依赖确认框。

---

## 10. 过度实现与过度设计

### 10.1 横向抽象仍领先于纵向闭环

现有 Profile、Automation、Goal、LegacyAgentDriver、dual-write、DSH probe、两套 Runtime composition 和多层 review/eval 已经不少，但最核心的协作链仍未完成：

```text
真实流 → durable input → follow-up/steer → restart resume → Deliver 升级
```

下一阶段应冻结不直接服务该 vertical slice 的新 profile、automation kind 和 provider 抽象。

### 10.2 评审文档流程已经过度工程化

第五轮报告在声明“不再堆叠过程”之后又追加大段代理批注和整改回填，使“哪一段才是当前裁决”再次模糊。

本轮规则：

- `current.md`：稳定入口；
- 第六轮报告：当前详细结论；
- 旧报告：只读历史；
- CHANGELOG：只记录用户可见行为；
- 后续小修：更新当前报告的 revision log，除非产品/架构基线确实发生新一轮变化。

---

## 11. 测试与证据评审

现有测试强度高于多数同阶段实验项目，本轮新增测试也具有实际价值。当前自动化覆盖：

- Root build/typecheck；
- Core unit/e2e；
- CLI unit/e2e；
- Web build/typecheck/unit；
- Chromium Playwright；
- Actions workflow lint。

仍缺：

1. 真实 DSH 新版本 contract/preflight；
2. SDK/ACP 真实 Session streaming；
3. 多进程同时 claim、shutdown、Git/Artifact late write 故障注入；
4. provider 忽略 abort / 子进程拒绝退出；
5. 10k/100k Event 的服务端 replay、浏览器内存和虚拟化基准；
6. 浏览器刷新与服务重启恢复；
7. 屏幕阅读器和多浏览器；
8. 老数据库孤儿数据 migration。

CI 通过只能说明已编码合同没有回归，不能替代这些产品和故障边界。

---

## 12. 推荐实施顺序

### A. Runtime authority 与 shutdown/recovery

1. repo-scoped single-owner daemon + lock；
2. CLI/Web 客户端化；
3. 明确 shutdown 时 cancel / interrupt / recover 的持久状态；
4. provider/subprocess hard deadline 与 Git/文件写入 drain；
5. 多进程/kill/restart/late-write 故障矩阵。

### B. 权威 Session 与 durable inbox

1. 决定 authoritative source；
2. durable user input、claim 和 idempotency；
3. 模型可见输入全部可由 log 重建；
4. dual-write 迁移和校验；
5. Session 子表外键与孤儿 migration。

### C. 一个真实 Collaborate vertical slice

1. SDK vs ACP ADR；
2. 一个真实 provider 的 execution-time stream；
3. follow-up、steer、cancel；
4. resume 与 restart recovery；
5. 浏览器 E2E。

### D. 权威 run plan 与 Deliver 升级

1. plan digest / snapshot；
2. provider/model/permission/network/timeouts/artifacts/human gates；
3. actual adopted plan 写入 Audit；
4. Collaborate → Deliver 明确升级；
5. 复用现有 Gate/Artifact/Delivery，不再平行造一套。

### E. Scale 与产品收敛

1. Session summary projection + cursor；
2. 服务端分页、客户端窗口、虚拟化和摘要；
3. ack/unread/changedSinceSeen/archive；
4. connection validation；
5. 全站可访问性；
6. 清理重复报告和失效手册。

---

## 13. 验收结论

### 代码 / PR 合并门

- [x] 用户 `ca30e8c` 是有效产品增量，Core #284 / CI #193 通过；
- [x] CLI/Web dsh 网络确认已统一，并有审计和测试；
- [x] 默认 Session 主入口已有执行计划摘要；
- [x] 失败确认 list/get/新失败语义已统一；
- [x] 连接编辑为显式应用；
- [x] stop/poll 竞态有确定性测试；
- [x] workspace SSE 跨 workspace 隔离有反例测试；
- [x] 查询键切换不再展示旧计划/旧认证域数据；
- [x] 未发现本轮修复引入的已知阻断回归。

### 产品验收门

- [x] 受控交付入口、Goal/Workflow/provider 边界基本成立；
- [x] dsh 不受限网络在当前 Web/CLI 启动入口需要明确确认；
- [x] Session 列表可实时刷新并处理历史失败；
- [ ] 同一 Session 可持续输入、follow-up、steer 并重启恢复；
- [ ] Provider 输出为执行期真实流；
- [ ] Collaborate 与 Deliver 是清晰、可升级的两条产品轨道；
- [ ] 一个 repo 只有一个 Runtime authority，或所有副作用均有完整 fencing；
- [ ] shutdown 对不合作 executor/provider 也有有界、可恢复语义；
- [ ] Session Event 是权威事实链与 durable inbox；
- [ ] run plan 是与实际运行绑定的权威快照；
- [ ] 长 Session 的服务端数据、网络、浏览器内存和 DOM 全部有界；
- [ ] DSH SDK/ACP、版本、preflight、安装和安全边界形成稳定合同；
- [ ] Session 数据引用完整性迁移完成；
- [ ] 全站可访问性和真实用户试用通过。

# 最终裁决

**本 PR 最新代码可以继续合并审阅，但不能据此宣称 Tekon 已通过面向普通人的稳定持续协作研发工作台验收。**

允许的成熟度表述：

> Tekon v0.17.0 已形成测试较强、启动与风险边界更透明的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、权威 Session 事实链和全链路长会话有界化。

本 PR 的合并不得被解释为上述 P0/P1 自动关闭，也不应继续在同一 PR 中扩展新的横向平台能力。
