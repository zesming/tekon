# Tekon 人类可用性与 Harness 架构第四轮全面复审

- **复审日期**：2026-08-29
- **用户最新整改提交**：`ecc1f74492e8a2582c5a338238939d5051c38a52`
- **本轮代码修复提交**：`3b26d88852ceb78291ff85d407fc221dd9b48f20`
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **对照基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **验证快照**：Core #279 `success`；CI #188 `success`
- **覆盖维度**：产品逻辑、CLI/Web UI、UX、Session/Runtime 架构、代码实现、数据完整性、测试可信度、DeepSeek Harness 对齐、过度实现与过度设计
- **最终结论**：**用户最新整改与本轮低风险修复通过代码合并门；Tekon 仍不通过“面向普通人的稳定研发工作台”产品验收，可作为实验性受控交付基础设施有条件通过。**

> 本报告是 PR #11 当前代码与合并判断的权威入口。首轮至第三轮报告仅保留判断演进历史。

---

## 1. 执行摘要

用户本轮关闭了第三轮的 `P1-CODE-01`：`session.get` 不再为了取得最后活动时间先查 `latestSeq`、再读取并反序列化完整尾事件，而是通过 `(session_id, seq)` 索引直接执行 `order by seq desc limit 1`，只投影 `timestamp`。实现、接口、Core/API 测试和 CI 一致，**该整改通过**。

复审整个仓库时发现一个独立产品合同缺口：高级 Web 表单展示 `dsh-headless（仅 Goal）`，但此前没有 Goal 模式，也不会向 `project.run` 发送 `mode: goal`；CLI 与 Web API 同样接受 `dsh-headless + workflow`、`goal + template`、`goal + autonomous-delivery` 等无法成功或会被静默忽略的组合。失败发生在后台执行期，已经产生 Workflow、Session 和 Job，属于可避免的晚失败。

本轮已将该约束收敛为共享 run-mode policy：

- CLI 在创建 Workflow、Session 或 Job 前 fail-fast；
- Web API 通过小型路由包装层执行同一服务端校验；
- 高级 Web 表单显式区分 Workflow 与 Goal，选择 dsh-headless 时自动进入 Goal；
- Goal 禁用模板和 autonomous-delivery，并明确说明不进入 Gate、Artifact 或交付链路；
- 增加 Core、CLI、Web API 三层测试。

最新增量没有改变四项结构性结论：Runtime 仍是多 owner，shutdown 仍非 quiescent，Session Event 仍是 best-effort projection，持续协作 Collaborate 轨道仍不存在。因此不能把本 PR 合并解释为稳定产品通过。

---

## 2. 复审方法与证据边界

本轮重新覆盖 README、主用户手册、current-scope、CHANGELOG 与前三轮报告；CLI 的 run/resume/cancel、Provider 参数和 composition root；Web 的 Session 列表/详情、主 Composer、高级新建运行、EventFeed、Token、审批和运行控制；Core 的 Session store、Job runner、SessionService、dual-write、LegacyAgentDriver、Provider/DSH bridge；数据库表、索引、读写顺序、跨进程边界和测试；以及 DeepSeek Harness 官方 Architecture、Session Persistence、headless、SDK、ACP、Safety 与最新 prerelease。

这是“仓库级结构覆盖 + 决定产品/架构结论的关键路径深读”，不宣称逐行审阅全部辅助文件。

本轮没有可访问的独立部署实例，因此未冒充完成全站像素级、键盘焦点、屏幕阅读器和多浏览器实测。UI 判断来自源码、ARIA/状态契约、RPC/SSE 数据流、响应式实现和现有 Playwright。高级 Goal/dsh 表单的状态切换尚无专门浏览器断言，列为 P2 测试补强项。

---

## 3. 对用户最新整改的裁决

