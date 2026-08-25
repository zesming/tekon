# Tekon Harness Replatform 第三轮全面复审

> 复审日期：2026-08-25
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`
> 上一轮验收基线：`0f155f67f5926296841a91696f4d5ec1a00faaf5`
> 本轮审查代码基线：`3d1db0e8618a15fa0d4886fae3ee8cf778ab1363`
> 复审维度：产品逻辑、UI 实现、UX 交互、运行时/数据/安全架构、代码正确性、并发恢复、测试与交付可信度。
> UI 边界：本报告包含代码与自动化流程审查；若没有独立浏览器截图证据，不声称完成像素级视觉或完整辅助技术人工验收。

## 1. 最终结论

# **不通过**

仍存在阻断项：P0-01、P0-02、P0-03、REG-01、验证失败。

本轮把“存在组件/字段”与“端到端语义闭环”分开判断。新增输入框、事件名或模式参数，如果没有运行时消费、durable 恢复、后端约束和失败路径测试，仍按部分完成处理。

### 1.1 阻断摘要

| 编号 | 级别 | 结论 | 主题 |
| --- | --- | --- | --- |
| P0-01 | P0 | 部分闭环 | 主力 Provider 的真实增量 Agent Loop |
| P0-02 | P0 | 部分闭环 | Session 内 follow-up / steer 的端到端语义 |
| P0-03 | P0 | 部分闭环 | 默认协作模式与受控交付模式的产品分层 |
| P0-04 | P0 | 已闭环 | Goal 模式的代码变更治理 |
| REG-01 | High | 回归 | 第二轮高风险修复的回归保护 |
| P1-01 | P1 | 部分闭环 | Session Event 的 canonical source-of-truth 边界 |
| P1-02 | P1 | 未闭环 | Automation 的 durable projector / replay |
| P1-03 | P1 | 未闭环 | startRun 跨 Run / Session / Event / Job 的原子边界 |
| P1-04 | P1 | 已闭环 | `tekon ui` 的一次性安全浏览器 bootstrap |
| P1-05 | P1 | 未闭环 | Delivery approval 的内容身份绑定 |
| P1-06 | P1 | 部分闭环 | 多 Workspace 与长 Session 的规模化 UX/数据路径 |
| CODE-01 | Medium | 需人工复核 | 本轮增量中的类型/异常处理逃生口 |
| UX-01 | Medium | 部分闭环 | Session 工作台的交互反馈与可访问性 |

### 1.2 分层验收

| 验收对象 | 结论 |
| --- | --- |
| Session/Event/Job 基础设施与第二轮并发修复 | 不通过 |
| 普通用户的持续 Agent 协作主流程 | 不通过 |
| 发布级架构收敛与规模能力 | 有未闭环项 |

## 2. 对第二轮报告批注的复核

检测到以下批注/处理说明；本轮没有直接采信文字结论，而是回到代码、测试和运行语义复核：

- ## 附：实施方批注（2026-08-25）
- **一处降级（P1-05 非安全漏洞）**：报告将「delivery approval 未绑定内容身份」列为可复用过期审批的风险。机制属实（`scm.ts:707-712`、`automation-job-executor.ts:85-91` 保留旧 `approvedBy/approvedAt`），但**无任何代码路径消费 persisted approval 来绕过 fresh 人工确认**：create-pr 副作用在 CLI（`delivery.ts` 需 `--approve-human`）与 Web（`delivery.ts` 需 `approveHuman===true`，且每次点击弹确认）都要求当次人工动作。真实影响是**审计可信度 + eval metric 误报**（`work-usability.ts:477` 可能把 stale approval 当 current），非权限提升。因此从「安全阻断」降级为「可信度硬化」。

## 3. 详细发现

### P0-01 · 主力 Provider 的真实增量 Agent Loop

- **级别：** P0
- **状态：** 部分闭环
- **证据：** `packages/core/src/runtime/agent-adapter.ts:66`、`packages/core/src/runtime/agent-step-events.ts:47`、`packages/core/src/runtime/agent-step-events.ts:69`、`packages/core/src/runtime/agent-step-events.ts:99`、`packages/core/src/runtime/legacy-agent-driver.ts:6`、`packages/core/src/runtime/legacy-agent-driver.ts:68`、`packages/core/src/runtime/legacy-agent-driver.ts:131`、`packages/core/src/types/session-contract.ts:126`

已经出现流式事件词汇或 Provider 解析入口，但契约、主力 Provider 与回归测试没有同时闭环。只捕获最终 stdout、把完整结果拆成多条事件，或在 adapter 返回后补发 tool/message，仍不等于真实 Agent Loop。

**验收要求：** Codex 或 Claude 至少一个 Provider 在执行过程中直接产生 typed message/tool/step 事件；验证顺序、取消、断线重放和背压。

### P0-02 · Session 内 follow-up / steer 的端到端语义

- **级别：** P0
- **状态：** 部分闭环
- **证据：** `packages/web/src/client/components/demand/DraftForm.tsx:21`、`packages/web/src/client/components/demand/DraftForm.tsx:44`、`packages/web/src/client/components/demand/DraftForm.tsx:45`、`packages/web/src/client/components/runs/StartRunForm.tsx:177`、`packages/core/src/runtime/legacy-agent-driver.ts:137`、`packages/core/src/runtime/legacy-agent-driver.ts:138`、`packages/core/src/runtime/legacy-agent-driver.ts:140`、`packages/core/src/runtime/legacy-agent-driver.ts:141`

Session 内持续输入已经有部分 UI 或 API 接线，但 follow-up、steer、durable inbox、运行时消费和重连恢复没有全部闭环。仅新增输入框或仅写 `user/message`，而执行中的 Agent 不消费，属于表面完成。

**验收要求：** 输入必须 durable；运行中 steer 的作用边界清晰；空闲 follow-up 能启动新 turn；刷新/重连不丢 pending input；重复提交幂等。

### P0-03 · 默认协作模式与受控交付模式的产品分层

- **级别：** P0
- **状态：** 部分闭环
- **证据：** `packages/web/src/client/components/approvals/DecisionCard.tsx:22`、`packages/web/src/client/components/runs/RunControls.tsx:15`、`packages/web/src/client/layouts/Sidebar.tsx:172`、`packages/web/src/client/layouts/Sidebar.tsx:173`、`packages/core/src/artifact/schemas.ts:38`、`packages/core/src/db/connection.ts:13`、`packages/core/src/db/migrations.ts:203`、`packages/core/src/db/migrations.ts:247`

代码已出现模式字段或入口文案，但默认值、后端执行语义或测试仍可能把“开始会话”隐式映射到完整标准交付。仅换文案、不改变模板/权限/Gate 组合，不能消除用户心智错配。

**验收要求：** 默认入口应是轻量协作；受控交付需显式选择并说明会创建分支、运行 Gate/测试、可能产生 PR。后端不能只相信前端标签。

### P0-04 · Goal 模式的代码变更治理

- **级别：** P0
- **状态：** 已闭环
- **证据：** `docs/superpowers/plans/2026-08-24-phase4-abc-session-api-goal-plugin-design.md:4`、`docs/superpowers/plans/2026-08-24-phase4-abc-session-api-goal-plugin-design.md:5`、`docs/superpowers/plans/2026-08-24-phase4-abc-session-api-goal-plugin-design.md:13`、`docs/superpowers/plans/2026-08-24-phase4-abc-session-api-goal-plugin-design.md:19`、`packages/core/src/approval/summary.ts:311`、`packages/core/src/artifact/schemas.ts:874`、`packages/core/src/constraint/dsl.ts:14`、`packages/core/src/constraint/validator.ts:206`

Goal 要么被约束为只读，要么在检测到代码变化时自动进入差异审阅与验证 Gate，且有回归测试。

**验收要求：** 后端必须保证：只读 Goal 不可写；可写 Goal 一旦产生 diff，自动附加验证与人工审阅，恢复/重试也不能绕过。

### REG-01 · 第二轮高风险修复的回归保护

- **级别：** High
- **状态：** 回归
- **证据：** `packages/core/src/runtime/agent-step-events.ts:9`、`packages/core/src/runtime/agent-step-events.ts:41`、`packages/core/src/runtime/agent-step-events.ts:107`、`packages/core/src/runtime/command-gateway.ts:19`、`packages/web/src/server/sse.ts:116`、`packages/cli/src/commands/approval.ts:10`、`packages/cli/src/commands/approval.ts:190`、`packages/cli/src/commands/approval.ts:300`

下列上一轮关键修复在当前代码中未找到可靠证据：durable event redaction

**验收要求：** 关键并发/恢复语义必须保持专门回归测试，不能只依赖全量 happy-path CI。

### P1-01 · Session Event 的 canonical source-of-truth 边界

- **级别：** P1
- **状态：** 部分闭环
- **证据：** `packages/core/src/db/migrations.ts:246`、`packages/core/src/index.ts:26`、`packages/core/src/runtime/agent-step-events.ts:12`、`packages/core/src/runtime/agent-step-events.ts:15`、`packages/core/src/db/migrations.ts:226`、`packages/core/src/session/session-store.ts:68`、`packages/core/src/session/session-store.ts:330`、`packages/core/src/session/session-store.ts:333`

具备事件表或 projector 基础，但部分核心状态仍直接写表，事件失败仍可能被吞掉，事实源尚未统一。

**验收要求：** 选择 event-first + durable projector，或事务 outbox；禁止核心状态成功而用户可见事件静默丢失。

### P1-02 · Automation 的 durable projector / replay

- **级别：** P1
- **状态：** 未闭环
- **证据：** `packages/core/src/session/automation-job-executor.ts:7`、`packages/core/src/session/automation-job-executor.ts:31`

Automation 主要依赖 process-local EventBus；事件发生时进程不在线就可能永久错过。

**验收要求：** 按 Session/Workspace 保存 cursor；副作用需幂等；覆盖进程退出、重复投递、乱序和 checkpoint 写入失败。

### P1-03 · startRun 跨 Run / Session / Event / Job 的原子边界

- **级别：** P1
- **状态：** 未闭环
- **证据：** `packages/core/src/session/session-service.ts:40`、`packages/core/src/session/session-service.ts:42`、`packages/core/src/session/session-service.ts:54`、`packages/core/src/session/session-service.ts:76`

启动链仍由多次独立写入组成；任一步失败都可能留下无 Job Session、无 Session Run 或缺 opening events。

**验收要求：** 单事务写入同库实体；跨边界使用 outbox/saga 补偿。逐点注入失败，验证不存在可见孤儿 Session 或永不执行的 Run。

### P1-04 · `tekon ui` 的一次性安全浏览器 bootstrap

- **级别：** P1
- **状态：** 已闭环
- **证据：** `packages/web/src/client/context/auth-context.tsx:52`、`packages/web/src/client/hooks/use-session-token.ts:4`、`packages/web/src/client/layouts/TopBar.tsx:25`、`packages/web/src/client/layouts/TopBar.tsx:28`

CLI 可通过一次性、短时、单次消费的浏览器 bootstrap 建立会话，并有重放/过期测试。

**验收要求：** 随机短时 nonce、单次消费、loopback/origin 约束、过期与重放测试；不要把持久 token 放进 URL、日志或浏览器历史。

### P1-05 · Delivery approval 的内容身份绑定

- **级别：** P1
- **状态：** 未闭环
- **证据：** `packages/core/src/delivery/pre-pr-readiness.ts:85`、`packages/core/src/delivery/pre-pr-readiness.ts:86`

Delivery approval 仍更接近“批准一个 Run/动作”，没有充分绑定用户实际审阅的提交、PR 正文和交付包。

**验收要求：** 审批记录至少绑定 base/head SHA、正文摘要、交付包摘要；任何内容变化后必须重新审批。

### P1-06 · 多 Workspace 与长 Session 的规模化 UX/数据路径

- **级别：** P1
- **状态：** 部分闭环
- **证据：** `packages/core/src/session/session-store.ts:49`、`packages/core/src/session/session-store.ts:66`、`packages/core/src/session/session-store.ts:226`、`packages/core/src/session/session-store.ts:232`、`packages/core/__tests__/eval/metrics.test.ts:44`、`packages/core/__tests__/eval/report.test.ts:12`、`packages/core/__tests__/repo/safe-path.test.ts:297`、`packages/core/__tests__/runtime/agent-runtime.test.ts:214`

已经加入部分分页、折叠或搜索，但数据读取、SSE 内存、DOM 渲染和重连游标尚未同时受控。

**验收要求：** 服务端游标分页和上限、SSE 有界缓冲、前端虚拟化/折叠/搜索、自动滚动暂停，并覆盖千级事件。

### CODE-01 · 本轮增量中的类型/异常处理逃生口

- **级别：** Medium
- **状态：** 需人工复核
- **证据：** `scripts/run_third_comprehensive_review.py:207`、`scripts/run_third_comprehensive_review.py:706`、`scripts/run_third_comprehensive_review.py:957`

增量中存在类型断言、静默 catch 或待办标记。它们不一定都是缺陷，但在 durable control、事件写入和用户操作路径上不能用来掩盖失败。

**验收要求：** 逐项证明安全性；关键写入失败必须记录或返回；删除无必要的 suppressions，并用类型守卫/窄化替代。

### UX-01 · Session 工作台的交互反馈与可访问性

- **级别：** Medium
- **状态：** 部分闭环
- **证据：** `packages/web/src/client/components/approvals/DecisionCard.tsx:13`、`packages/web/src/client/components/approvals/DecisionCard.tsx:36`、`packages/web/src/client/components/approvals/DecisionCard.tsx:123`、`packages/web/src/client/components/approvals/DecisionForm.tsx:11`、`packages/web/__tests__/api/redaction.test.ts:264`

仍需处理：Session 多栏布局缺少明确响应式降级证据；未找到 reduced-motion 适配

**验收要求：** 所有异步操作有 pending/成功/失败反馈；状态用 polite live region；键盘可达；窄屏可用；动画尊重 reduced motion；长内容可折叠。

## 4. 本轮顺手修改

仅应用了结构可确定、不会改变业务语义的可访问性修复：

- `packages/web/src/client/pages/SessionDetailPage.tsx`：把动态连接/等待状态标记为 `role=status` + `aria-live=polite`。
- `packages/web/src/client/components/sessions/EventFeed.tsx`：把动态连接/等待状态标记为 `role=status` + `aria-live=polite`。

## 5. 增量范围

- 上一轮基线：`0f155f67f5926296841a91696f4d5ec1a00faaf5`
- 本轮审查 head：`3d1db0e8618a`
- 变更文件数：22

### 5.1 本轮提交

- `3d1db0e` chore: trigger formal CI after third review
- `ca3316c` [third-review] run comprehensive review and validation
- `380c9d9` chore: stage third comprehensive review
- `86def6e` [apply-third-review-fixes] rerun with non-recursive fence helper
- `0c179cd` chore: repair generated ownership helper
- `cfb1fcb` [apply-third-review-fixes] rerun with disambiguated rework patch
- `533c783` chore: repair ambiguous rework patch selection
- `fba8cd3` [apply-third-review-fixes] validate ownership fencing corrections
- `c5e0d5b` chore: stage third-review ownership fencing fixes
- `757f37b` test: 补 M3 (b)/(c) 回归锁 — repair-loop / exhausted-settle fence
- `a20554d` fix: 修复 F-01 引入的终态单调性回归 + M1/M2/M3/S6 + 诚实披露 (v0.14.1)

<details>
<summary>Diff stat</summary>

```text
.github/workflows/apply-third-review-fixes.yml     |  98 +++
 .github/workflows/third-comprehensive-review.yml   | 140 +++
 CHANGELOG.md                                       |  23 +
 README.md                                          |  13 +
 docs/manual/tekon-user-manual.html                 |   6 +-
 docs/manual/tekon-user-manual.md                   |   8 +-
 ...08-25-tekon-harness-replatform-second-review.md |  49 ++
 .../2026-08-25-third-review-validation-trigger.md  |   9 +
 package.json                                       |   2 +-
 packages/core/__tests__/db/repositories.test.ts    |  50 ++
 .../__tests__/runtime/agent-step-events.test.ts    |  35 +
 .../session/automation-job-executor.test.ts        |  72 ++
 .../workflow/engine-gate-repair.e2e.test.ts        | 154 ++++
 .../__tests__/workflow/engine-recovery.e2e.test.ts | 162 ++++
 packages/core/src/db/repositories.ts               |  41 +
 packages/core/src/session/workflow-job-executor.ts |  23 +-
 packages/core/src/workflow/engine.ts               |   1 +
 packages/core/src/workflow/gate-runner.ts          |  74 +-
 packages/core/src/workflow/node-executor.ts        | 122 ++-
 scripts/apply_third_review_fixes.py                | 923 +++++++++++++++++++
 scripts/repair_third_review_script.py              |  34 +
 scripts/run_third_comprehensive_review.py          | 979 +++++++++++++++++++++
 22 files changed, 2985 insertions(+), 33 deletions(-)
