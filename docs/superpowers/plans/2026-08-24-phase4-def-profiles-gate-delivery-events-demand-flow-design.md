# 阶段 4（4d–4f）详细设计：profiles 策略层 + Gate/Delivery 事件订阅 + Demand→clarification/plan flow

- 状态：设计 v1，待最高思考等级 reviewer 评审
- 上游依据：报告 §0.6（实现级摸底订正）、4abc 设计（`docs/superpowers/plans/2026-08-24-phase4-abc-session-api-goal-plugin-design.md`）
- 范围：4d profiles 策略层、4e Gate/Delivery 事件订阅、4f Demand→clarification/plan flow。三者各自独立可交付。
- 前置：4a–4c（会话化闭环）已合入 PR#10，CI 绿，v0.12.0。

## 0. 摸底事实复核（4abc 落地后，2026-08-24 核实）

以下事实经读码确认，锚点为设计时 HEAD：

| 事实 | 锚点 | 与 §0.6 摸底的差异 |
|---|---|---|
| `sessions.profile` 纯展示、零行为分支 | `session-store.ts:39/122/198/534`；消费方仅 `session.ts:26,47`（透传）、`rpc-contract.ts:641`（z.string()） | 一致。4abc 未引入 profile 行为分支 |
| profile 赋值点 | `session-service.ts:156`（`SESSION_PROFILE = deps.sessionProfile ?? 'human-web'`）、`:197`、`:203`、`:287`；`gate.ts:189`（resume 补建硬编码 'human-web'）；CLI `session-context.ts:186`（`'cli'`） | 一致。4abc 把 profile 提升为 SessionService deps，仍无行为分支 |
| `createGateEngine` 生产调用点 4 个，无一传 registry | `web/root.ts:89`、`cli/session-context.ts:110`、`core/engine.ts:140`、`core/workflow-job-executor.ts:111` | §0.6 说 5 个，实际 4 个（executor 移入 core 时合并了一个）。registry 仍死代码 |
| gate 触发 = engine node 边界同步 pull | `node-executor.ts:338-349` | 一致 |
| latest-result 短路 | `gate-runner.ts:211-234`（`!forceRerun` 时查 `latestGateResult`，passed/skipped 直接 return true） | 一致 |
| `readiness/*` 事件类型不存在 | `session-contract.ts:148-161`（TEKON_GOVERNANCE_EVENT_TYPES 无 readiness/*） | 一致 |
| `delivery/prepared`/`delivery/pr-created` 词汇表有、生产零发射 | `session-contract.ts:158-159` 定义；全仓 src 无 append/publish | 一致 |
| `createPr` 不幂等 | `scm.ts:71-253`：无 already-created 短路；失败靠 `recoverExistingPrUrl:214` 兜底 | 一致 |
| bus 同步 fan-out、无背压无异常隔离 | `event-bus.ts:23-31`（for 循环同步调 listener，抛错中断后续并传播给 publisher） | 一致 |
| `pre-pr-readiness.ts:70-71` 硬编码 standard-delivery | `pre-pr-readiness.ts:70-71` | 一致。4e 不放宽 |
| 澄清原语在 core、仅 CLI 用 | `draft/shape.ts:636`（generateClarifyingQuestions）、`:696`（updateDraftWithAnswers）；消费方仅 `cli/draft-interactive.ts:116,185` | 一致 |
| draft approve 双侧强制 | `web/project.ts:141-151`（approved + readyForRun 双检）；CLI `draft.ts` approve | 一致 |
| job kind 显式分发 | `workflow-job-executor.ts:141-151`（switch + default throw） | 4abc 已落地，假 passed 陷阱已堵 |

**结论**：§0.6 摸底事实在 4abc 后全部仍成立（仅 createGateEngine 调用点从 5 变 4）。本设计基于这些锚点。

---

## 1. 4d — profiles 策略层

### 1.1 目标与硬约束

把 `sessions.profile` 从纯展示字段变为真实行为分支。三 profile：
- **`human-web`（默认）**：现有交互，不自动推进人工点。
- **`autonomous-delivery`**：高自治、严格 gate。**硬红线（CLAUDE.md「合入上线必须受控」「Iron Man suit 优先」）**：只能自动推进 **capability 类 gate**（build/lint/schema/security 等确定性门），并可自动 **prepare** delivery；**human-approval gate 与 PR 创建仍须人工**，不因 profile 削弱。硬约束，非可配项。
- **`review-only`**：只读/审阅视角，操作面收窄。

**关键事实**：capability gate（build/test/lint/e2e-pass/schema/security-scan）在 node 边界**已自动运行、自动通过/失败**，从不创建 human decision（`gate-runner.ts:239`→`runGate`；policy `requiresHumanApproval: []`，`workflow-runtime.ts:166`）。human gate（`type: 'human'`）才 block + createHumanDecision（`engine.ts:127-138`）。故"自动推进 capability gate"在当前运行时**已是默认行为**——4d 的价值不是改 gate 执行，而是：(1) 把 profile 差异变成**显式可测策略模块**；(2) 新增**自动 prepare delivery**（autonomous-delivery 的真实新自动化）；(3) **操作面 guard**（review-only 收窄）；(4) 用测试**锁定红线**。

### 1.2 最小机制

#### 1.2.1 新增 `packages/core/src/session/profile-policy.ts`（纯函数，无 IO，可单测）

- `SessionProfile = 'human-web' | 'autonomous-delivery' | 'review-only'`。
- `canAutoPrepareDelivery(profile)`：仅 autonomous-delivery true。
- `canMutate(profile)`：review-only false，其余 true。

> **评审订正（N5）**：不引入 `canAutoAdvanceGate`。理由：capability gate 在 node 边界已自动运行、human gate 已 block，且本设计明确拒绝把 profile 传进 engine——该函数无运行时消费者，会成为带测试的死代码（与本设计批评 gate registry 死代码的立场相悖）。gate 推进策略无需 profile 分支：capability 自动、human 人工，这两条对所有 profile 恒定，正是红线本身。

**被否**：把 profile 传到 engine/gate-runner 做运行时分支。理由：capability gate 已自动运行、human gate 已 block，运行时分支是 no-op；真正差异在 delivery 自动化和操作面 guard。在 engine 加分支徒增治理路径复杂度和回归面，零收益。

#### 1.2.2 自动 prepare delivery（autonomous-delivery 的真实新自动化）

- **触发源**：run 抵达 `passed`（`run.passed` audit → dual-write → `agent/status` 事件，payload 含 `status:'passed'`+`kind`，`dual-write.ts:101-105`）。
- **挂钩点**：组合根的 `bus.subscribeAll` listener（4e 引入的基础设施）。listener 只做**轻量判断 + enqueue job**（bus 同步 fan-out 无背压，重活必须丢 job）：查 session.profile，`canAutoPrepareDelivery` 为真则 enqueue 新 job kind `delivery-auto-prepare`。listener 内异步 enqueue 用 `void enqueue(...).catch(onError)`（N7：同步 listener 不 await 异步写）。
- **执行**：`delivery-auto-prepare` job 走**独立轻量 executor**，见 §1.2.2a 的 executor 隔离机制（M1）——**不经** workflow executor 的 active/turn-start/buildEngine/settle 路径。执行体：先判 `workflow_instance.kind==='goal'` → 直接跳过（goal 不接 delivery）；查 `delivery_pull_requests`，已 `prepared`/更后状态 → 幂等跳过；调 `createPullRequestPreparation`（`pr-package.ts:27`，内部 `assertPrePullRequestReady`，未就绪 run 会抛错——这是**预期内**情况，按 M1 的隔离语义只记 audit + `agent/error`，**不改 session/run 状态**）；成功后 **upsert `delivery_pull_requests` 的 `prepared` 行**（N7：`createPullRequestPreparation` 本身不碰 delivery 表，job 负责 upsert，否则幂等检查与"status 停在 prepared"断言无依托）+ 发 `delivery/prepared` 事件。**绝不调 `createPr`**。
- **去抖**：`delivery_pull_requests.status` 是天然去抖器 + writeQueue 单写序列化，并发 enqueue 的第二个 job 查到 status 已变即跳过。
- **profile 读取路径**：executor 通过 `sessions.findSessionByRunId(runId).profile` 读。**不需要**把 profile 透传到 engine。

##### 1.2.2a executor 隔离机制（M1，4d/4e 共用前置）

**问题（评审 M1）**：现有 `workflow-job-executor.ts` 的 `execute()` 是 workflow 专属结构——:131 无条件 `updateSessionStatus('active')`、:132 发 `turn/start`、:135 `buildEngine(runId)`（强依赖 `getRunProviderConfig`）、:153 `settleByWorkflowStatus`、:175-181 catch 一律 `updateSessionStatus('failed')`。三个新自动化 kind（`delivery-auto-prepare`/`gate-validation`/`readiness-evaluate`）**不需要 engine、也绝不能改 workflow/session 终态**；若只在 switch 里加 case，(a) auto-prepare 对未就绪 run 抛错（预期情况）会把已 passed run 的 session 打成 failed；(b) 强制 buildEngine 错误依赖 + 浪费；(c) 成功路径无 WorkflowInstance 可交给 settle。

**方案（选定）**：在 **job-runner 层做 kind→executor 路由**。`createJobRunner` 接受一个 executor **map**（或保留单 executor 但按 kind 分派）：workflow 类 kind（`workflow-run`/`goal-run`/`workflow-resume`）→ 现有 `createWorkflowJobExecutor`（零改动）；自动化 kind → 新增 `createAutomationJobExecutor`（轻量：无 active/turn-start/buildEngine/settle；执行体自负盈亏；失败只 `audit.append` + 发 `agent/error`，**不碰 session/workflow 状态**；成功发各自的领域事件）。未知 kind 仍在两个 executor 之外由 runner 显式 fail（default throw 保留，假 passed 陷阱不回归）。

**被否方案**：在 `workflow-job-executor.execute()` 顶部对新 kind 早返回（绕过 active/turn-start/buildEngine/settle）。理由：把两类语义塞进一个 executor，catch 路径共用会持续引诱"失败→session failed"的回归；kind→executor 路由边界更清晰，且新 executor 可独立单测。

**测试锁定（M1）**：`delivery-auto-prepare` 对**未就绪** run 执行 → job failed + `agent/error` 事件，但 run 仍 `passed`、session 仍 `done`（断言隔离生效，不被打成 failed）。

#### 1.2.3 操作面 guard（review-only）

- **web**：dispatch.ts 统一 guard（决策 D2）。session 关联操作（cancel/pause/approve/reject/delivery）查 `findSessionByRunId(runId).profile`，review-only → 403。session 创建操作（project.run）不 guard（review-only 不应由 run 创建）。
- **CLI**：run/cancel/pause/approval/delivery 执行前查 profile，review-only → 报错退出。

#### 1.2.4 profile 赋值

- web `root.ts` deps 显式 `sessionProfile:'human-web'`。CLI `'cli'` 在 policy 里视为 `human-web` 别名。
- **autonomous-delivery/review-only 显式指定**（决策 D1）：web `project.run` 入参加 `profile?: SessionProfile`（默认 human-web）；CLI `tekon run --profile autonomous-delivery`。**不自动推断**。

### 1.3 数据结构与事件
- 无新增表/列（`sessions.profile` 已是 text）。
- 新 job kind：`delivery-auto-prepare`（executor switch 显式分发）。
- 新事件发射：`delivery/prepared`（词汇表已有），payload `{runId, branch, baseBranch, packagePath, prBodyPath, auto:true}`。

### 1.4 测试策略
- 单测 `profile-policy.test.ts`：canAutoPrepareDelivery 仅 autonomous true；canMutate review-only false。（不含 canAutoAdvanceGate——N5 已删）
- 集成 `delivery-auto-prepare.test.ts`（web/core，长驻 jobRunner）：autonomous 的 standard-delivery run passed → enqueue → job → upsert `status='prepared'` → `delivery/prepared` 发射；**红线锁定：不发 `delivery/pr-created`、不调 createPr（status 停在 prepared/awaiting-approval）**；human-web 不 enqueue；goal run 不 prepare；幂等（重复 passed 只执行一次）；**M1 隔离锁定：未就绪 run 的 auto-prepare job failed 但 run 仍 passed、session 仍 done**。
- e2e：review-only session 的 `tekon cancel` / web mutation → 拒绝（guard 生效）。

> **评审订正（M2）**：**取消**原"CLI `run --profile autonomous-delivery` → 自动 prepared" e2e。理由：`tekon run` 只 await workflow job（`run.ts:155-159` → `awaitJobTerminal` 单 job 轮询），auto-prepare job 在 `run.passed` 后毫秒级入队，200ms poll + `jobRunner.stop()` 只等 in-flight（不等已入队未 claim）→ CLI 进程退出前大概率来不及 claim，e2e 必 flaky。**auto-prepare 是长驻服务（web/headless jobRunner）特性**，不适配 CLI run-to-exit 生命周期。CLI 下 autonomous 的 delivery 仍走**显式** `tekon delivery prepare`（人工触发，语义不变）。集成测试在 web/core 长驻 jobRunner 下验证 auto-prepare，不做 CLI e2e。
>
> **评审复查订正（round 2）**：**CLI 组合根不装配 auto-prepare listener**（只有 web/headless 长驻组合根装配）。否则 `tekon run --profile autonomous-delivery` 会 enqueue 一个 auto-prepare job，CLI 退出后它滞留 `queued`，被下一个启动 jobRunner 的 CLI 命令（`tekon pause`/`resume`）的 poll claim 并在不相关命令里延迟触发 prepare——虽经 M1 隔离 + 幂等无破坏性，但违背"CLI 不承诺自动 prepare"语义。故 auto-prepare listener 仅在 web/headless 装配。

### 1.5 风险与回归面
- `bus.subscribeAll` 新接口，per-session subscribe 不受影响。
- auto-prepare job 失败不影响 run（M1 隔离：独立 executor，只记 audit + `agent/error`，不改 session/run 状态）。
- goal 误触发由 job 内 `kind==='goal'` 提前跳过 + `assertPrePullRequestReady` 恒红双重兜底。
- **M2 生命周期**：auto-prepare 仅在长驻 jobRunner（web/headless）下可靠触发；CLI run-to-exit 不承诺自动 prepare（显式 `tekon delivery prepare` 不变）。
- 现有测试：`session-contract.test.ts` 可能补 `delivery/prepared` payload 校验；dual-write 不受影响。

---

## 2. 4e — Gate/Delivery 事件订阅

### 2.1 目标
- **validation-only 旁路 gate**：事件触发判定，结果落 `gate_results` 供 UI/delivery 消费，**不动 workflow 状态机**；node 边界同步 gate 保留为权威路径，靠 latest-result 短路防双跑。
- **delivery 事件化**：新增 `readiness/evaluated` 事件 + 生产者 + 去抖投影；`createPr` 幂等守卫。
- **bus 约束**：同步 fan-out，重活丢 job，listener 不阻塞 SSE/job 发射。

### 2.2 最小机制

#### 2.2.1 bus 全局订阅 + 异常隔离
- `event-bus.ts` 加 `subscribeAll(listener): () => void`（不按 sessionId 过滤）。
- `publish` 的每个 listener 调用包 try/catch，错误报 `onError` 回调，**不吞 silently 也不中断后续 listener**。
- **被否**：异步 bus / 消息队列。理由：SSE 依赖同步语义（先 subscribe 再 replay 零丢失），改异步破坏时序保证。异常隔离 + 重活丢 job 是最小改动。

#### 2.2.2 validation-only 旁路 gate
- **触发源**：`artifact/created` 事件（dual-write 已映射，`dual-write.ts:326-343`）。artifact 类型有关联 validation gate 时触发。
- **执行**（新 job kind `gate-validation`，走 §1.2.2a 的自动化 executor，不动 workflow/session 状态）：查 node 的 gates 配置，匹配 artifactType 的 validation gate，调 `gateEngine.runGate`，结果**只落 `gate_results`**，**不调 transitionNode / updateWorkflowInstanceStatus**。
- **N3 订正（human gate 过滤，必须）**：旁路 job 必须只处理 `gate.type !== 'human'` 的 gate。理由：`gateEngine`/human-gate 路径会 `transitionNode('paused')`+`updateWorkflowInstanceStatus('paused')`（`human-gate.ts:60-66`）——若自定义工作流给 human gate 配了 artifactType，旁路会把 node/workflow 打成 paused。旁路只对 schema/语义类 validation gate 开放。
- **N1 订正（gateKey 必须复用 stable-key，否则短路失效）**：权威路径用 `gatesWithStableKeys(node.gates, node.id)` 算 stable gateKey（`node-executor.ts:338`），`latestGateResult` 按 gateKey 过滤（`gate-runner.ts:212-218`）。旁路 job 写 `gate_results.gateKey` **必须复用同一 `stableGateKey`/`gatesWithStableKeys`**（`workflow-runtime.ts:120-136`，已导出），否则 key 不一致、短路永不生效、每次双跑。
- **N2 订正（并发写 gate_results 的 stale-latest 竞态）**：`listGateResults` 按 `created_at,id` 排序取 `.at(-1)`（`repositories.ts:570-577`）。若权威先写 passed、旁路后基于旧 artifact 写 failed，latest 变 failed → node 不受影响但 `evaluatePrePullRequestReadiness` 用 latest（`pre-pr-readiness.ts:41-53`）会误报 not-ready + delivery evidence 显示 stale failed。**缓解**：旁路写结果前先查 `latestGateResult`，已有 passed/skipped 则不写；且旁路**只对 schema gate**（纯 artifact 内容校验、状态单调）开放（N4：security-scan 在基线 repoPath 跑而非 worktree，语义错，不纳入旁路）。
- **防双跑**：权威路径 node 边界 `gate-runner.ts:211-234` latest-result 短路查到旁路结果——旁路 passed 则权威短路 return true；旁路 failed（罕见，已被上面缓解）则权威重跑。语义：旁路是预检，权威是正式判定。
- **被否**：激活 registry。理由：registry 死代码，激活是触发模型变更，超出最小范围；旁路用现有 gateEngine 即可。

#### 2.2.3 `readiness/evaluated` 事件 + 去抖投影
- `session-contract.ts` `TEKON_GOVERNANCE_EVENT_TYPES` 加 `'readiness/evaluated'`。
- **生产者**（新 job kind `readiness-evaluate`）：`gate/result` 事件 → listener 去抖（~2s）→ enqueue → 调 `evaluatePrePullRequestReadiness`（`pre-pr-readiness.ts:21`）→ 发 `readiness/evaluated`，payload `{runId, ready, checks:[{id,passed,evidence}]}`。
- **消费者**（决策 D4）：本阶段只发事件 + CLI 可查；web UI 实时展示列为可选增强。

#### 2.2.4 `createPr` 幂等守卫
- `scm.ts:71` `createPr` 顶部加短路：若 `getDeliveryPullRequest(runId).status==='created' && prUrl` → 返回既有状态，不重跑 `git push`/`gh pr create`。
- 锁定测试：同 runId 调两次 createPr（humanApproved=true），第二次 gateway.run 不被调用 / commands 为空。

### 2.3 数据结构与事件
- 新事件类型：`readiness/evaluated`。
- 新 job kind：`gate-validation`、`readiness-evaluate`（executor switch 显式分发）。
- 无新表/列。

### 2.4 测试策略
- 单测：`event-bus.test.ts`（subscribeAll 收全量 + listener 抛错不中断其他）；`scm.test.ts`（createPr 幂等）。
- 集成：旁路 gate（artifact/created → gate-validation job → gate_results 新记录 → **node 状态不变** → 权威路径 latest-result 短路生效）；readiness/evaluated（gate/result → job → 事件含 checks）；去抖（连续 3 个 gate/result → 只 1 个 readiness job）。
- e2e：web Delivery 页签执行中实时显示 readiness（可选）。

### 2.5 风险与回归面
- subscribeAll 影响 SSE：SSE 用 per-session，异常隔离保证 subscribeAll listener 抛错不中断 SSE。
- gate-validation 与权威路径都写 gate_results：latest-result 按 createdAt 取最新，无冲突，旁路不阻塞 node。
- readiness-evaluate 频繁触发：去抖 + job 幂等（评估只读）。
- 现有测试：`session-contract.test.ts` 补 `readiness/evaluated`；dual-write 不受影响。

---

## 3. 4f — Demand → clarification/plan flow

### 3.1 目标
- **非 TTY 澄清通道**：澄清问答做成 session turn 事件，web/headless 可用。
- **独立 plan 产物 + 计划审批点**：draft→approve→run 流插入 plan 产物和审批，不破坏既有强制审批。

### 3.2 最小机制

#### 3.2.1 澄清问答做成 session 事件
- 新事件类型（`CONTROL_EVENT_TYPES` 加）：`clarification/requested`（payload `{questions:string[], draftId}`）、`clarification/answered`（payload `{answers:[{question,answer}], draftId}`）。
- 生产者：web `draftShape.clarify` RPC（调 `generateClarifyingQuestions`，发 requested 事件）、`draftShape.answer` RPC（调 `updateDraftWithAnswers`，发 answered 事件）。
- CLI：`tekon draft clarify`（输出问题 JSON）+ `tekon draft answer --file`（回填）；TTY 模式 `draft-interactive` 不变。
- UI：Session 页签订阅 `clarification/requested` 渲染表单，提交发 `clarification/answered`。
- **被否**：澄清做成 agent loop 多轮对话。理由：当前 agent loop 是一次性 `runAgent()`，多轮需重构。session 事件是最小改动。

#### 3.2.2 独立 plan 产物 + 计划审批点（评审 M3 订正：拆 4f-1 / 4f-2）

**评审 M3 指出**：原设计 D3"approveDraftShape 未设置 planApproved 默认 true" + `project.run` 检查 `===true` 自相矛盾——新 draft approve 瞬间 planApproved 即为 true，审批点永远通过、沦为装饰。故拆为两独立子步：

- **4f-1（澄清事件化，可直接实现）**：§3.2.1 的 clarification/requested/answered 事件 + RPC/CLI，与 plan 审批解耦，无 M3 问题，先交付。

- **4f-2（plan 产物 + 审批，M3 修正后实现）**：
  - **plan 产物**：draft shape 内新增 plan 视图（`acceptanceCriteria`+`recommendedTemplate`+`nonGoals` 的结构化快照），标记该 draft"已生成 plan 产物"（`hasPlan: true`）。仅在用户显式生成 plan 时置位（新 RPC `draftShape.generatePlan` / CLI `tekon draft plan`），**不在 approve 时自动生成**。
  - **plan 审批点（独立动作，非 approve 副产品）**：新增 `draftShape.planApprove` RPC + CLI `tekon draft plan-approve`，显式把 `planApproved` 置 true。`approveDraftShape`（需求审批）**不触碰** `planApproved`——两个审批正交（需求审批 vs 计划审批）。
  - **`project.run` 检查（向后兼容且非装饰）**：`if (shapedDraft.hasPlan && shapedDraft.planApproved !== true) → 拒绝`。语义：**有 plan 产物的 draft 必须计划审批后才能 run**（审批点真实生效）；**无 plan 产物的 draft（含所有旧 draft）豁免**（`hasPlan` 缺失/false → 跳过检查，既有 draft approve→run 路径零破坏）。
  - draft shape schema 加 `hasPlan?:boolean` + `planApproved?:boolean`（均可选，旧文件读取安全）。
  - **被否**：approve 自动置 planApproved=true（M3 的装饰性问题）；独立 plan 表（过度设计）。

**收窄退路**：4f-2 若工作量超预期，可只交付 4f-1；4f-2 单列。4f-1 与 4f-2 相互独立，4f-1 不依赖 4f-2。

### 3.3 数据结构与事件
- 新事件类型：`clarification/requested`、`clarification/answered`（4f-1）。
- draft shape schema 扩展 `hasPlan?:boolean` + `planApproved?:boolean`（4f-2，均可选，旧文件读取安全）。
- 无新表。

### 3.4 测试策略
- 单测：`shape.test.ts`（往返 + 事件发射断言）；schema `hasPlan`/`planApproved` 可选默认 undefined。
- 集成（4f-1）：`draftShape.clarify`→requested→`draftShape.answer`→answered→draft 更新。
- 集成（4f-2）：`draftShape.generatePlan`→`hasPlan=true`；`draftShape.planApprove`→`planApproved=true`；`project.run` 对 `hasPlan=true && planApproved!==true` 的 draft →400，`planApproved===true`→通过；**向后兼容锁定：`hasPlan` 缺失/false 的旧 draft →`project.run` 直接通过（不被计划审批点拦截）**。
- e2e（4f-1）：CLI clarify→answer→approve→run。e2e（4f-2）：CLI generatePlan→plan-approve→approve→run；**旧 draft（无 plan）approve→run 仍绿**。

### 3.5 风险与回归面（**最高回归项**）
- **draft shape schema 是 `.strict()`**：加**可选已知**字段不影响旧 draft 文件读取（zod strict 只拒绝**未知**字段，不拒绝缺失的已知可选字段——评审已核实 positive#4）。
- **唯一回归点**：`project.run` 新增检查。M3 修正后检查条件为 `hasPlan && planApproved!==true`，旧 draft（无 `hasPlan`）恒豁免，既有 approve→run 零破坏。**实现时须 e2e 锁定旧 draft 仍可 run。**
- `approveDraftShape` **不触碰** `planApproved`（需求审批与计划审批正交），既有 approve 单测断言不变。
- CLI draft-interactive（TTY）不受影响。

---

## 4. 子步拆分与顺序

```
4e (bus 基础设施 + 事件化) ──> 4d (复用 bus subscribeAll + 策略层)
4f (draft 域，完全独立) ─────（可与 4d/4e 并行）
```
- 4d 和 4e 都需 `bus.subscribeAll`（4e §2.2.1 引入）；**建议 4e 先做基础设施，4d 复用**。
- 4f 完全独立（draft/shape 域）。
- 每步独立 e2e 边界见各 §测试策略。

## 5. 关键取舍汇总

| 决策点 | 选择 | 被否 | 依据 |
|---|---|---|---|
| profile 差异挂载 | 策略模块 + delivery listener + API guard，不进 engine | engine/gate-runner 运行时分支 | capability gate 已自动运行，engine 分支 no-op |
| auto-prepare 触发 | `agent/status passed` + bus listener | engine 内直接调 delivery | engine 不应知 delivery；事件解耦 CLI/web 复用 |
| 重活执行 | 新 job kind | listener 内直接执行 | bus 同步 fan-out，listener 阻塞卡死 SSE/job |
| 旁路 gate 触发 | `artifact/created` 事件 | 激活 registry | registry 死代码，激活是触发模型变更 |
| 旁路 gate 落库 | `gate_results`（同表） | 独立 validation 表 | 复用 latest-result 短路防双跑 |
| plan 存储 | draft shape 扩展 | 独立 plan 表 | 最小改动 |
| 澄清通道 | session 事件 | agent loop 多轮 | 当前 loop 一次性，多轮需重构 |

## 6. 已决问题（主 agent 拍板，2026-08-24）

> 设计者列出 4 项未决，主 agent 依 CLAUDE.md 原则决策如下，落地以此为准：

- **D1 — autonomous-delivery 赋值**：**显式参数**（web `project.run` 入参 `profile?`，默认 human-web；CLI `--profile`），**不自动推断**。依据：治理红线「不得静默升级自治」——自治级别必须由调用方显式声明。
- **D2 — review-only guard 层级**：**dispatch.ts 统一 guard**。依据：减少各 router 遗漏；guard 是 API 层横切关注点。
- **D3 — plan 审批（评审 M3 修正后）**：拆 **4f-1**（澄清事件化，直接实现）+ **4f-2**（plan 产物 + 审批）。4f-2 中：`draftShape.generatePlan` 显式生成 plan 产物置 `hasPlan=true`；`draftShape.planApprove` 独立动作置 `planApproved=true`；`approveDraftShape`（需求审批）**不触碰** `planApproved`（两审批正交）；`project.run` 检查 `hasPlan && planApproved!==true → 拒绝`（**有 plan 的 draft 审批点真实生效；无 plan 的旧 draft 恒豁免，向后兼容**）。依据：原 D3"approve 默认置 true"使审批点装饰化（评审 M3），改为独立审批动作 + hasPlan 门控，既强制新流程又零破坏旧路径。

> **评审响应记录（design review round 1，2026-08-24）**：opus reviewer 检出 3 must-fix（M1 executor 隔离、M2 CLI 生命周期、M3 plan 审批不可达）+ 若干机制点（N1-N7）。本设计已据此修订：M1→§1.2.2a（job-runner kind→executor 路由，自动化 kind 走轻量 executor 不污染 session/run 状态）；M2→§1.4（取消 CLI auto-prepare e2e，auto-prepare 收窄为长驻服务特性，CLI 显式 prepare 不变）；M3→§3.2.2 + D3（拆 4f-1/4f-2，独立审批动作 + hasPlan 门控）；N1/N2/N3/N4→§2.2.2（旁路 gate 复用 stableGateKey、写前查 latest 防 stale、过滤 human gate、只对 schema gate 开放）；N5→§1.2.1（删死代码 `canAutoAdvanceGate`）；N6/N7→§8 handoff 补 session-service/project.ts + 异步 enqueue catch。摸底锚点经 reviewer 抽查 15+ 处全部属实。
- **D4 — readiness/evaluated 消费者**：**本阶段只发事件 + CLI 可查**，web UI 实时展示列为**可选增强**（不阻塞 4e 交付）。依据：方案规模与任务相称，UI 实时投影可独立迭代。

## 7. 验收（每子步独立 e2e）
- **4d**：profile-policy 单测绿（canAutoPrepareDelivery/canMutate；无 canAutoAdvanceGate）+ auto-prepare 集成（web/core 长驻 jobRunner：prepared 成功、**M1 隔离锁定未就绪 run 不打成 failed**、**红线锁定不创建 PR**）+ review-only guard e2e。
- **4e**：bus subscribeAll 单测（含 listener 抛错隔离）+ 旁路 gate 集成（不动状态机 + gateKey 复用短路生效 + 只对 schema gate/过滤 human gate）+ createPr 幂等 + readiness 事件。
- **4f-1**：澄清事件化集成 + e2e。**4f-2**：plan 生成 + 独立 plan-approve + `project.run` 门控 + **旧 draft（无 hasPlan）仍可 run 的向后兼容 e2e**。
- **全阶段**：`corepack pnpm test` 全绿 + Playwright 基线 + typecheck clean。

## 8. 实现交接（IMPLEMENTATION_HANDOFF）

**target_files**（按子步；评审 M1/N5/N6 已并入）：
- **4d**：新增 `packages/core/src/session/profile-policy.ts`（仅 `canAutoPrepareDelivery`/`canMutate`，**不含 canAutoAdvanceGate**）+ 测试；新增 `packages/core/src/session/automation-job-executor.ts`（M1：自动化 kind 轻量 executor，自捕错误 emit agent/error+audit 后 return failed，绝不 throw）+ 测试；改 `session/job-runner.ts` 或组合根（M1：kind→executor 路由；首选组合根注入复合路由 executor，零改动 job-runner）；改 `event-bus.ts`（subscribeAll）；改 `web/root.ts`（auto-prepare listener 装配——**仅 web/headless，CLI 不装**；profile 映射 + kind→executor 注入）；改 `cli/session-context.ts`（kind→executor 注入 + profile 映射，**不装 auto-prepare listener**）；改 `web/dispatch.ts`（review-only guard）；改 `web/rpc-contract.ts`（project.run 加 profile）；改 `session/session-service.ts`（N6：startRun 加 profile 入参，替换 SESSION_PROFILE 常量）；改 `web/routers/project.ts`（N6：RPC profile 入参→startRun）。delivery-auto-prepare 执行体在 automation-job-executor 内（含 kind==='goal' 早跳过 + delivery_pull_requests upsert 'prepared' 行）。
- **4e**：改 `types/session-contract.ts`（readiness/evaluated）；改 `event-bus.ts`（subscribeAll + 异常隔离）；gate-validation + readiness-evaluate 执行体加入 `automation-job-executor.ts`（复用 stableGateKey/gatesWithStableKeys、过滤 human gate、只对 schema gate、写前查 latest）；改 `delivery/scm.ts`（createPr 幂等短路）；listener 装配（web/headless 长驻组合根；readiness listener 去抖，异步 enqueue 用 void+catch）。
- **4f-1**：改 `types/session-contract.ts`（clarification/requested/answered）；改 `web/routers/demand.ts`（clarify/answer RPC + 发事件）；改 `cli/commands/draft.ts`（clarify/answer 子命令）。
- **4f-2**：改 `draft/shape.ts`（hasPlan/planApproved 字段，approveDraftShape **不**动 planApproved）；改 `web/routers/demand.ts`（generatePlan/planApprove RPC）；改 `web/routers/project.ts`（`hasPlan && planApproved!==true` 门控 + 旧 draft 豁免）；改 `cli/commands/draft.ts`（plan/plan-approve 子命令）。

**acceptance_criteria**：见 §7。**decisions**：见 §6（D1–D4 已定）。