| 整改项 | 裁决 | 理由与依据 |
| --- | --- | --- |
| `getLatestEventTimestamp()` 轻量尾读 | **通过** | 只读 `timestamp`，使用现有 `(session_id, seq)` 索引反向扫描，不解析 payload。 |
| `session.get` 使用轻量尾读 | **通过** | list/get 继续共享“最高 seq 为最后追加事件”的语义，去掉两次查询和完整事件反序列化。 |
| Core/API 测试更新 | **通过** | 覆盖无事件、多个事件取最高 seq、list/get 活动时间一致性。 |
| P1-CODE-01 关闭 | **接受** | 当前读路径问题已实质关闭。 |
| Event 数据完整性整体关闭 | **不接受** | `session_events.session_id` 无外键，`appendEvent` 不验证 Session 存在，孤儿事件仍可存在。 |

接口注释写明“Session 不存在时返回 null”，但数据库允许某个不存在的 Session ID 拥有事件行。当前真实语义是“没有匹配事件行时返回 null”。这不影响本轮性能修复，却说明 Event log 尚不具备成为权威事实源所需的引用完整性。

不建议在评审提交中只给新数据库加外键：现有数据库可能已有孤儿行，且 `session_events`、`jobs`、`projection_checkpoints` 都需要统一 migration、检查和清理策略。应独立设计 backfill/orphan policy 并验证老库升级。

---

## 4. DeepSeek Harness 对齐复核

### 4.1 Headless 与持续协作是两种产品边界

官方 headless profile 定义为“一次调用运行一个任务”，适合脚本、CI 与 one-off automation，不提供交互式 follow-up。官方 SDK profile 提供持久 JSON-RPC Session，ACP profile 提供 session new/list/resume/close、取消和持久 Agent 生命周期。

依据：

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Headless profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [SDK profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md)
- [ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md)

因此，Tekon 把 `dsh-headless` 限制为 Goal 一次性任务是正确产品边界；把它继续包装成受控交付 Provider 或持续 Session 驱动则不成立。后续 Collaborate 应评估 SDK/ACP，而不是继续扩 headless one-shot 兼容层。

### 4.2 Session log 的价值是权威事实链

官方架构明确：durable Session events 是模型上下文、replay、fork、resume、transcript 和 persistence 的来源；模型可见内容必须可从 log 重建，输入从一个 inbox 进入 Agent loop。官方 persistence 还提供 flush-through-quiescence 和崩溃后 interrupted turn 修复。

Tekon 当前 `session_events` 仍由旧表/Audit 成功后 best-effort 双写，失败被吞掉，找不到 Session 会跳过。它适合作为观察投影，不足以承担 durable inbox、模型历史和恢复事实源。

### 4.3 Safety 仍需产品化

官方 Safety 将 Harness 定义为未经过安全审计的 developer-preview；sandbox、审批和权限不能保证隔离。Tekon 已在 dsh 选项和 Goal 帮助中披露“experimental / 网络不受限”，但 Web 仍由代码替用户确认 unrestricted-network。后续应把该风险变成一次显式确认或连接策略，而不是只靠下拉项文案。

---

## 5. 产品逻辑、UI 与 UX

### 5.1 已成立：Deliver / 受控交付

当前主入口明确命名“受控交付”，README 与 Composer 诚实说明会运行完整角色、Artifact 和 Gate 链路；PR 创建等远端副作用仍需显式人工批准。现有 Deliver 合同基本成立。

### 5.2 本轮关闭：Goal / Provider 模式错配

原问题：Web 展示 dsh-headless“仅 Goal”却没有 Goal 模式；CLI/API 接受不可能成功的 dsh-headless workflow；Goal 会静默忽略 template，且可错误携带 autonomous-delivery。

新行为：Workflow / Goal 在高级 Web 中成为显式选择；dsh-headless 自动选择 Goal，切回 Workflow 时自动回退 codex；Goal 不发送 template/profile；CLI 和 Web API 在任何持久副作用前拒绝非法组合；服务端校验仍是权威边界，UI 只是指导。

### 5.3 仍未成立：Collaborate

`LegacyAgentDriver.events()` 仍等待 one-shot 完成后才回放缓冲事件；`followUp`、`steer`、`resume` 仍抛 `NotSupportedYet`；多数 assistant 内容仍在执行完成后由产物合成。当前 Session 不能持续输入、转向或在进程重启后恢复。

