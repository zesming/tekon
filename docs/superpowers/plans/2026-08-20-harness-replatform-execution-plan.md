# Tekon Harness-inspired Replatform 总体执行方案

> 关联报告：`docs/reviews/2026-08-20-tekon-human-usability-and-deepseek-harness-migration-review.md`
> 分支：`review/deepseek-harness-migration-2026-08-20`（在 PR#10 上迭代）
> 起草日期：2026-08-20
> 状态：**已过一轮 reviewer 评审（M1–M4 已整合）+ 维护方对抗自检，无剩余必修项；待用户确认后启动阶段 0**

> 评审记录：一号 reviewer 提出 M1（阶段 0 显式纳入 CLI flaky 修复）、M2（传输层脱敏前移至阶段 1 随 SSE 落地，避免安全空窗）、M3（§4.1 golden journey 转绿阶段表，防 skipped 废弃）、M4（阶段 2 补 provider snapshot/version contract），均已整合。runtime 限制说明见文末附注。

## 0. 目的与范围

本方案把 PR#10 报告 §10 的六阶段迁移、§12 立即修复清单、§13 验收标准，落成一份可执行、可分阶段验收的工程计划。

用户决策：**按完整报告方向推进**（含 Session/Event/Agent Loop/Capability/Profile 模式迁移与 human-first Web，Harness 通过稳定边界选择性接入），必要时用 workflow 并行。

**报告自身约束（§10/§11）必须遵守**：分阶段、每阶段可运行、旧引擎不删除、新旧双轨并存、golden journey 驱动、防止"范围失控→半成品"。因此本方案 = 同一分支上按阶段推进，而非单次巨型改动。

## 1. 不可动摇的约束（贯穿所有阶段）

来自 CLAUDE.md 与报告 §11 风险缓解，任何阶段都不得违反：

- **C1 治理不退化**：Gate、人工审批、PR 人工批准、audit 哈希链在迁移后语义不变。inline 展示 ≠ 取消规则。未批准 shaped demand 不得经任何路径运行（报告 §13.8）。
- **C2 autonomy-first 不丢**：现有 Workflow/Gate/Artifact/Delivery/Worktree 自举链路在 autonomous profile 下持续可用（§13.11）；不因引入 human-first 而破坏 headless 自举。
- **C3 双轨并存**：新增 Session/Event 层对现有表 **dual-write**，不删旧引擎；每阶段结束时全项目 e2e 必须绿。
- **C4 测试先行**：每个功能/修复先写或更新测试，提交前 `pnpm test` 全绿；新增 CLI/Web 行为必须补 e2e。
- **C5 安全**：实时输出 server-side 脱敏、限长、spill；不下发 token；不提交密钥。
- **C6 版本与文档**：按变更级别 bump `package.json` version；同步 README/CHANGELOG/用户手册/AGENTS.md。

## 2. 每阶段统一闭环流程（用户三要求的落地）

每个阶段严格执行以下 7 步，未过前一步不进下一步：

1. **阶段方案**：细化该阶段的接口、schema、文件级改动清单、测试清单、验收标准。
2. **reviewer 评审方案**（最高思考等级）：达成一致（无必须修复项）才动代码。
3. **测试先行 + 开发**：先写/改测试，再实现。
4. **阶段 e2e**：该阶段涉及包的 `test:unit` + `test:e2e` 全绿；不破坏既有测试。
5. **reviewer code review**：对代码与测试审查；提出的必修项全部修复后，再复查到无必修项。
6. **阶段验收**：对照该阶段交付物与报告验收标准逐条核对。
7. **提交**：commit 到 PR 分支（阶段性），bump version，同步文档。

**最终**（全部阶段后）：全项目全功能点 e2e 验收（core+cli+web+playwright）→ reviewer 按报告整体审核 → 无必修项 → PR ready。

## 3. 基线（改动前，已实测 2026-08-20）

| 套件 | 基线结果 |
| --- | --- |
| `pnpm -r build` | ✅ |
| `pnpm -r typecheck` | ✅ |
| core unit | ✅ 59 files / 672 tests |
| core e2e | ✅ 7 files / 20 tests |
| **cli unit** | ❌ **4 failed / 34**（既有 flaky，main 上即存在，与本次改动无关） |
| web unit | ✅ 9 files / 148 tests |