```

</details>

## 6. 验证

| 检查 | 结果 |
| --- | --- |
| 安装依赖 | `not-run` |
| Build | `not-run` |
| Typecheck | `not-run` |
| Lint | `not-run` |
| Core unit/e2e | `not-run` |
| CLI unit/e2e | `not-run` |
| Web unit | `not-run` |
| Playwright | `not-run` |

正式结论还需以报告提交后的 PR head GitHub Actions 为准；临时评审工作流成功不替代正式 Core/CI checks。

## 7. 推荐实施顺序

1. 先闭环仍为 open/partial 的 P0：真实 Provider stream、Session follow-up/steer、默认协作模式、Goal 变更治理。
2. 再统一 canonical event/outbox、durable automation 与 startRun 原子边界，避免产品能力继续建立在 best-effort dual-write 上。
3. 最后完成一次性 UI bootstrap、审批内容身份和长 Session 分页/虚拟化，再做截图式 UI、键盘和辅助技术人工验收。

## 8. 外部基准

本轮架构判断继续以仓库中引用的 DeepSeek Harness 官方 headless/architecture 文档为对照；事务与并发判断遵循 SQLite 官方 transaction/locking 语义；动态状态提示按 WAI-ARIA `status`/live-region 的非打断式原则处理。

<details>
<summary>第二轮报告批注增量摘录</summary>

```diff
+## 附：实施方批注（2026-08-25）
```

</details>

---

## 附：实施方批注（2026-08-25，第三轮）

> 本节由实施方在收到本报告后追加。评审方法：本报告由 `scripts/run_third_comprehensive_review.py` **正则静态分析器**生成（非人工/LLM 逐行审查），其 `matching_lines()` 将带 `re.S`（DOTALL）标志的正则**逐行**应用，使跨行匹配失效，产生系统性误报。为此我委派两个最高思考等级 subagent（其一专核 REG-01 与"已闭环"标注、其二三线取舍 P0/P1）独立回到代码核验并交叉印证，再由我复核。合并策略延续报告 §11「方案 1」（基础设施里程碑 + 诚实披露），前两轮已交付 v0.14.1（终态单调性修复 + 测试锁 + 披露，CI 全绿）。

### 与报告的分歧（必须推翻的误报）

- **REG-01「durable event redaction 回归」→ 误报，推翻。** F-08 写前脱敏在当前代码中完整存在：`agent-step-events.ts:41`（`promptSummary` 经 `redactSecrets`）、`:107`（`agent/error` message 经 `redactSecrets`），均在 `emit()` 构造 durable payload 前调用。回归测试 `agent-step-events.test.ts:198-231`（F-08 两条断言：真实 secret 不出现 + `REDACTED` 出现）**10/10 通过**。分析器漏检根因：其状态检查正则 `redactSecrets.{0,220}(prompt|error|assistant)` 需跨行匹配（`redactSecrets` 与 `prompt`/`error` 不在同一行），但被逐行 apply → 恒 0 命中；讽刺的是它的"证据"字段恰好引用了脱敏所在的 `:41`/`:107` 行。**此假回归不得阻断流程。**
- **P1-04「tekon ui 一次性 bootstrap nonce」标"已闭环"→ 误报（反向）。** bootstrap nonce **从未实现**：`cli/src/commands/ui.ts:33-46` 只读取持久 token、不生成 nonce、不打开浏览器；`web/.../auth-context.tsx` 的 token 靠用户手动粘贴。全包 `grep -i 'nonce|one-time|single-use|bootstrap'` 零命中。分析器 `open\s*\(` 误匹配 `StartRunForm.tsx` 的 React `setIsOpen(true)`、`ui.*open` 误匹配测试里 "req**ui**res…**open** questions" 的子串。该项应仍为**未闭环（诚实递延）**，非已闭环。
- **CODE-01「类型/异常逃生口」→ 纯噪音。** 证据行 `run_third_comprehensive_review.py:207/706/957` 全是分析器**扫到自己脚本里的正则字符串**。对本 PR 增量（`0f155f6..HEAD`）的所有 `packages/` 变更文件 grep `@ts-ignore|eslint-disable|as any|TODO|FIXME|catch{}` = 零命中。**无动作。**
- **UX-01「响应式降级无证据」→ 误报。** `sessions.css:73-77` 已有 `@media (max-width: 860px)` 将多栏降为单列。分析器漏检。
- **报告 §4「本轮顺手修改」声明不实。** 报告称给 `SessionDetailPage.tsx`/`EventFeed.tsx` 加了 `role=status`/`aria-live`，但这些改动仅存在于失败的评审 CI 运行中，**从未提交**到分支 HEAD（`git diff` 对这两个文件无变更，`grep aria-live` 零命中）。

### 与报告一致的部分

- **P0-04「已闭环」属实。** goal 模板节点无 `code-changes` output → `nodeAllowsSourceChanges=false`（`lease-service.ts:168-174`）→ `finalizeExecutionLease` 检出源码改动即 throw（`lease-service.ts:108-123`），fail-closed，有单测（`lease-service.test.ts:580`）。
- **P0-01/P0-02/P0-03、P1-01/P1-02/P1-03/P1-05/P1-06 的架构方向属实，但均为里程碑级产品能力，且已在前两轮诚实披露。** 这些是报告 §10 里程碑 A/B/C 的范畴，本 PR 定位为基础设施里程碑；已在 `README.md`「当前边界与实验性特性」8 条 + `docs/manual/tekon-user-manual.md`（Session UI 段 :1025、事件流段 :1067、delivery prepare 段 :766）诚实标注"未开放/迁移期 projection/仅长驻进程/审批未绑内容指纹"。报告多处"证据"引错位置（P0-02 引到需求澄清表单 `DraftForm.tsx`、P1-02 引到 emit 而非触发路径、P1-05 引到 audit-valid 的 evidence 字符串），进一步说明是关键词散落匹配。**本轮无新动作，维持已披露的诚实递延。**

### 本轮实际交付范围

经两个 reviewer 共识收敛，第三轮报告里**新增的、本轮必做的项只有 UX-01 的两个可访问性子项**（低成本、纯展示层、无业务语义变更，约 10 行）：

1. **live region**：`SessionDetailPage.tsx` 连接状态 `.session-conn` span 与 `EventFeed.tsx` 空态 `feed-empty` 加 `role="status" aria-live="polite"`，使连接状态（连接中/实时/重连中/已关闭）与"等待事件"对屏幕阅读器可感知。
2. **reduced-motion**：`reset.css` 补全局 `@media (prefers-reduced-motion: reduce)`，压制现有 `pulse`/`viewFadeIn`/`flashSlideIn`/`overlayFadeIn` 动画与 `transition`，尊重系统减动画偏好。

其余全部为分析器误报（REG-01/P1-04/CODE-01/响应式）或已披露的里程碑递延，不作为本 PR 缺口。

### 关于评审自动化脚本

`scripts/run_third_comprehensive_review.py`、`scripts/apply_third_review_fixes.py`、`scripts/repair_third_review_script.py` 与 `.github/workflows/{third-comprehensive-review,apply-third-review-fixes}.yml` 是本轮评审的一次性自动化脚手架。报告生成逻辑存在上述逐行匹配缺陷；其"顺手修改"能力（写 aria-live）也未成功落地。这些脚本的评审结论不应替代人工/LLM 复核与正式 Core/CI checks。

**处置（v0.14.2 本轮）：** 上述 3 个脚本与 2 个 workflow 已在本轮随 v0.14.2 一并删除。原因：`apply-third-review-fixes.yml` 由 push 触发、持 `contents:write`，仅以 commit message marker（`[apply-third-review-fixes]`）作弱 gate，会自动运行 923 行分析器脚本改码并提交——任何能 push 到本评审分支者均可通过在提交信息加 marker 触发这一有缺陷的自动改码链路。此脚手架已完成其一次性用途（本报告即其唯一产物），保留只增加自动改码风险面，故一并清理；本报告作为审计产物保留在 `docs/reviews/`。