### 5.4 仍需收敛的 UX

- 完整 Deliver 启动前没有 run plan：角色、Gate、Provider、网络、工作区、超时和成本影响因素不可预览；
- Session 列表没有 workspace 级实时 summary stream，ticker 只更新时间文字；
- `failed` 永久映射为 `needsAction`，没有 acknowledge/archive/changedSinceSeen；
- Token 仍是顶栏常驻字符串输入，而不是“已连接/需重连/权限范围”状态；
- 主路径仍混用 Session、Profile、Gate、Artifact 等工程术语；
- 长 Session 的数据、内存与 DOM 仍无分页、虚拟化、摘要和 context pressure；
- 高级新建运行的折叠标题仍是可点击 `div`，缺键盘按钮语义和 `aria-expanded`。

---

## 6. Runtime 与整体架构

### P0-ARCH-01：一个 repo 仍有多个执行 owner

Web 和 CLI 都能创建并启动 JobRunner，共享 SQLite、Git、worktree、运行目录和子进程。Job owner/status CAS 只覆盖 jobs 表，无法 fence Node、Artifact、Gate、Audit、Delivery 和文件系统副作用。

**建议**：优先 single-owner daemon + repo lock，CLI/Web 客户端化；只有明确需要多 owner 时才设计全副作用 generation fencing。

### P0-ARCH-02：shutdown 仍非 quiescent

JobRunner 最多等待约 5 秒，之后清理 heartbeat、controller、execution token 和 pause flag。该行为没有证明 provider、子进程、Git/文件写入与异步 listener 已停止，仍可能发生 late write。

**建议**：定义 stop-admit → cancel/drain → subprocess join → persistence flush → listener drain → close DB 的可证明顺序，并做 kill/restart/late-write 故障注入。

### P0-ARCH-03：Session Event 仍是观察投影

Dual-write 先写旧事实源，再 best-effort append Event；失败不回滚，Session 不存在时跳过。新增轻量尾读优化的是观察面读取成本，没有改变事实源角色。

**建议**：选择唯一 authority：要么采用权威 Session log + transactional outbox 投影治理域，要么明确 Event 永久仅为 UI projection，不继续让其接口承担 replay/inbox 暗示。

### P0-PRODUCT-01：持续协作纵向闭环缺失

没有真实 execution-time streaming、durable inbox、follow-up、steer、resume 和重启恢复。当前更多横向抽象无法替代该纵向闭环。

---

## 7. 代码实现、数据与测试

本轮共享 `getRunModePolicyIssue` 保持无副作用，CLI/Web API 在副作用前调用；Web 采用小型包装路由，不继续放大既有大 router；服务端先验证 token 再返回模式错误。该实现范围与问题相称。

### P1-DATA-01：Session 子表缺引用完整性

`sessions.workspace_id` 有外键，但 `session_events.session_id`、`jobs.session_id`、`projection_checkpoints.session_id` 没有；`appendEvent` 也不查 Session。风险包括孤儿事件、未来 replay/删除/迁移的不可解释行，以及事实源升级前的数据清理成本。

### P1-CODE-02：列表规模仍只解决一半

相关子查询消除了全事件聚合，但仍会读取 workspace 下全部 Session、每行做尾查、在 router 内存排序并一次返回全部结果。需要 summary projection、cursor/limit 和稳定分页顺序。

### 测试结论

本轮新增 Core policy matrix、CLI 非法 dsh workflow fail-fast、Web API 非法 provider/mode/template/profile 组合，并通过既有 Core、CLI、Web、Playwright 全量回归。

仍缺：高级表单 Goal/dsh 状态切换的专门 Playwright、真实 dsh SDK/ACP E2E、长事件历史基准、跨进程 shutdown/late-write 故障注入。

---

## 8. 过度实现与过度设计