**CLI 失败定性（已复现两次）**：
- 超时类：`release-flow.test.ts`、`cli-flow.test.ts`、`run-cli.test.ts > infers current repo...` 起真实子进程跑 init/run，在当前机器负载下 15–30s `testTimeout` 不足。
- 串扰类：`run-cli.test.ts > resolves explicit shape paths...` 与 `> does not approve historical draft shapes...` 报 `ENOENT chdir '/tmp/tekon-cli-unit-A/...' -> '/tmp/tekon-cli-unit-B/...'`——同一测试文件内多个用例共享**进程级 cwd**，并行/清理时互相删除对方临时目录。

**结论与处置**：这是改动前就存在的测试稳定性问题，不是产品代码 bug。但它直接阻断两件事——① 阶段 0 把 CLI 纳入 CI 会一接入就红；② 最终"全功能 e2e 通过"无法达成。因此**阶段 0 必须先把 CLI 测试修稳**（cwd 用例隔离 + 按机器负载提高/去掉 e2e 超时），作为 CI 补齐的前置。修稳以"同一命令连续两次全绿"为准。

现状事实（已核查）：无 SSE/WebSocket 基础设施；`migrations.ts` 15 表无 session/turn/step/job；`agent-adapter.ts` 无 AbortSignal；`project.ts:181` 同步 await；`engine.ts:253` 类型欺骗；CI 仅 `core.yml`。

## 4. 阶段划分（对齐报告 §10）

### 阶段 0：契约冻结 + 验收流 + CI 补齐 + 与定位无关的纯修复（低风险，先行）
交付：
- **修稳 CLI 既有 flaky 测试**（基线已实测 4 failed）：`run-cli.test.ts` 的 cwd 用例隔离（每个用例独立 cwd/临时目录，不共享进程级 cwd）、真实子进程 e2e 的超时按机器负载调整；以"连续两次全绿"为准。这是 CI 纳入 CLI 的前置。
- **P1.1 Resume 覆盖 `blocked/interrupted`**（`RunControls.tsx`，当前仅 `paused` 显示 Resume）。
- **P1.2 修复 terminal "眼睛"按钮**（当前 `stopPropagation` 无导航行为）。
- **P1.3 Run 列表展示需求标题与人类状态**（`RunTable` 当前主要展示内部 ID）。
- **P1.4 Run Detail 展示真实 provider**（修复 `deriveAgent()` 固定返回）。**注（2026-08-21 复核）**：Run Detail 的「准确时长/时间」半句本阶段未随 provider 一并交付——当前仍用 Gate 时间近似（`RunDetailPage.tsx` earliestGate/latestGate），而运行时间真值在 `workflow_instances.created_at/updated_at`，surface schema 尚未暴露该字段。此半句显式改派**阶段 3**（Run Detail 由事件源时间戳重建时一并修正），不在阶段 0 范围。
- ADR：确定"模式迁移 + anti-corruption layer"，记录不绑定 Harness 私有 schema。**注（2026-08-21 复核）**：该决策已落在报告 §0.3 维护方处置决策 + 本方案 §0/§1（稳定边界接入、不绑私有 schema），无独立 ADR 文件；如需独立 ADR 载体可后续补建，不阻断阶段推进。
- Session/Event schema v1 草案（类型定义，不落库）。**已交付**：`packages/core/src/types/session-contract.ts`（Workspace/Session/SessionEvent/Job schema + 事件词汇 + AgentDriver/JobRunner/EventSubscription/Projection 接口签名，无实现），contract-freeze 测试 `packages/core/__tests__/types/session-contract.test.ts`（9 passed）锁定 schema 版本、必需事件核心、merge-extensible 兼容策略。
- AgentDriver / JobRunner / EventSubscription / Projection **接口签名**（TS interface，无实现）。**已随上条交付**。
- 5 条 golden journey 的 e2e 骨架。**调整**：§4.1 已固化各 journey 的"转绿阶段"表；按工程原则不预先写 skipped 空壳（死测试），改为在阶段 1-3 各 journey 真正可运行时同步落地真实 e2e，§4.1 表即其规格。
- 现有 Workflow/Gate/Delivery 的 contract test（锁定当前行为，防迁移回归）。**判断**：现有 core e2e（engine-template / engine-recovery / engine-gate-repair / engine-worktree / dynamic-constraint 等 20 项）已实质充当行为锁定的 contract test；阶段 0 不重复造同义测试（CLAUDE.md「无冗余」）。迁移各阶段若改动这些子系统，以这批既有 e2e 作为回归基线。
- **CI 覆盖 core+CLI+Web+Playwright**（报告 §12-P0.6/P1.8，独立高价值，本阶段落地）。
验收：CI 绿且覆盖三包；contract test 锁定旧行为；P1.1–P1.4 有对应单测/组件测试；不删旧引擎；不改动 core 运行时主路径。

