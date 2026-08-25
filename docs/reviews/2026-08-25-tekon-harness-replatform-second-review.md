# Tekon Harness Replatform 第二轮全面复审

> 复审日期：2026-08-25
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`
> 复审基线：Agent 修改后的 PR head `75382739c2adb11219c61594111e8f43767a5f72`，以及本轮审查修复提交。
> 复审维度：产品逻辑、UI 信息架构、UX 交互、运行时与数据架构、代码正确性、安全边界、测试与交付可信度。
> 证据范围：全量 PR diff、关键实现与测试、GitHub Actions、DeepSeek Harness 官方 README/architecture/headless 文档。当前执行环境不能拉取仓库并启动浏览器，因此 UI 部分是代码与 Playwright 用例审查，不冒充独立截图或人工视觉走查。

## 1. 结论

### 1.1 最终判断

**本轮仍不能判定“通过”。**

但结论已经与第一轮明显不同：PR #10 不再只是迁移设想，而是完成了一个有实质价值的 Harness-inspired replatform 骨架：

- `Workspace / Session / SessionEvent / Job` 数据模型已经落地；
- Web `project.run` 已从长 HTTP 请求改为准备 + 后台 Job；
- SSE replay、断线游标和 Session-first 路由已经落地；
- CLI、Web、Playwright 已进入持续集成；
- Demand Shape 审批链、后台恢复、provider registry、profile、goal、自动 prepare/readiness、DSH bridge 均有实现和测试；
- 旧 Cockpit 保留在 `/advanced`，默认入口切换到 Session。

这意味着 **阶段 0/1 的方向基本成立，底层工程质量也有明显进步**。然而，“普通人可用的连续 Agent 工作台”仍没有完成，当前 Session UI 主要是旧 Workflow 的事件投影，而不是可持续对话、可转向、可解释的 Agent Loop。

因此本报告给出两层判断：

| 验收对象                                                                | 结论                                 |
| ----------------------------------------------------------------------- | ------------------------------------ |
| Phase 0/1：契约、事件脊柱、后台 Job、基础恢复                           | **有条件通过**；本轮修复后可继续迭代 |
| Phase 2–5 当前实现：流式 Agent、Human-first UI、Profile/Goal/DSH 互操作 | **不通过**；仍有产品与架构阻断项     |
| 作为普通用户可发布产品                                                  | **不通过**                           |
| 作为 Agent 自举/治理底盘的实验分支                                      | **可继续使用**                       |

### 1.2 更新评分

| 维度               | 第一轮 | 本轮 | 说明                                                                    |
| ------------------ | -----: | ---: | ----------------------------------------------------------------------- |
| Agent 自动执行底盘 |    7.5 |  8.0 | 原有 Workflow/Gate/Artifact/Worktree 保持稳定                           |
| 后台任务与恢复     |    2.5 |  7.0 | Durable Job、lease、checkpoint、cancel chain 已落地；本轮补跨进程 relay |
| 事件与可回放性     |    1.5 |  6.5 | typed event + SSE 已有；仍是 best-effort projection，不是唯一事实源     |
| 人类输入体验       |    2.0 |  4.5 | Session-first + composer，但仍默认启动完整交付 Workflow                 |
| 过程可见性         |    1.5 |  5.0 | 有连续 feed；主要输出仍为 node 级合成摘要，非主流 provider 原文流       |
| 人类干预能力       |    2.0 |  3.5 | pause/cancel/inline approval 改善；follow-up/steer 未接通               |
| 输出可读性         |    2.0 |  4.5 | 默认入口改善；事件仍偏内部模型，本轮降低部分 ID/seq 噪音                |
| 架构扩展性         |    4.0 |  7.0 | provider registry、profile、job executor routing、event contract 已建立 |
| 测试与交付可信度   |    3.0 |  8.0 | Core/CLI/Web/Playwright 全部进入 CI，显著改善                           |
| 普通用户发布信心   |    3.0 |  4.5 | 基础设施提升，但连续协作与安全 onboarding 仍缺失                        |

## 2. 已验证的实质进步

### 2.1 长 HTTP RPC 已被拆成 prepare + enqueue

`SessionService.startRun()` 先调用 `engine.prepareRun()`，再创建 Session、写入事件、enqueue Job；Web 请求可以毫秒级返回 `runId/sessionId/jobId`，后台 Runner 接管执行。这修复了第一轮最重要的产品/架构错误。

保留意见：这组写入目前不是一个原子事务，详见 P1-03。

### 2.2 Session/Event/Job 契约已经形成

当前实现具备：

- append-only `session_events`；
- per-session seq；
- replay cursor；
- `jobs` owner/lease/abort/checkpoint；
- stale recovery；
- workflow/job/session 状态映射；
- projection/event presentation；
- SSE reconnect。

这套骨架与 DeepSeek Harness 的 Session/Event/Agent live-control 分层在方向上是一致的。

### 2.3 默认产品入口已从 Cockpit 转为 Session

`/` 现在是 Sessions，旧 Runs/Approvals/Delivery/Config/Eval 放在 `/advanced`。这符合“人类先看任务叙事、治理对象退到 Inspector”的原则。

本轮进一步把默认 Sidebar 只保留 Session/Advanced，减少内部实体导航对新用户的干扰；原有高级能力没有删除。

### 2.4 CI 已补齐人类可用性表面

PR 当前 CI 覆盖：

- Root typecheck/lint；
- Core build/unit/e2e；
- CLI build/unit/e2e；
- Web build/typecheck/unit；
- Playwright 浏览器流程。

这是第一轮报告中的核心缺口之一，目前已实质修复。

### 2.5 DSH bridge 的边界总体诚实

实现明确：

- pin `@deepseek-ai/dsh` 版本；
- 固定 `--profile headless`；
- 拒绝用户覆盖 profile/patch/dump 等 launcher 控制面；
- 独立 `DSH_HOME`；
- 明确 DSH 网络无法被 Tekon 证明隔离，要求显式 acknowledgment；
- 明确 headless 是单任务、无 follow-up 的 goal-only 边界。

本轮补充读取官方 headless stdout 的最终 assistant 文本，使 DSH Session 不再只显示“产出 N 个 artifact”的合成句子。

## 3. 本轮发现并已修复的问题

### F-01 跨进程 pause/cancel 只写数据库，Web owner 不会 relay

**严重级别：High**

原实现允许一个 CLI Runner 修改另一个 Web Runner 所持 Job 的 `paused/cancelling` 状态，但 Web owner 没有观察控制行的循环。另一个进程无法触碰 owner 进程内的 `AbortController`、pause flag 和 subprocess registry。

本轮修复：

- owner poll 每轮同步自己持有 Job 的 durable control state；
- foreign pause 转成本地 pause flag；
- foreign cancel 转成本地 AbortSignal + `registry.killAll()`；
- owner 变化时使用独立 abort reason，避免误判成用户取消；
- 同一 worker 重领同一 job 时使用 execution-generation token fence zombie；
- 增加双 Runner 与 crash-resume 回归验证。

### F-02 cancelling 与 executor done 竞态会把 Job 写回 done

**严重级别：High**

原 `settle()` 只检查 owner，不检查当前 `cancelling/abortState`。外部取消落库后，executor 若先返回 `done`，可覆盖取消状态。

本轮修复：cancel request、propagated state 或 aborted controller 均强制 settle 为 `cancelled`，并用回归测试故意让 executor 在取消后返回 done。

### F-03 CLI `pause` 可把 passed/failed/cancelled Run 复活为 paused

**严重级别：High**

`commandPause()` 在 SessionService 返回 illegal transition 后保留了“legacy direct DB fallback”，会直接改 Node 和 Workflow 状态。这破坏终态单调性，并允许后续 cancel 把一个已 passed 的 Run 改成 cancelled。

本轮修复：终态统一抛 `WorkflowTerminalError`，其他非法状态也失败，不再直接写库；CLI unit/e2e 同步更新。

### F-04 非终态 Workflow 返回被映射为成功 Job

**严重级别：High**

`settleByWorkflowStatus()` 的 default 分支把 `running/pending` 等契约异常映射成 `job=done, session=idle`。这是明确的 fake pass。

本轮修复：记录 `agent/error`，Session 与 Job 均失败，turn/end 标记 failed。

### F-05 Session seq 只受进程内 WriteQueue 保护

**严重级别：High**

旧实现是 `SELECT max(seq) + INSERT`。CLI 与 Web 使用不同连接和不同 WriteQueue 时可能同时分配同一 seq。

本轮修复：使用 SQLite `BEGIN IMMEDIATE` 将序号读取和插入变成跨连接写临界区，并增加双连接回归测试。

### F-06 SSE live 只依赖 process-local EventBus

**严重级别：High**

连接建立后，CLI 写入同一个 SQLite 的事件不会进入 Web 进程的 EventEmitter，浏览器只能重连后看到。

本轮修复：

- local bus 继续提供低延迟；
- SSE 同时按 durable cursor 周期 catch-up SQLite；
- 用 contiguous seq buffer 处理“本地事件先看到、外部较低 seq 后读到”的顺序问题；
- replay/live/DB 三路统一去重；
- 新增“不 publish bus 仍能推送”的测试。

### F-07 DSH 官方最终输出被丢弃

**严重级别：Medium**

官方 headless 契约把最终 assistant text 写到 stdout，旧 adapter 只返回 stdout 文件路径，Session 仍显示合成摘要。

本轮修复：对 stdout 做长度限制和 secret redaction，填入 `AgentRunResult.assistantText`；step bridge 优先展示真实 final text，并通过 `synthetic` 标记区分。

### F-08 durable prompt/error 事件存储未先脱敏

**严重级别：Medium**

Presentation 层脱敏不能替代写入前脱敏。旧 step event 会把 prompt summary 和 adapter throw message 原样写入 Session DB。

本轮修复：step bridge 在摘要和错误写入前调用 core secret redaction。

### F-09 默认 Session UI 仍暴露过多调试信息

**严重级别：Medium**

原默认界面显示 workspace ID、完整 run ID、event seq、`turn @seq`，并把普通对话文本放在代码块里。

本轮修复：

- 默认 Sidebar 隐藏全部 Cockpit 分组，仅 Advanced 模式展开；
- workspace 显示“当前项目”；
- Run ID 从主列表/标题叙事移到 tooltip/路由；
- prose 用普通可换行文本展示；
- event seq 和 turn event seq 不再作为主视觉信息。

## 4. 仍然阻断“通过”的问题

### P0-01 主流 Provider 仍是 node 级黑盒，不是流式 Agent Loop

Codex/Claude/Mock 的核心接口仍是：

```ts
runAgent(input): Promise<AgentRunResult>
```

当前 `step/start → tool/call → tool/result → assistant/message` 是包在一次完整 node 执行外面的合成序列，并不代表真实模型 step/tool 生命周期。除 DSH final stdout 外，没有 assistant chunk、真实 tool call/result 或 request boundary。

影响：

- 用户看不到 Agent 实际正在做什么；
- 不能在一步中途 steer；
- tool card 无法还原真实命令与结果；
- “实时”主要是治理事件实时，不是模型输出实时。

验收要求：至少让一个主力 provider（Codex 或 Claude）实现真实增量事件，再把该协议推广到 registry。

### P0-02 Session Detail 没有 follow-up / steer composer

`AgentDriver.followUp()`、`steer()`、`resume()` 仍为 NotSupported；Session Composer 只负责创建新 Run。用户进入 Session 后不能继续提问、补充约束或纠正方向。

这意味着当前产品仍是“用 Session 看一次 Workflow”，不是“在 Session 中与 Agent 持续协作”。

验收要求：

- Session Detail 底部固定 composer；
- follow-up 进入 inbox；
- steer 明确作用于当前/下一 step；
- durable `user/message` / `agent/steered`；
- 重连后可恢复 pending input。

### P0-03 默认新 Session 仍启动完整 standard-delivery

UI 中的“开始会话”实际调用 `project.run` 的 workflow 模式，普通一句任务会进入 PM/RD/QA/Reviewer 全链路。Session 名称变了，底层用户心智仍然要求理解受控交付流程。

建议：默认提供两种清晰入口：

1. **协作任务**：轻量 Agent Session，适合解释、探索、小改动；
2. **受控交付**：完整 Workflow/Gate/PR 流程。

不要让用户通过模板下拉框猜测这两种产品模式。

### P0-04 Goal 模式可改代码却默认无 Gate/Artifact

`workflows/goal.yaml` 是单 Node、无 output、无 gate。虽然不允许 Delivery，但 Agent 可在 worktree 产生代码并最终 promoted 到 run branch，而没有 build/lint/diff review。

建议至少满足其一：

- goal 默认 read-only；
- 检测到代码变化时自动注入 diff/build/lint/human review；
- 明确区分 `research-goal` 与 `change-goal`。

### P1-01 Event Spine 仍是 best-effort projection，不是事实源

多个 `emit()/dual-write` 路径 catch 并吞掉事件存储失败，legacy workflow/jobs tables 才是 source of truth。Session log 可以永久缺事件，无法保证完整 replay。

这在迁移期可以接受，但文档不能把当前实现描述成 Harness 式 canonical log。

建议分阶段提升：

- 先把 user input、assistant output、tool result、approval 设为必须写入；
- 用 outbox/transactional event append 连接 legacy state write；
- projection 从 log 重建并做 invariant test；
- 最后再把 audit/hash 投影迁移过来。

### P1-02 Automation listeners 仍依赖 process-local bus

本轮修复了 SSE 的 DB catch-up，但 auto-prepare/readiness listener 仍只订阅本进程 EventBus。CLI 完成的 Run 不一定触发另一个 Web 进程中的 automation。

建议把 automation 变成 durable projection worker：

- 从 `projection_checkpoints` 读取 cursor；
- 扫描 DB event log；
- idempotent enqueue automation job；
- checkpoint 与 enqueue 使用事务/outbox。

### P1-03 StartRun 不是原子创建

当前顺序为：prepare legacy run → audit hook → workspace/session → 三个 event → job enqueue。任一步失败都可能留下：

- 有 Run、无 Session；
- 有 Session、无 opening events；
- 有 Session、无 Job；
- 用户重试后生成第二个 Run。

建议提供一个 repository-level transaction：一次写入 run/session/opening events/job，外部副作用只在 commit 后开始。

### P1-04 `tekon ui` 仍要求用户手工复制 Session token

CLI 已读取 `.tekon/web-session.json`，但没有完成浏览器安全 handoff，也没有自动打开页面。默认入口会直接发起需要 token 的 read，用户先看到错误，再去寻找 token 输入框。

不要恢复 query-string token。建议使用：

- loopback-only one-time bootstrap nonce；
- 同源 `/api/bootstrap`，仅本地、一次性、短 TTL；
- 浏览器拿到 token 后只保存在内存并立即销毁 nonce；
- SSH 模式只打印明确的手动步骤。

### P1-05 Delivery approval 没有绑定具体内容身份

自动 re-prepare 对 failed delivery 保留 `approvedBy/approvedAt`。如果 branch HEAD、PR body 或 evidence package 已变化，旧批准仍可复用。

建议审批对象包含：

```text
branch + headSha + baseSha + prBodySha + packageSha
```

任一变化都使 approval 失效。

### P1-06 Workspace 仍只是单项目占位符

UI 显示“当前项目”，但没有 workspace 切换、添加、移除和最近项目。作为第一阶段占位合理，但不能把它算作 Workspace 产品能力完成。

### P1-07 长 Session 没有虚拟化、折叠与查询

`useSessionStream` 将所有事件持续累积在内存，Feed 全量渲染。长程研发任务很容易有数千事件。

建议：

- windowed/virtualized list；
- step/tool 默认折叠；
- 按类型/状态过滤；
- 搜索；
- server pagination + SSE tail；
- spill 内容按需加载。

## 5. 产品逻辑评估

### 5.1 当前真正适合的使用场景

- Agent 自举；
- 固定交付模板；
- 有明确 Artifact/Gate 的代码任务；
- 需要审计、审批和 PR 证据的长程任务；
- 开发者愿意进入 Advanced Cockpit 排障。

### 5.2 当前不适合的使用场景

- 用户边看边问、边做边改目标；
- 探索性需求；
- 需要连续解释和方案比较的任务；
- 非工程用户；
- 不理解 Workflow/Role/Gate 的个人用户；
- 希望像 Codex/Claude Code 一样直接看到模型与工具过程的用户。

### 5.3 建议的产品双轨

```text
Tekon Workspace
├─ Collaborate（默认）
│  ├─ Session / message / plan / tool / changes
│  ├─ 可 follow-up / steer / approve
│  └─ 按风险动态升级治理
└─ Deliver（高级）
   ├─ Demand Shape
   ├─ Workflow / Role / Gate / Artifact
   ├─ Readiness / Delivery / CI
   └─ PR 受控交付