当前已有 Profile policy、Automation/readiness listener、Goal、LegacyAgentDriver/AgentHandle 契约、dual-write、DSH headless ACL、Web/CLI 两套 composition root，但持续协作最小闭环仍缺失。

**判断**：局部代码普遍有类型、注释和测试，主要问题不是“每个模块写得差”，而是系统组合复杂度领先于用户价值。下一里程碑应冻结不能直接服务 Collaborate vertical slice 的横向扩展。

PR 已积累多轮权威报告、批注和超长 CHANGELOG，导致当前裁决入口不唯一、旧引用反复修订、文档本身持续触发全栈 CI。本轮新增 `docs/reviews/current.md` 作为稳定入口；后续只维护 current decision record 与简短 revision log，CHANGELOG 聚焦用户可见行为。

---

## 9. 本轮实际修改

提交：`3b26d88852ceb78291ff85d407fc221dd9b48f20`

| 文件/区域 | 修改 |
| --- | --- |
| Core run-mode policy | 定义 Goal、template、profile、dsh-headless 的不可兼容组合。 |
| CLI `run` | 在创建 Workflow/Session/Job 前 fail-fast。 |
| Web API | 新增小型 project router 包装层，token 后执行共享策略。 |
| 高级 StartRunForm | 显式 Workflow/Goal；dsh 自动切 Goal；禁用不适用字段并显示风险说明。 |
| Tests | Core、CLI、Web API 三层回归。 |

本轮不再扩写 CHANGELOG，也不重复 bump `0.16.0`。

---

## 10. 未关闭问题清单

### P0

1. `P0-ARCH-01`：Web/CLI multi-owner，缺 single Runtime authority 或全副作用 fencing。
2. `P0-ARCH-02`：shutdown 非 quiescent。
3. `P0-ARCH-03`：Session Event 非权威事实链 / durable inbox。
4. `P0-PRODUCT-01`：Collaborate、真实 streaming、follow-up/steer/resume 缺失。

### P1

1. `P1-PRODUCT-02`：Deliver 启动前缺 run plan 和成本/权限/网络预览。
2. `P1-UX-01`：无 workspace 级实时任务流。
3. `P1-UX-02`：失败任务无 acknowledge/archive/unread。
4. `P1-UX-03`：Token 常驻字符串控件。
5. `P1-UX-04`：中英混杂与工程术语进入主路径。
6. `P1-UX-05`：长 Session 数据与 DOM 无界。
7. `P1-DATA-01`：Session 子表无外键/孤儿策略。
8. `P1-CODE-02`：Session 列表无 cursor/summary projection。
9. `P1-ARCH-04`：DSH 长期接口仍是旧 headless one-shot，应评估 SDK/ACP。
10. `P1-SEC-01`：dsh unrestricted-network acknowledgement 未成为显式用户确认。

### P2

1. `P2-PROCESS-01`：多轮报告和 CHANGELOG 维护成本膨胀。
2. `P2-TEST-01`：高级 Goal/dsh UI 缺专门浏览器断言。
3. `P2-TEST-02`：缺跨进程、长历史、真实 Provider 与故障注入矩阵。

---

## 11. 推荐实施顺序

### A. Runtime authority

1. repo single-owner daemon + lock；
2. CLI/Web 客户端化；
3. quiescent shutdown；
4. kill/restart/late-write 故障注入。

### B. Collaborate vertical slice

1. 选择 DSH SDK/ACP 或一个真实 Provider 的 execution-time streaming；
2. 权威 Session log + durable inbox + claim/idempotency；
3. follow-up、steer、cancel、resume；
4. 浏览器刷新和进程重启恢复；
5. 一条真实 Provider E2E。

### C. Collaborate → Deliver

1. 明确模式升级；
2. run plan、角色、Gate、权限、网络和成本影响因素预览；
3. 接入既有 Artifact/Gate/Delivery；
4. 可靠 link/outbox 连接对话域与治理域。

### D. Scale and polish

1. Session summary projection、cursor 和 workspace stream；
2. ack/unread/changedSinceSeen；
3. turn 导航、虚拟化、摘要与 context pressure；
4. Token 连接 UI、产品词汇表和可访问性专项；
5. Session 子表引用完整性迁移。