#### 4.1 Golden journey e2e 激活计划（M3）

| Golden journey | API/集成级转绿阶段 | 浏览器级转绿阶段 |
| --- | --- | --- |
| 新任务（选 workspace→输入任务→启动） | 阶段 1（start 立即返回 + job） | 阶段 3 |
| 澄清（demand shape→approve→run） | 阶段 1（含 P0-03 审批强制） | 阶段 3 |
| 运行中纠偏（follow-up/steer） | 阶段 2（AgentDriver 能力） | 阶段 3 |
| inline approval（gate 人工批准） | 阶段 1（审批事件 + 强制） | 阶段 3 |
| 失败恢复 / PR（resume + delivery） | 阶段 1（lease/checkpoint/recovery） | 阶段 3 |

每条 journey 在其"API 级转绿阶段"必须有真实通过的自动化测试（非 skipped），并写入该阶段验收行；浏览器级在阶段 3 由 Playwright 覆盖。

### 阶段 1：Event Spine + 真实后台 Job + 修复 P0 语义
交付：
- 新表 `workspaces`/`sessions`/`session_events`/`jobs`/`projection_checkpoints`（migrations，dual-write 不动旧表结构）。
- `start` API 立即返回 session/job id（拆长 RPC → 后台 job runner）——修 **P0-01**。
- 现有 Workflow Engine 在 job runner 内后台执行；对 node/gate/artifact/audit **dual-write** 为 session_events。
- SSE（或 WebSocket）事件订阅端点。**传输层 server-side 脱敏/限长/spill 随 SSE 一并落地**（报告 §12-P0.5 第一段；旧输出路径同步加脱敏），避免实时通道上线时脱敏未就位形成安全回归窗口（C5）。
- lease / checkpoint / crash recovery。
- 真实 **AbortSignal + subprocess registry**，取消能终止 provider 子进程——修 **P0-02**。
- 修 pause/cancel/status transition + **状态机 validator**（报告 §12-P1.7）。
- **修 P0-03 审批绕过**（前端传 demandShapePath + 服务端强制，不靠客户端可选字段）。
- 移除 `as unknown as WorkflowEngineResult`（报告 §12-P1.6 类型欺骗）。
- RoleRun 对称 failed/interrupted API（报告 §12-P1.5）。
- golden journey「新任务 / 澄清 / inline approval / 失败恢复」API 级 e2e 转绿（见 §4.1）。
验收：报告 §13.2/§13.5/§13.8/§13.12 相关项；上述 4 条 journey API 级 e2e 真实通过；旧 e2e 仍绿。

### 阶段 2：流式 Agent Loop + 兼容适配器
交付：
- 新 `AgentDriver`（events/followUp/steer/pause/cancel/whenIdle）。
- turn/step/inbox/follow-up/steer；assistant chunk/message；tool call/result 事件。
- legacy `runAgent()` bridge（一次旧调用 = 一个 step，不必重写 Codex/Claude adapter）。
- provider（codex/claude-code/mock）经 registry 化，去 if/else（报告 §P1-02 provider 选择问题）。
- **provider snapshot/version contract**（报告 §10 阶段 2 交付项）：固化 provider 快照与版本兼容契约 + 对应测试，防 provider 升级静默破坏 replay/resume。
- 输出**可读呈现**：脱敏叙事/摘要、tool card、attachment/spill（报告 §12-P0.5 第二段；传输层脱敏已在阶段 1 落地）。
- all model-visible content replay test（§13.6）。
- golden journey「运行中纠偏」API 级 e2e 转绿（见 §4.1）。
验收：§13.3/§13.6；replay test 绿；纠偏 journey API 级通过。