```

Advanced 不只是隐藏旧页面，而应成为明确的 Deliver/Operations 模式。

## 6. UI 与 UX 评估

### 6.1 做对的部分

- 默认 Session-first；
- continuous feed；
- SSE 状态可见；
- inline approval；
- right rail 汇总 Gate/Artifact/Result；
- legacy Cockpit 未被破坏；
- Playwright 覆盖 Session list/feed/approval/routing。

### 6.2 仍需重做的关键交互

1. **首次启动**：安全自动鉴权，而不是先报错再手输 token；
2. **新任务**：先选择“协作”或“受控交付”，不要先暴露模板/provider/毫秒超时；
3. **运行中**：底部输入、停止、暂停、转向必须始终可见；
4. **输出**：模型正文优先，工具和治理事件折叠；
5. **失败**：用“发生了什么 / 已保存什么 / 现在能做什么”表达，不只显示状态枚举；
6. **完成**：一个 Final Result 汇总变化、验证、风险、未完成项和下一动作；
7. **高级信息**：runId/nodeId/gateKey/seq 放 Debug Inspector，不占主叙事。

### 6.3 可访问性与视觉验证限制

本轮确认了语义元素、按钮名称和部分 keyboard/Playwright 路径，但没有独立启动页面并截图，因此不能声称：

- 颜色对比通过 WCAG；
- focus order 完整；
- 响应式布局无溢出；
- 长文本/大表格在真实浏览器中可读；
- screen reader announcement 完整；
- loading/reconnect 动画不会造成干扰。

下一轮应把真实浏览器截图、键盘遍历、axe 检查纳入 PR 验收，而不是只依赖 DOM 断言。

## 7. 架构评估

### 7.1 推荐继续保留的核心资产

- Workflow Engine；
- Gate registry；
- Artifact Store；
- Worktree/Command Gateway；
- Human approval；
- Audit Hash Chain；
- Delivery/Readiness；
- Provider registry；
- Session/Job/Event contracts。

### 7.2 下一步必须收敛的边界

| 边界          | 当前                   | 目标                                        |
| ------------- | ---------------------- | ------------------------------------------- |
| Agent runtime | node Promise 黑盒      | turn/step/chunk/tool event driver           |
| Session event | best-effort dual-write | canonical log + transactional outbox        |
| Job control   | DB + process relay     | durable command mailbox + fencing token     |
| Automation    | local EventEmitter     | checkpointed durable projector              |
| Product mode  | template/provider 参数 | Collaborate vs Deliver                      |
| Goal          | 无治理自由执行         | read-only 或变更触发治理                    |
| Approval      | 状态字段               | 绑定内容哈希的 capability                   |
| DSH           | pinned headless bridge | anti-corruption adapter，持续 contract test |

### 7.3 不建议的做法

- 不要把 Tekon DB 直接替换成 DSH 私有 schema；
- 不要直接依赖 DSH 内部 packages 作为稳定 API；
- 不要为了“像 Harness”把现有 Gate/Artifact/Delivery 删除；
- 不要继续给 synthetic event 起“真实 streaming”名称；
- 不要在完成 Agent Loop 前继续扩展更多 profile/bundle 表面。

## 8. DeepSeek Harness 官方对照

复审时官方信息显示：

- Harness 仍处于 developer preview，明确允许 breaking changes；
- 核心是 plugin tree、typed durable session event 与 live agent events；
- headless profile 是一个 fresh persisted agent + one submitted task；
- headless 成功时把最终非空 assistant text 写到 stdout；
- headless 不提供 follow-up。

因此当前 Tekon 的 DSH bridge 适合做 **受控 one-shot goal provider**，不适合作为 Human-first Session 的完整后端。真正的连续协作仍必须由 Tekon 自己的 AgentDriver/Session inbox 抽象承担。

## 9. 测试与质量门槛

### 9.1 本轮修复应通过

- Core job-runner cross-owner pause/cancel；
- cancellation settle race；
- dual-connection session seq；
- DSH assistant stdout；
- step-event synthetic/real distinction；
- Web SSE cross-process DB catch-up；
- CLI terminal pause；
- root typecheck；
- 原 PR 全量 CI。

### 9.2 合并前还需要的产品验收

- 真实 Codex/Claude provider 的至少一条 streaming smoke；
- Session follow-up/steer E2E；
- Web 启动安全 bootstrap E2E；
- Goal 代码变更治理 E2E；
- CLI 完成 → Web 已连接 Session 实时看到 automation/result；
- server crash/restart → Job recovery + SSE replay；
- 1,000+ event Session 性能测试；
- axe + keyboard + responsive screenshot audit。

## 10. 推荐路线

### 下一里程碑 A：真正可协作的单 Session

只做一条窄闭环：

```text
输入任务
→ assistant 增量输出
→ 真实 tool call/result
→ 用户 follow-up/steer
→ diff + validation
→ final result
```

先支持一个主力 provider；不要同时扩所有 provider。

### 下一里程碑 B：治理动态升级

- 默认 collaborate；
- 发生文件写入时增加 changes inspector；
- 高风险工具触发 approval；
- 检测到代码变化自动 build/test；
- 用户选择 Deliver 时再进入完整 Workflow。

### 下一里程碑 C：Event Spine canonicalization

- transactional outbox；
- durable projector；
- session/event invariants；
- legacy table projection；
- 最后移除 best-effort dual-write。

## 11. 合并建议

**不建议按“完整 Harness 迁移已完成”合并。**

可选方案：

1. 将 PR 明确改名为“Event Spine / Durable Job / Session UI foundation”，以基础设施里程碑合并；或
2. 保持 PR 开放，继续完成 P0-01～P0-04。

若按方案 1 合并，必须在 README/CHANGELOG 中明确：

- Session feed 尚非完整模型 streaming；
- follow-up/steer 未开放；
- Goal 变更能力为实验性；
- DSH headless 是 one-shot provider；
- Event log 仍是迁移期 projection。

本轮结论：**基础设施阶段有条件通过，产品整体不通过。**

---

## 附：实施方批注（2026-08-25）

> 本节由实施方在收到本报告后追加。评估方法：两个最高思考等级 subagent 独立核验（其一验证报告 §3 F-01~F-09 修复是否真实落地、是否引入回归；其二对 §4 P0-01~P0-04 与 P1-01~P1-07 逐条做事实核验 + 本轮取舍），再由我逐条查证代码交叉复核。合并策略采纳报告 §11 **方案 1**（以「Event Spine / Durable Job / Session UI foundation」基础设施里程碑合并 + 诚实披露局限）——该方案**不要求**完成 P0-01~P0-04 产品里程碑。

### 与报告的一致与分歧

**高度一致**：报告 §3 的 F-01~F-09 修复经独立验证整体真实、可保留（F-02/F-03/F-06/F-07/F-09 为完整真修复；F-04/F-05/F-08 代码正确但回归测试偏弱）；§4 绝大多数 P0/P1 的**技术描述属实**；§11 方案 1 的披露清单当前满足度约 90%。本轮据此采纳方案 1。

**一处分歧（P0-04 描述与代码相反）**：报告称 goal 模式「可改代码却默认无 Gate/Artifact……promoted 到 run branch 而无 review」。核验代码后判定**不成立**：`workflows/goal.yaml` 无 outputs → `nodeAllowsSourceChanges=false`（`lease-service.ts:168-174`）→ `finalizeExecutionLease`（`lease-service.ts:108-123`）在 promote **之前**调用 `inspectLeaseSourceChanges`，检出任何非 `.tekon` 源码改动（dirty 或 committed，`worktree-manager.ts:244-291`）即 `throw "not allowed to modify repository source files"`，`promoteLeaseToRunBranch` 不可达；该守卫早于本 PR 且有单测（`lease-service.test.ts`）。即当前行为**已是 fail-closed**，等效于报告建议的「goal 默认 read-only」。故 P0-04 无需改代码。

**一处降级（P1-05 非安全漏洞）**：报告将「delivery approval 未绑定内容身份」列为可复用过期审批的风险。机制属实（`scm.ts:707-712`、`automation-job-executor.ts:85-91` 保留旧 `approvedBy/approvedAt`），但**无任何代码路径消费 persisted approval 来绕过 fresh 人工确认**：create-pr 副作用在 CLI（`delivery.ts` 需 `--approve-human`）与 Web（`delivery.ts` 需 `approveHuman===true`，且每次点击弹确认）都要求当次人工动作。真实影响是**审计可信度 + eval metric 误报**（`work-usability.ts:477` 可能把 stale approval 当 current），非权限提升。因此从「安全阻断」降级为「可信度硬化」。

### 逐条处置（本轮 / 递延）

| ID | 报告严重级 | 事实核验 | 本轮处置 | 依据 |
| --- | --- | --- | --- | --- |
| **F-01 残留** | （验证方新检出 High） | **属实** | **本轮必修** | F-01 把 node-executor ownership-lost 分支的 fail-safe `writeWorkflowTerminal` 换成无守卫 `updateWorkflowInstanceStatus('interrupted')`（`node-executor.ts:220/291/322`）+ 无守卫 `transitionNode('interrupted')`。被 fence 的 zombie worker 可把新 owner 已写的终态 `passed` 回退成 `interrupted`，破坏终态单调性。 |
| P0-01 真流式 Agent Loop | 阻断 | 属实 | **递延**（里程碑 A） | `runAgent(): Promise<AgentRunResult>` 一次性黑盒；但 manual `:1026/:1061` 已诚实标注「合成摘要非模型原文」「逐块流式为后续规划」，无虚假宣称。 |
| P0-02 follow-up/steer composer | 阻断 | 属实 | **递延**（里程碑 A） | `legacy-agent-driver.ts` follow-up/steer/resume 抛 NotSupported；SessionComposer 已提示「转向在 2b 提供」。 |
| P0-03 默认启动 standard-delivery | 阻断 | 属实 | **递延 + 补披露** | 双轨（Collaborate/Deliver）是里程碑 B。本轮仅在 manual 加一句「默认发起=受控交付全链路」。 |
| P0-04 goal 无治理改代码 | 阻断 | **不成立** | **无需改代码** | fail-closed 守卫已存在且有单测（见上）。可选：`roles/goal/system.md` 提示词微调，避免诱导 agent 改码致 run 失败。 |
| P1-01 event log 非事实源 | — | 属实 | **递延 + 补披露** | canonicalization 是里程碑 C。文档未称其 canonical；本轮补一句「event log 是迁移期 best-effort projection，旧表仍是事实源」。 |
| P1-02 automation 进程内 bus | — | 属实 | **递延**（里程碑 C） | auto-prepare 边界已在 manual `:1054` 披露；不产生假成功（绝不建 PR）。 |
| P1-03 startRun 非原子 | — | 属实 | **递延** | 失败留可检测 partial state，非回归；无 idempotency 为 pre-existing 模式。 |
| P1-04 tekon ui 手工 token | — | 属实 | **递延** | bootstrap nonce 是新 UX 机制；token 流程已文档化。 |
| P1-05 approval 未绑内容身份 | — | 属实但影响被高估 | **披露 + 递延硬化** | 非安全洞（见上）。完整内容指纹绑定需 schema 迁移 + body 内容哈希，触及治理敏感的交付审批路径，与本 PR 里程碑不相称，且 reviewer 判为可选非阻塞。本轮仅在 CHANGELOG/manual 披露「审批记录尚未绑定内容指纹，重新准备后旧审批标记会保留」，硬化留待交付治理里程碑。 |
| P1-06 workspace 单占位 | — | 属实 | **递延** | `CHANGELOG.md:148` 已诚实披露为只读占位。 |
| P1-07 长 Session 无虚拟化 | — | 属实 | **递延** | 前端性能工程，非回归；典型 run 事件量可控。 |

### 本轮实际交付范围（据上表收敛）

1. **必修**：node-executor ownership-lost 无守卫写入回归（终态单调性红线）+ 跨 worker zombie 回归测试。**首轮 code review 追加检出 M1/M2/M3**：同一漏洞在 agent 成功后的 gates catch、finalize catch、gate-runner repair/exhausted 路径仍有裸写；已补 ownership-lost stand-down（node-executor gates/finalize catch + gate-runner 三处），并新增「gates 阶段被 fence」回归测试（已验证移除守卫即失败）。
2. **补测试锁**：F-04（engine 非终态 → job failed + `agent/error`，fake-pass 红线）、F-08（durable 事件写前脱敏）。
3. **诚实披露**：P0-03、P1-01、P1-05 各补一句；同步 README/CHANGELOG/manual §11 披露清单至 100%。
4. **第二轮 code review 追加**：S6（gate-runner repair 循环 finally 在 fence 下不再 finalize lease——避免僵尸 `git branch -f` 强制回退新 owner 已交付的 run branch，与 S1 同源），本轮一并修复。

P1-05 的内容指纹硬化、其余递延项均属报告 §10 里程碑 A/B/C，且已在代码 / CHANGELOG / manual 诚实标注未开放，**不作为本 PR 缺口**，留待后续里程碑。

### 记录为后续（第二轮 review 提出，非本轮红线）

以下为交付分支 git 层残留与极窄窗口的状态不一致，**不回退 workflow 终态**（本轮红线已封闭），成本/风险与本 PR 里程碑不相称，记录待后续处理：

- **S7**：`rework.ts` 的 4 处 `finalizeExecutionLease` 同样未感知 fence（与 S6 同源，但 rework 仅 `changes-requested` + `independent-review` 可达，更窄）。修复需给 rework 线程 `getSignal` 并区分 success-path promote 与 cleanup finalize，避免误伤合法 rework 提升。
- **S8**：`gate-runner.ts` repair 成功后回写主节点的 `transitionNode(node.id,'running'/'awaiting-gate')` 为裸写；fence 落在"repair 成功后、回写前"极窄窗口时可能把 `passed` 节点回退成 `awaiting-gate`（workflow 行不动，仍 `passed`），造成节点/workflow 状态短暂不一致。
- **S9**：`engine-recovery.e2e.test.ts` 的 gates-fence 用例（gate engine 返回 failed result，节点 gate 无 autoFix → exhausted）驱动 fence 检查 (a)（runGate 非 passed 后）+ M1/M2 兜底；但 (b) repair-loop 顶部检查、exhausted-settle 前检查（`gate-runner.ts` exhausted 分支）、以及 M1/M2 catch 的抛错路径**未被单独驱动**（gate engine 返回 failed 而非抛错，且模板 gate 无 autoFix）。建议后续补 gate engine 抛错变体（单独锁 M1）+ autoFix gate + repair agent 抛错变体（锁 (b)/M2）+ exhausted 路径 fence 变体。
- **S2**：`node-executor.ts` SHOULD4 stale-running 分支未加 fence early-return（该行仍为裸写）；其触发条件（节点 `running` + active lease + 无 completed run）在正常时序下与 workflow 终态互斥（不回退终态），仅极窄的解冻窗口内可能误伤新 owner 在途 role_run。