---

## 12. 验收结论

### PR / 代码合并门

- 用户最新轻量尾事件读取：**通过**；
- 本轮 run-mode / dsh-headless 产品合同修复：**通过**；
- Core #279：**success**；
- CI #188：**success**；
- 最新增量是否引入阻断回归：**未发现**。

### 产品验收门

- [x] 默认入口可发现，并诚实区分受控交付与一次性 Goal；
- [x] dsh-headless 不再从 Web/CLI 进入不可能成功的 workflow；
- [x] Session 列表可按人工行动优先级组织并显示活动时间；
- [ ] 当前 Session 可继续输入、转向并在重启后恢复；
- [ ] Provider 输出为执行期真实流；
- [ ] Collaborate 与 Deliver 是行为不同且可升级的明确轨道；
- [ ] 一个 repo 有单一 Runtime owner，或全部副作用有持久 fencing；
- [ ] shutdown 可证明无在途执行和 late write；
- [ ] 对话事实有权威 log / durable inbox；
- [ ] 长 Session 数据和 DOM 有界；
- [ ] DSH 接口重新对齐 SDK/ACP 与官方 Safety；
- [ ] 产品验收 gate 与 CI/merge gate 真正分离。

# 最终裁决

**本 PR 的最新代码和报告可以继续合并审阅；Tekon 仍不通过面向普通人的稳定研发工作台验收。**

允许的成熟度表述是：

> Tekon 已形成测试较强、边界逐步诚实的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、quiescent shutdown 和权威 Session 事实链。

本 PR 的合并不得被解释为上述 P0/P1 已自动关闭。

---

## 13. 实施方视角批注（第四轮）

> 本节为实施方对第四轮报告的评估与处置记录。评估方法：5 个 explorer groundtruth 核验 + 5 个 reviewer（最高思考等级）对抗验证（其中 P1-SEC-01 对抗验证因 API 错误重试一次），逐项达成处置共识。批注依 P2-PROCESS-01 从简。

### 13.1 作者 3b26d88 run-mode policy：核验通过（already-fixed）

报告 §1/§5.2/§7/§9 所述作者修复经独立核验全部落地且无回归：

- `run-mode-policy.ts:18-37`：`getRunModePolicyIssue` 纯函数覆盖 3 条不可兼容组合（goal+template、goal+autonomous-delivery、dsh-headless+workflow），无遗漏；
- CLI `run.ts:123-134`：policy 检查严格先于 `assertCleanBase`（134 行）与 `sessionService.startRun`（141 行），无 Session/Job/Workflow 副作用；`--dynamic` 在 112 行早返，无绕过路径；
- Web API `project-with-run-mode-policy.ts:21-27`：先 `assertSessionToken` 再策略校验，保持 auth-before-validation；`input.agent` 默认 `'codex'` 与 base router 一致；`ProjectRunInput.mode` 早在基线 `300aea6` 已存在于 `context.ts:67`；
- `StartRunForm.tsx:101-120,142-146`：`handleModeChange`/`handleAgentChange` 状态机完备（dsh→goal 自动切换、goal→workflow 回退 codex、goal 禁用 template/profile），`handleStart` 双重守卫；
- 三层测试（Core policy matrix、CLI fail-fast、Web API 非法组合）均为真实集成断言，非 mock-only。

裁决：already-fixed，无需补充。

### 13.2 P1-DATA-01（Session 子表无外键）：整体 ADR 递延 + 注释本轮勘误

报告 §3/§7 所述 FK 缺失事实核验属实：`session_events.session_id`、`jobs.session_id`、`projection_checkpoints.session_id` 均无外键（`migrations.ts:196,213,227`），`appendEvent` 不查 Session 存在性。整体修复需 SQLite 表重建迁移 + 孤儿策略 + 老库升级验证 + 测试 fixture 重构（`migrations.test.ts:115-117` 直接写孤儿子表），规模大，报告排入 §11-D 合理，递延成立。