### 阶段 3：Human-first Session UI（默认对话式工作台）
交付：Workspace picker、Session list、composer、event feed、inline approval、tool/diff/artifact/final-result cards、运行中 follow-up/steer/pause/cancel、断线重连+replay；旧 Dashboard 移到 `/advanced`（保留，不删——C2/C3）。
验收：§13.1/§13.3/§13.4/§13.7/§13.9/§13.10/§13.12（浏览器侧重连与 replay）；Playwright 覆盖主要 journey（§4.1 浏览器级转绿）。

### 阶段 4：Workflow/Gate/Delivery 插件化 + profiles
交付：Workflow 降为可选 governance plugin；Gate/Delivery 订阅事件；Demand Shaping → clarification/plan flow；profiles：human-web / autonomous-delivery / review-only；CLI/Web/Headless 共用同一 Session API。
验收：§13.11；autonomous profile 自举链路 e2e 绿。

### 阶段 5：Harness 互操作 + 旧模型退场（收尾，谨慎）
交付：仅经稳定公开边界的可选 Harness bridge（pin 版本 + adapter contract test，不绑私有 schema）；旧 .tekon 数据 read-only projection/backfill；删长 RPC/未用 poller/旧 factory/重复 DTO；Cockpit 仅留高级审计。
验收：§13.13 全量；全项目全功能 e2e。

## 5. 阶段依赖与并行

- 阶段 0 必须最先（CI 与 contract test 是后续安全网）。
- 阶段 1 是所有后续的地基（event spine + job）。
- 阶段 2 依赖 1；阶段 3 依赖 1、2；阶段 4 依赖 1–3；阶段 5 最后。
- **可并行**：阶段 0 内 "CI 补齐" 与 "contract test 编写" 可并行；每阶段内多文件改动可用 workflow fan-out。
- 报告 §12 立即修复清单中与定位无关的项（P0-03、CI、类型欺骗、Resume、眼睛按钮、RunTable 可读性），**在阶段 0/1 内优先兑现**，不等后续阶段。

## 6. 风险与回滚

- 每阶段独立 commit；任一阶段验收不过则停在该阶段、不进下一阶段（报告 §11"每阶段可运行"）。
- dual-write 不一致风险 → 单一 event append transaction + projection checksum（报告 §11）。
- Harness preview 变化 → 阶段 5 才接触，pin 版本 + anti-corruption layer。
- 范围失控 → 本方案已把"必修工程项"与"replatform 阶段"解耦，前者可独立交付价值。

## 7. 交付节奏建议

阶段 0（修稳 CLI flaky、P1.1–P1.4 纯 UI/控件修复、契约冻结、contract test、CI 补齐）优先落地并可先行验收——这批与定位无关、价值即时、风险最低、不动 core 运行时主路径。阶段 1 起进入 event spine/job 化与 core 运行时修复（P0-01/02/03、类型欺骗、状态机），其后按 2→5 推进，每阶段一个（或数个）阶段性 commit。

## 附注：评审 runtime 限制说明

CLAUDE.md 要求 plan/review 类工作用最高思考等级 subagent。本 runtime 下：general-purpose subagent 运行在 flash 模型、速度不足以承载深度评审；fork subagent 继承主模型（最高等级）但同时继承写权限，会自主改文件而非仅提意见。故本方案评审采用：**fork 一号 reviewer 提出结构化必修项（M1–M4）→ 维护方（主模型，最高等级）整合并做对抗性自检**。后续各阶段的方案评审与 code review 沿用此模式：reviewer 只产出意见清单，由维护方裁定与整合，避免 reviewer 自走执行。若引入可控的只读高等级 reviewer，则优先使用。