本轮勘误：报告 §3 指出我在第三轮给 `getLatestEventTimestamp` 写的接口注释称"Session 不存在时返回 null"，但 DB 无 FK，真实语义是"无匹配事件行时返回 null"。已修正 `session-store.ts:89-95` JSDoc 为"Null when no matching event rows exist for the given sessionId"，并注明 P1-DATA-01 引用。零代码行为变化。

### 13.3 P1-SEC-01（dsh 网络不受限未显式确认）：ADR 递延

报告 §4.3/§10 建议将 unrestricted-network 变为显式确认。经对抗验证强化论证：

- **纯 Web checkbox 是剧场不是安全**：本仓既定模式是客户端引导必须镜像服务端权威边界（`allowDirtyBase` 有服务端 honoring），而 dsh ack 在服务端无任何对应物（RPC schema 无字段、wrapper 不校验、core 硬编码 `acknowledgeUnrestrictedNetwork: true`）。只在客户端禁用提交按钮将是全表单第一个无服务端执行的控件，制造"已获同意"假象。
- **真实修复 = 完整契约**：RPC 字段 + wrapper 校验 + core config 默认改 false + snapshot round-trip + CLI 侧 + 四层测试，~80-120 行，是 provider snapshot 语义变更。
- **CLI 是 dsh 主使用面却零交互确认基础设施**（全包无 readline/inquirer），非交互 CI 语境下"显式确认"没有诚实的轻量形式。
- **自然归宿是阶段 B/C**：§11-B 安排 DSH SDK/ACP 评估，§11-C 安排 run plan 网络/权限预览——网络风险同意应与权限/成本预览一起呈现。

当前披露（手册 §5.7"使用前必读"+"选用即接受"）+ 多层既有控制（版本钉死 fail-closed、capability guard、手动安装、API key、Goal-only 限制）使残余风险可接受地递延。

### 13.4 P2-TEST-01（Goal/dsh UI 缺浏览器断言）：本轮修复

报告 §2/§7/§10 明确列为 P2 测试补强项。本轮新增 `packages/web/__tests__/e2e/start-run-form.test.ts`（~60 行），覆盖三组纯前端状态联动：

- (a) 选 dsh-headless → mode 自动切 goal、template/profile 禁用、帮助文案显示约束；
- (b) 切回 workflow → agent 回退 codex、template/profile 恢复启用；
- (c) 直接切 goal（非 dsh agent）→ template/profile 禁用、agent 保持不变。

测试不启动真实 run，确定性高（React useState 同步更新，无网络竞争），执行 < 2s。

### 13.5 其余 P0/P1/P2：无新事实，递延成立

自第三轮（ecc1f74）以来仅 2 个提交（3b26d88 run-mode policy + bec0bed 报告/current.md），未触碰 job-runner/dual-write/session-store 底层。P0-ARCH-01/02/03、P0-PRODUCT-01、P1-PRODUCT-02、P1-UX-01/02/03/04/05、P1-CODE-02、P1-ARCH-04、P2-TEST-02 代码状态与前三轮及第 4~14 轮一致。`docs/reviews/current.md` 正确落地 P2-PROCESS-01（稳定入口 + 简短 revision log）。

另：报告 §5.4 末条提及"高级新建运行的折叠标题仍是可点击 `div`，缺键盘按钮语义和 `aria-expanded`"——该 a11y 项在 §5.4 披露但未分配 P 级 ID、未进入 §10 未关闭清单，处于跟踪真空。本轮记录为 **P1-UX-06（折叠标题 a11y）**，随 §11-D 可访问性专项统一推进，不在本轮单独修复（pre-existing，非本轮回归）。

### 13.6 验证与版本

- `corepack pnpm -r typecheck`：3 包 Done；
- `corepack pnpm test`：1328 passed / 3 skipped（118 个测试文件）；
- Web Playwright e2e：29 passed（含新增 P2-TEST-01 测试）；
- 版本保持 `0.16.0`（复审 + 测试补强 + 注释勘误，不 bump）。
